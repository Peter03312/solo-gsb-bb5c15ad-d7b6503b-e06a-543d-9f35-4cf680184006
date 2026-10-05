'use strict';

// 训练任务（单人演练任务）：
// 培训师选定「已发布冻结版本 + 截止时间 + 每人最多尝试次数 + 及格分 + 学员名单」建立任务，
// 取得管理凭证与各学员的独立参与凭证。规则：
//  - 任务绑定 (scenario_id, version) 冻结版本，后续发布新版本不改变本任务的规则与计分；
//  - 学员凭个人参与凭证开始或续做单人演练：同一人有未结束尝试时重复“开始”返回原会话，
//    该尝试结束（到结局）后才消耗下一次名额；
//  - 截止时间之后不能再开新尝试，但此前已开始、尚未结束的尝试仍可继续操作（续做旧会话）；
//  - 任务会话只能凭个人参与凭证查看与操作；普通会话列表 / 查询 / 推进 / 分叉入口一律拒绝
//    （sessions.task_code 标记，见 session.js 与 server.js），不能绕过权限、次数与截止控制；
//  - 培训师凭管理凭证查看各人尝试记录、最高“已结束”尝试总分及是否达到及格分；
//    无已结束尝试时成绩为空（bestScore/passed = null）。
//
// 关键不变量：
//  - task_attempts 的部分唯一索引 (task_code, trainee_id) WHERE status='active'
//    保证同一人至多一条进行中尝试：并发重复“开始”只会有一个 INSERT 成功，
//    其余事务回滚并读取到同一条尝试 → 不会多建会话、不会多扣次数；
//  - 尝试结束（会话推进到结局）与尝试状态更新在同一事务内完成；
//  - 任何校验失败都不创建任何任务/学员/尝试，返回明确错误码。

const crypto = require('crypto');
const { initialMask } = require('./scenario');
const { buildSnapshot, performMove, computeTotalScore } = require('./session');

const NAME_MAX = 100;

function nowMs() {
  return Date.now();
}

function newTaskCode() {
  return crypto.randomBytes(5).toString('hex'); // 10 位任务码
}
function newHostToken() {
  return `tmgr_${crypto.randomBytes(12).toString('hex')}`;
}
function newTraineeToken() {
  return `tmem_${crypto.randomBytes(12).toString('hex')}`;
}
function newSessionCode() {
  return crypto.randomBytes(5).toString('hex'); // 10 位
}

function getTask(db, code) {
  return db.prepare('SELECT * FROM training_tasks WHERE code = ?').get(code);
}

function getTaskContent(db, task) {
  const row = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(task.scenario_id, task.version);
  return row ? JSON.parse(row.content) : null;
}

/**
 * 归一化截止时间。优先接受 deadlineMs（JSON 整数毫秒），其次 deadline（ISO 8601 字符串）。
 * 必须能解析为有效时刻且严格晚于“当前时刻”。返回 { ok, deadlineMs?, errors: [] }。
 */
function normalizeDeadline(body, atMs) {
  const errors = [];
  const hasMs = Object.prototype.hasOwnProperty.call(body || {}, 'deadlineMs');
  const hasStr = Object.prototype.hasOwnProperty.call(body || {}, 'deadline');
  if (!hasMs && !hasStr) {
    return { ok: false, deadlineMs: null, errors: ['缺少截止时间（deadline：ISO 8601 字符串，或 deadlineMs：毫秒时间戳）'] };
  }
  let ms = null;
  if (hasMs) {
    const raw = body.deadlineMs;
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      errors.push(`截止时间戳非法：${JSON.stringify(raw)}（deadlineMs 必须是整数毫秒时间戳）`);
    } else {
      ms = raw;
    }
  }
  if (hasStr) {
    const raw = body.deadline;
    if (typeof raw !== 'string' || !raw.trim()) {
      errors.push(`截止时间非法：${JSON.stringify(raw)}（deadline 必须是非空 ISO 8601 字符串）`);
    } else {
      const parsed = Date.parse(raw);
      if (!Number.isFinite(parsed)) {
        errors.push(`截止时间无法解析：${JSON.stringify(raw)}（需要合法的 ISO 8601 时间字符串）`);
      } else if (ms !== null && parsed !== ms) {
        errors.push('deadline 与 deadlineMs 同时给出但指向不同时刻（只保留一个，或保持两者一致）');
      } else {
        ms = parsed;
      }
    }
  }
  if (ms !== null && ms <= atMs) {
    errors.push(`截止时间必须晚于当前时间：传入 ${new Date(ms).toISOString()}，当前 ${new Date(atMs).toISOString()}`);
  }
  if (errors.length) return { ok: false, deadlineMs: null, errors };
  return { ok: true, deadlineMs: ms, errors: [] };
}

/**
 * 归一化并完整校验建任务配置（任何一项不合法都整次拒绝，不写任何数据）。
 * 入参：{ scenarioId, version, deadline/deadlineMs, maxAttempts, passScore, trainees }
 * 返回 { ok, errors, config }。
 */
function validateTaskConfig(db, body, atMs = nowMs()) {
  const errors = [];
  body = body && typeof body === 'object' ? body : {};

  const { scenarioId } = body;
  if (typeof scenarioId !== 'string' || !scenarioId) {
    errors.push('缺少 scenarioId');
  }
  const sc = scenarioId ? db.prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId) : null;
  if (scenarioId && !sc) errors.push(`情境不存在：${scenarioId}`);
  if (sc && sc.current_version < 1) errors.push('该情境尚未发布，无法建立训练任务');

  // 版本：必须是已发布（已冻结）的版本号；缺省为当前最新发布版
  let version = null;
  if (body.version === undefined || body.version === null) {
    version = sc ? sc.current_version : null;
  } else if (typeof body.version !== 'number' || !Number.isInteger(body.version) || body.version < 1) {
    errors.push(`版本号非法：${JSON.stringify(body.version)}（必须是 ≥1 的已发布版本整数；省略则使用最新发布版）`);
  } else {
    version = body.version;
  }
  if (sc && version !== null) {
    const vrow = db.prepare('SELECT 1 FROM versions WHERE scenario_id = ? AND version = ?').get(sc.id, version);
    if (!vrow) {
      errors.push(`情境「${sc.title}」不存在已冻结版本 v${version}（当前已发布至 v${sc.current_version}）`);
    }
  }

  const dl = normalizeDeadline(body, atMs);
  if (!dl.ok) errors.push(...dl.errors);

  // 每人最多尝试次数：正整数（JSON number；字符串 "2" 不做隐式转换）
  const { maxAttempts } = body;
  if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    errors.push(`每人最多尝试次数非法：${JSON.stringify(maxAttempts)}（必须是正整数）`);
  }

  // 及格分：整数
  const { passScore } = body;
  if (typeof passScore !== 'number' || !Number.isInteger(passScore)) {
    errors.push(`及格分非法：${JSON.stringify(passScore)}（必须是整数）`);
  }

  // 学员名单：非空数组；每项为非空姓名（字符串或 {name}）；去空白后不得重复
  const names = [];
  const rawTrainees = body.trainees;
  if (!Array.isArray(rawTrainees) || rawTrainees.length === 0) {
    errors.push('学员名单不能为空（trainees 必须是非空数组，每项为学员姓名）');
  } else {
    const seen = new Set();
    rawTrainees.forEach((item, i) => {
      const rawName = item && typeof item === 'object' ? item.name : item;
      if (typeof rawName !== 'string' || !rawName.trim()) {
        errors.push(`第 ${i + 1} 个学员姓名为空或非法（必须是非空字符串）`);
        return;
      }
      const name = rawName.trim().slice(0, NAME_MAX);
      if (name.length === 0) {
        errors.push(`第 ${i + 1} 个学员姓名为空白`);
        return;
      }
      if (seen.has(name)) {
        errors.push(`学员姓名重复：「${name}」（名单内姓名不得重复）`);
        return;
      }
      seen.add(name);
      names.push(name);
    });
  }

  if (errors.length) return { ok: false, errors, config: null };
  return {
    ok: true,
    errors: [],
    config: {
      scenarioId: sc.id,
      scenarioTitle: sc.title,
      version,
      deadlineMs: dl.deadlineMs,
      maxAttempts,
      passScore,
      names,
    },
  };
}

/**
 * 建立训练任务。整批校验通过后在单个事务内写入任务与学员；任何错误都不写库。
 * 返回 { ok, status, errorCode, error, errors?, task?, hostToken?, trainees? }。
 */
function createTask(db, body) {
  const checked = validateTaskConfig(db, body);
  if (!checked.ok) {
    return {
      ok: false, status: 400, errorCode: 'TASK_CONFIG_INVALID',
      error: '训练任务配置非法，已整次拒绝（未创建任务、未生成任何凭证）',
      errors: checked.errors,
    };
  }
  const cfg = checked.config;
  const contentRow = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(cfg.scenarioId, cfg.version);
  const content = JSON.parse(contentRow.content);

  // 任务码 / 凭证随机碰撞时极小概率重试
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newTaskCode();
    const hostToken = newHostToken();
    const trainees = cfg.names.map((name) => ({ name, token: newTraineeToken() }));
    try {
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO training_tasks (code, host_token, scenario_id, version, deadline_ms, max_attempts, pass_score)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(code, hostToken, cfg.scenarioId, cfg.version, cfg.deadlineMs, cfg.maxAttempts, cfg.passScore);
        const ins = db.prepare('INSERT INTO task_trainees (task_code, token, name) VALUES (?, ?, ?)');
        for (const t of trainees) ins.run(code, t.token, t.name);
      });
      tx();
      const task = getTask(db, code);
      return { ok: true, task, hostToken, trainees, scenarioTitle: cfg.scenarioTitle, content };
    } catch (e) {
      if (String(e && e.message).includes('UNIQUE')) continue;
      throw e;
    }
  }
  return { ok: false, status: 500, errorCode: 'TASK_CODE_CONFLICT', error: '任务码/凭证生成失败，请重试' };
}

/** 最近任务列表（不含任何凭证）。 */
function listTasks(db) {
  return db.prepare(`
    SELECT t.code, t.scenario_id, s.title AS scenario_title, t.version,
           t.deadline_ms, t.max_attempts, t.pass_score, t.created_at,
           (SELECT COUNT(*) FROM task_trainees x WHERE x.task_code = t.code) AS trainee_count,
           (SELECT COUNT(*) FROM task_attempts a WHERE a.task_code = t.code) AS attempt_count,
           (SELECT COUNT(*) FROM task_attempts a WHERE a.task_code = t.code AND a.status = 'active') AS active_count
      FROM training_tasks t
      JOIN scenarios s ON s.id = t.scenario_id
     ORDER BY t.created_at DESC, t.code LIMIT 100
  `).all();
}

function getTraineeByToken(db, token) {
  if (typeof token !== 'string' || !token) return null;
  return db.prepare('SELECT * FROM task_trainees WHERE token = ?').get(token) || null;
}

function attemptsOf(db, taskCode, traineeId) {
  return db.prepare(`
    SELECT a.*, se.status AS session_status, se.step_no, se.current_node_id, se.path
      FROM task_attempts a
      JOIN sessions se ON se.code = a.session_code
     WHERE a.task_code = ? AND a.trainee_id = ?
     ORDER BY a.attempt_no
  `).all(taskCode, traineeId);
}

function activeAttemptOf(db, taskCode, traineeId) {
  return db.prepare(`
    SELECT * FROM task_attempts
     WHERE task_code = ? AND trainee_id = ? AND status = 'active'
     ORDER BY attempt_no DESC LIMIT 1
  `).get(taskCode, traineeId) || null;
}

/**
 * 计算一次尝试会话的总分（按任务绑定冻结版本的计分规则实时计算）。
 */
function attemptScore(db, task, content, attemptRow) {
  let path = [];
  try { path = JSON.parse(attemptRow.path || '[]'); } catch (_) { path = []; }
  return computeTotalScore(content, path);
}

/** 学员视角的任务信息（凭个人参与凭证）。 */
function buildTraineeView(db, task, trainee, content, scenarioTitle) {
  const attempts = attemptsOf(db, task.code, trainee.id);
  const active = attempts.filter((a) => a.status === 'active').slice(-1)[0] || null;
  const endedRows = attempts.filter((a) => a.status === 'ended');
  let bestScore = null;
  for (const a of endedRows) {
    const score = attemptScore(db, task, content, a);
    if (bestScore === null || score > bestScore) bestScore = score;
  }
  // “已消耗次数”= 已结束尝试数；进行中尝试占用一个名额但尚未消耗（结束才消耗）。
  const endedCount = endedRows.length;
  const used = endedCount + (active ? 1 : 0);
  return {
    code: task.code,
    scenarioId: task.scenario_id,
    scenarioTitle,
    version: task.version,
    deadlineMs: task.deadline_ms,
    deadlineAt: new Date(task.deadline_ms).toISOString(),
    closed: nowMs() > task.deadline_ms,
    maxAttempts: task.max_attempts,
    passScore: task.pass_score,
    trainee: { id: trainee.id, name: trainee.name },
    attemptsUsed: used,
    attemptsLeft: Math.max(0, task.max_attempts - used),
    endedCount,
    activeAttemptNo: active ? active.attempt_no : null,
    bestScore, // 最高“已结束”尝试总分；无已结束尝试时为 null
    passed: bestScore === null ? null : bestScore >= task.pass_score,
    attempts: attempts.map((a) => ({
      attemptNo: a.attempt_no,
      sessionCode: a.session_code,
      status: a.status,
      stepNo: a.step_no,
      totalScore: attemptScore(db, task, content, a),
      startedAt: a.created_at,
      endedAt: a.ended_ms ? new Date(a.ended_ms).toISOString() : null,
    })),
  };
}

/** 凭个人参与凭证取得任务与学员信息（凭证无效返回 401）。 */
function getMyTask(db, token) {
  const trainee = getTraineeByToken(db, token);
  if (!trainee) {
    return { ok: false, status: 401, errorCode: 'TASK_TOKEN_INVALID', error: '参与凭证无效，请核对培训师发放的个人凭证' };
  }
  const task = getTask(db, trainee.task_code);
  if (!task) return { ok: false, status: 500, errorCode: 'TASK_MISSING', error: '任务数据缺失' };
  const content = getTaskContent(db, task);
  if (!content) return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '任务绑定的冻结版本内容缺失' };
  const sc = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(task.scenario_id);
  return { ok: true, task, trainee, content, scenarioTitle: sc ? sc.title : null, view: buildTraineeView(db, task, trainee, content, sc ? sc.title : null) };
}

/**
 * 开始或续做一次单人尝试。
 *  - 已有进行中的尝试：重复开始返回原会话（resumed=true），不新建、不扣次数；
 *  - 无进行中尝试且已过截止时间：拒绝开新尝试（但旧尝试仍可续做）；
 *  - 无进行中尝试且次数耗尽：拒绝；
 *  - 否则创建下一次尝试及其独立会话（冻结版本规则）。
 * 部分唯一索引保证并发重复开始时只有一个事务成功创建，败者回滚后读到同一条进行中尝试。
 */
function startAttempt(db, token, atMs = nowMs()) {
  const mine = getMyTask(db, token);
  if (!mine.ok) return mine;
  const { task, trainee, content, scenarioTitle } = mine;

  const runTx = db.transaction(() => {
    // 事务内重新读取，确保并发判定基于最新数据
    const active = activeAttemptOf(db, task.code, trainee.id);
    if (active) return { kind: 'resume', attempt: active };

    if (atMs > task.deadline_ms) {
      return {
        ok: false, status: 409, errorCode: 'TASK_DEADLINE_PASSED',
        error: `任务截止时间（${new Date(task.deadline_ms).toISOString()}）已过，不能开始新的尝试；已有未结束尝试仍可继续完成`,
      };
    }
    const used = db.prepare('SELECT COUNT(*) AS c FROM task_attempts WHERE task_code = ? AND trainee_id = ?')
      .get(task.code, trainee.id).c;
    if (used >= task.max_attempts) {
      return {
        ok: false, status: 409, errorCode: 'ATTEMPTS_EXHAUSTED',
        error: `尝试次数已用完：本任务每人最多 ${task.max_attempts} 次，你已使用 ${used} 次`,
        used, maxAttempts: task.max_attempts,
      };
    }

    // 极小概率会话码碰撞时循环重试（在同一事务外生成即可，碰撞会抛 UNIQUE 导致整事务回滚）
    let sessionCode;
    for (let i = 0; i < 3; i++) {
      sessionCode = newSessionCode();
      const exists = db.prepare('SELECT 1 FROM sessions WHERE code = ?').get(sessionCode);
      if (!exists) break;
    }
    db.prepare(`
      INSERT INTO sessions (code, scenario_id, version, current_node_id, state_mask, step_no, status,
                            path, trainee_name, root_code, task_code)
      VALUES (?, ?, ?, ?, ?, 0, 'active', '[]', ?, ?, ?)
    `).run(sessionCode, task.scenario_id, task.version, content.startNodeId, initialMask(content),
      trainee.name, sessionCode, task.code);

    const attemptNo = used + 1;
    let attemptId;
    try {
      const info = db.prepare(`
        INSERT INTO task_attempts (task_code, trainee_id, attempt_no, session_code, status, started_ms)
        VALUES (?, ?, ?, ?, 'active', ?)
      `).run(task.code, trainee.id, attemptNo, sessionCode, atMs);
      attemptId = info.lastInsertRowid;
    } catch (e) {
      if (String(e && e.message).includes('UNIQUE')) {
        // 并发重复开始：另一事务已创建进行中尝试（或同号尝试）。本事务回滚，交由外层重读。
        return { kind: 'conflict' };
      }
      throw e;
    }
    const attempt = db.prepare('SELECT * FROM task_attempts WHERE id = ?').get(attemptId);
    return { kind: 'created', attempt, sessionCode, attemptNo };
  });

  let outcome;
  try {
    outcome = runTx();
  } catch (e) {
    if (String(e && e.message).includes('UNIQUE')) {
      outcome = { kind: 'conflict' };
    } else {
      throw e;
    }
  }

  // 与并发请求相遇：重读进行中尝试并返回它（不新建、不扣次数）
  if (outcome.kind === 'conflict') {
    const active = activeAttemptOf(db, task.code, trainee.id);
    if (active) outcome = { kind: 'resume', attempt: active };
    else {
      // 极端情况下冲突来自 (task,trainee,attempt_no) 唯一而非进行中唯一：退化为次数耗尽提示
      return {
        ok: false, status: 409, errorCode: 'ATTEMPTS_EXHAUSTED',
        error: '尝试名额刚被并发请求占用，请刷新后重试',
      };
    }
  }
  if (outcome.ok === false) {
    return { ...outcome, view: buildTraineeView(db, task, trainee, content, scenarioTitle) };
  }

  const created = outcome.kind === 'created';
  const session = db.prepare('SELECT * FROM sessions WHERE code = ?').get(outcome.attempt.session_code);
  const snapshot = buildSnapshot(content, session, task.scenario_id, task.version);
  return {
    ok: true,
    created, // true=本次新建尝试；false=返回已有进行中尝试（重复开始）
    resumed: !created,
    attemptNo: outcome.attempt.attempt_no,
    sessionCode: outcome.attempt.session_code,
    snapshot,
    view: buildTraineeView(db, task, trainee, content, scenarioTitle),
  };
}

/** 读取某学员某次尝试的会话快照（attemptNo 省略时取进行中的尝试）。 */
function getAttempt(db, token, attemptNo) {
  const mine = getMyTask(db, token);
  if (!mine.ok) return mine;
  const { task, trainee, content, scenarioTitle } = mine;

  let attempt;
  if (attemptNo === undefined || attemptNo === null) {
    attempt = activeAttemptOf(db, task.code, trainee.id);
    if (!attempt) {
      return {
        ok: false, status: 404, errorCode: 'ACTIVE_ATTEMPT_NOT_FOUND',
        error: '你当前没有进行中的尝试；若次数未用完且未到截止时间，可开始新的尝试',
        view: buildTraineeView(db, task, trainee, content, scenarioTitle),
      };
    }
  } else {
    if (!Number.isInteger(attemptNo) || attemptNo < 1) {
      return { ok: false, status: 400, errorCode: 'ATTEMPT_NO_INVALID', error: 'attemptNo 必须是 ≥1 的整数' };
    }
    attempt = db.prepare('SELECT * FROM task_attempts WHERE task_code = ? AND trainee_id = ? AND attempt_no = ?')
      .get(task.code, trainee.id, attemptNo);
    if (!attempt) {
      return {
        ok: false, status: 404, errorCode: 'ATTEMPT_NOT_FOUND',
        error: `你没有第 ${attemptNo} 次尝试`,
        view: buildTraineeView(db, task, trainee, content, scenarioTitle),
      };
    }
  }
  const session = db.prepare('SELECT * FROM sessions WHERE code = ?').get(attempt.session_code);
  if (!session) return { ok: false, status: 500, errorCode: 'SESSION_MISSING', error: '尝试会话缺失' };
  const snapshot = buildSnapshot(content, session, task.scenario_id, task.version);
  return {
    ok: true,
    attemptNo: attempt.attempt_no,
    attemptStatus: attempt.status,
    snapshot,
    view: buildTraineeView(db, task, trainee, content, scenarioTitle),
  };
}

/**
 * 学员在某次尝试中执行一步。截止后仍允许续做旧会话；步号/条件/选项等校验完全沿用
 * 冻结版本规则（performMove）。推进到结局时在同一事务内把尝试置为 ended（消耗一次名额）。
 */
function moveAttempt(db, { token, attemptNo, optionId, stepNo }) {
  const mine = getMyTask(db, token);
  if (!mine.ok) return mine;
  const { task, trainee, content, scenarioTitle } = mine;
  const failView = () => buildTraineeView(db, task, trainee, content, scenarioTitle);

  if (!Number.isInteger(attemptNo) || attemptNo < 1) {
    return { ok: false, status: 400, errorCode: 'ATTEMPT_NO_INVALID', error: 'attemptNo 必须是 ≥1 的整数', view: failView() };
  }
  const attempt = db.prepare('SELECT * FROM task_attempts WHERE task_code = ? AND trainee_id = ? AND attempt_no = ?')
    .get(task.code, trainee.id, attemptNo);
  if (!attempt) {
    return { ok: false, status: 404, errorCode: 'ATTEMPT_NOT_FOUND', error: `你没有第 ${attemptNo} 次尝试`, view: failView() };
  }

  let result;
  const tx = db.transaction(() => {
    const move = performMove(db, {
      code: attempt.session_code,
      optionId,
      stepNo,
      traineeName: trainee.name,
      allowTaskSession: true,
    });
    if (!move.ok) return move;
    if (move.session.status === 'ended') {
      db.prepare(`
        UPDATE task_attempts SET status = 'ended', ended_ms = ?, updated_at = datetime('now') WHERE id = ?
      `).run(nowMs(), attempt.id);
    }
    return move;
  });
  result = tx();

  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      errorCode: result.errorCode,
      error: result.error,
      current: result.current || null,
      view: failView(),
    };
  }

  const updated = db.prepare('SELECT * FROM sessions WHERE code = ?').get(attempt.session_code);
  const snapshot = buildSnapshot(result.content, updated, task.scenario_id, task.version);
  const last = snapshot.path.find((p) => p.step === updated.step_no) || null;
  return {
    ok: true,
    attemptNo,
    ended: updated.status === 'ended',
    snapshot,
    lastMove: last ? {
      step: last.step,
      optionId: last.optionId,
      optionLabel: last.optionLabel,
      score: last.score,
      scoreNote: last.scoreNote,
      totalScore: snapshot.totalScore,
    } : null,
    view: failView(),
  };
}

/**
 * 培训师管理视图：凭管理凭证查看任务配置、学员名单与每人尝试记录、
 * 最高已结束总分及是否达到及格分（无已结束尝试时 bestScore/passed 为 null）。
 */
function getTaskReport(db, { code, hostToken }) {
  const task = getTask(db, code);
  if (!task) return { ok: false, status: 404, errorCode: 'TASK_NOT_FOUND', error: '训练任务不存在' };
  if (task.host_token !== hostToken) {
    return { ok: false, status: 401, errorCode: 'TASK_HOST_TOKEN_INVALID', error: '管理凭证无效' };
  }
  const content = getTaskContent(db, task);
  if (!content) return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '任务绑定的冻结版本内容缺失' };
  const sc = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(task.scenario_id);

  const trainees = db.prepare('SELECT * FROM task_trainees WHERE task_code = ? ORDER BY id').all(task.code);
  const rows = trainees.map((tr) => {
    const attempts = attemptsOf(db, task.code, tr.id);
    const activeRaw = attempts.filter((a) => a.status === 'active').slice(-1)[0] || null;
    const endedRows = attempts.filter((a) => a.status === 'ended');
    let bestScore = null;
    for (const a of endedRows) {
      const score = attemptScore(db, task, content, a);
      if (bestScore === null || score > bestScore) bestScore = score;
    }
    const used = endedRows.length + (activeRaw ? 1 : 0);
    return {
      traineeId: tr.id,
      name: tr.name,
      attemptsUsed: used,
      attemptsLeft: Math.max(0, task.max_attempts - used),
      activeAttemptNo: activeRaw ? activeRaw.attempt_no : null,
      bestScore,
      passed: bestScore === null ? null : bestScore >= task.pass_score,
      attempts: attempts.map((a) => ({
        attemptNo: a.attempt_no,
        sessionCode: a.session_code,
        status: a.status,
        stepNo: a.step_no,
        currentNodeId: a.current_node_id,
        totalScore: attemptScore(db, task, content, a),
        startedAt: a.created_at,
        startedMs: a.started_ms,
        endedAt: a.ended_ms ? new Date(a.ended_ms).toISOString() : null,
      })),
    };
  });

  return {
    ok: true,
    report: {
      code: task.code,
      scenarioId: task.scenario_id,
      scenarioTitle: sc ? sc.title : null,
      version: task.version,
      deadlineMs: task.deadline_ms,
      deadlineAt: new Date(task.deadline_ms).toISOString(),
      closed: nowMs() > task.deadline_ms,
      maxAttempts: task.max_attempts,
      passScore: task.pass_score,
      createdAt: task.created_at,
      traineeCount: trainees.length,
      trainees: rows,
    },
  };
}

module.exports = {
  createTask,
  listTasks,
  getMyTask,
  startAttempt,
  getAttempt,
  moveAttempt,
  getTaskReport,
  validateTaskConfig,
  NAME_MAX,
};
