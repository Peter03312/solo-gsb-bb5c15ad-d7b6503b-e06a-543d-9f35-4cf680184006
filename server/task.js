'use strict';

// 训练任务：培训师选定「已发布冻结版本 + 截止时间 + 每人最多尝试次数 + 及格分 + 学员名单」
// 建立训练任务，获得管理凭证；每名学员获得独立参与凭证。
//
// 规则：
//  - 配置非法（截止时间不晚于当前、次数非正整数、及格分非整数、名单为空或姓名重复）
//    整次拒绝，不写入任何数据；
//  - 任务绑定 (scenario_id, version) 冻结版本：后续发布新版本不改变本任务的
//    选项条件、步号与计分规则；
//  - 学员凭个人凭证开始或续做单人演练：同一人有未结束尝试时，重复开始返回原会话
//    （不多建会话、不消耗次数）；当前尝试结束后才开始下一次并消耗次数；
//  - 截止后不能开新尝试，但可续做未结束的旧会话；
//  - 任务会话只能凭本人参与凭证查看和操作；普通会话列表与单人入口不得绕过权限与次数
//    （见 server.js 对 /api/sessions 的守卫）；
//  - 培训师凭管理凭证查看各人尝试记录、最高已结束总分与是否达到及格分；
//    无已结束尝试时成绩为空（bestScore=null, passed=null）。

const crypto = require('crypto');
const { initialMask } = require('./scenario');
const { buildSnapshot, performMove, computeTotalScore } = require('./session');
const { newSessionCode } = require('./db');

function nowMs() {
  return Date.now();
}

function newTaskId() {
  return crypto.randomBytes(5).toString('hex'); // 10 位任务编号
}
function newAdminToken() {
  return `adm_${crypto.randomBytes(12).toString('hex')}`; // 管理凭证
}
function newTraineeToken() {
  return `ptk_${crypto.randomBytes(12).toString('hex')}`; // 个人参与凭证
}

function getTask(db, id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function getTaskContent(db, task) {
  const row = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(task.scenario_id, task.version);
  return row ? JSON.parse(row.content) : null;
}

function findTrainee(db, taskId, token) {
  if (typeof token !== 'string' || !token) return null;
  return db.prepare('SELECT * FROM task_trainees WHERE task_id = ? AND token = ?').get(taskId, token) || null;
}

// 任务公开元信息（不含任何凭证与成绩）
function publicMeta(db, task, atMs = nowMs()) {
  const sc = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(task.scenario_id);
  const traineeCount = db.prepare('SELECT COUNT(*) AS c FROM task_trainees WHERE task_id = ?').get(task.id).c;
  return {
    id: task.id,
    scenarioId: task.scenario_id,
    scenarioTitle: sc ? sc.title : null,
    version: task.version,
    deadlineMs: task.deadline_ms,
    deadlineAt: new Date(task.deadline_ms).toISOString(),
    expired: atMs > task.deadline_ms, // 已截止：不能开新尝试，可续做旧会话
    maxAttempts: task.max_attempts,
    passScore: task.pass_score,
    traineeCount,
    createdAt: task.created_at,
    serverNowMs: atMs,
  };
}

// 某学员在任务下的全部尝试会话（按次数升序）
function attemptsOf(db, taskId, traineeId) {
  return db.prepare(`
    SELECT * FROM sessions WHERE task_id = ? AND task_trainee_id = ?
     ORDER BY attempt_no, created_at, code
  `).all(taskId, traineeId);
}

function attemptView(content, s) {
  let totalScore = 0;
  try { totalScore = computeTotalScore(content, JSON.parse(s.path || '[]')); } catch (_) { totalScore = 0; }
  return {
    attemptNo: s.attempt_no,
    sessionCode: s.code,
    status: s.status, // active=进行中（未消耗下一次机会） / ended=已结束
    stepNo: s.step_no,
    totalScore, // 进行中为当前累计分；已结束为最终总分
    startedAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

/**
 * 建立训练任务（培训师）。任何一项配置非法都整次拒绝（不写库）。
 *  - scenarioId 必须存在且已发布；version 缺省为当前最新发布版，必须是已冻结版本；
 *  - deadline：epoch 毫秒（数字）或 ISO-8601 时间串，必须晚于当前时间；
 *  - maxAttempts：正整数；passScore：整数；
 *  - trainees：非空姓名数组，姓名去空白后非空、≤100 字且不重复。
 * 成功返回 { ok, task, adminToken, trainees:[{name, token}] }。
 */
function createTask(db, { scenarioId, version, deadline, maxAttempts, passScore, trainees }) {
  const sc = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId);
  if (!sc) return { ok: false, status: 404, errorCode: 'SCENARIO_NOT_FOUND', error: '情境不存在' };
  if (sc.current_version < 1) {
    return { ok: false, status: 400, errorCode: 'VERSION_NOT_PUBLISHED', error: '该情境尚未发布，无法建立训练任务' };
  }
  const v = version === undefined || version === null ? sc.current_version : Number(version);
  if (!Number.isInteger(v) || v < 1) {
    return { ok: false, status: 400, errorCode: 'VERSION_INVALID', error: `版本号非法：${JSON.stringify(version)}（必须为 ≥1 的整数）` };
  }
  const versionRow = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?').get(sc.id, v);
  if (!versionRow) {
    return { ok: false, status: 404, errorCode: 'VERSION_NOT_FOUND', error: `情境「${sc.title}」不存在已冻结版本 v${v}（当前已发布至 v${sc.current_version}）` };
  }

  // 截止时间：数字（epoch 毫秒）或 ISO-8601 字符串；必须晚于当前时间
  let deadlineMs = null;
  if (typeof deadline === 'number' && Number.isFinite(deadline)) {
    deadlineMs = Math.trunc(deadline);
  } else if (typeof deadline === 'string' && deadline.trim()) {
    const parsed = Date.parse(deadline.trim());
    if (Number.isFinite(parsed)) deadlineMs = parsed;
  }
  if (deadlineMs === null) {
    return { ok: false, status: 400, errorCode: 'TASK_DEADLINE_INVALID',
      error: `截止时间非法：${JSON.stringify(deadline)}（请给 epoch 毫秒或 ISO-8601 时间串，且须晚于当前时间）` };
  }
  if (deadlineMs <= nowMs()) {
    return { ok: false, status: 400, errorCode: 'TASK_DEADLINE_INVALID',
      error: `截止时间必须晚于当前时间（收到 ${new Date(deadlineMs).toISOString()}），未建立任务` };
  }

  // 每人最多尝试次数：正整数
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    return { ok: false, status: 400, errorCode: 'TASK_MAX_ATTEMPTS_INVALID',
      error: `每人最多尝试次数非法：${JSON.stringify(maxAttempts)}（必须为正整数），未建立任务` };
  }
  // 及格分：整数（按各人最高已结束总分判定是否达到）
  if (!Number.isInteger(passScore)) {
    return { ok: false, status: 400, errorCode: 'TASK_PASS_SCORE_INVALID',
      error: `及格分非法：${JSON.stringify(passScore)}（必须为整数），未建立任务` };
  }

  // 学员名单：非空、姓名去空白后非空且 ≤100 字、不重复
  if (!Array.isArray(trainees) || trainees.length === 0) {
    return { ok: false, status: 400, errorCode: 'TASK_TRAINEES_INVALID',
      error: '学员名单不能为空：请给出至少 1 名学员（trainees 为非空姓名数组），未建立任务' };
  }
  const names = [];
  const seen = new Set();
  for (let i = 0; i < trainees.length; i++) {
    const raw = trainees[i];
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, status: 400, errorCode: 'TASK_TRAINEES_INVALID',
        error: `学员名单第 ${i + 1} 项非法：${JSON.stringify(raw)}（姓名必须为非空文本），未建立任务` };
    }
    const name = raw.trim();
    if (name.length > 100) {
      return { ok: false, status: 400, errorCode: 'TASK_TRAINEES_INVALID',
        error: `学员「${name.slice(0, 20)}…」姓名超长（最多 100 字），未建立任务` };
    }
    if (seen.has(name)) {
      return { ok: false, status: 400, errorCode: 'TASK_TRAINEE_DUPLICATE',
        error: `学员名单姓名重复：「${name}」出现多次，未建立任务` };
    }
    seen.add(name);
    names.push(name);
  }

  // 任务编号 / 凭证随机碰撞时极小概率重试；任务与名单在同一事务写入，非法配置整次拒绝
  for (let attempt = 0; attempt < 3; attempt++) {
    const taskId = newTaskId();
    const adminToken = newAdminToken();
    const tokens = names.map(() => newTraineeToken());
    try {
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO tasks (id, admin_token, scenario_id, version, deadline_ms, max_attempts, pass_score)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(taskId, adminToken, sc.id, v, deadlineMs, maxAttempts, passScore);
        const ins = db.prepare('INSERT INTO task_trainees (task_id, name, token) VALUES (?, ?, ?)');
        names.forEach((name, i) => ins.run(taskId, name, tokens[i]));
      });
      tx();
      const task = getTask(db, taskId);
      return {
        ok: true,
        task,
        adminToken,
        trainees: names.map((name, i) => ({ name, token: tokens[i] })),
        scenarioTitle: sc.title,
      };
    } catch (e) {
      if (String(e && e.message).includes('UNIQUE')) continue;
      throw e;
    }
  }
  return { ok: false, status: 500, errorCode: 'TASK_ID_CONFLICT', error: '任务编号生成失败，请重试' };
}

/** 最近任务列表（元信息；不含任何凭证与成绩）。 */
function listTasks(db, atMs = nowMs()) {
  const rows = db.prepare(`
    SELECT t.id, t.scenario_id, s.title AS scenario_title, t.version, t.deadline_ms,
           t.max_attempts, t.pass_score, t.created_at,
           (SELECT COUNT(*) FROM task_trainees tt WHERE tt.task_id = t.id) AS trainee_count,
           (SELECT COUNT(*) FROM sessions se WHERE se.task_id = t.id) AS attempt_count
      FROM tasks t JOIN scenarios s ON s.id = t.scenario_id
     ORDER BY t.created_at DESC, t.id LIMIT 100
  `).all();
  return rows.map((r) => ({ ...r, expired: atMs > r.deadline_ms }));
}

/**
 * 学员凭个人参与凭证开始或续做单人演练。
 *  - 有未结束尝试：直接返回原会话（resumed=true，不新建会话、不消耗次数；截止后也可续做）；
 *  - 无未结束尝试：次数已用完 → TASK_ATTEMPTS_EXHAUSTED；已过截止 → TASK_DEADLINE_PASSED；
 *    否则新建一次尝试会话（消耗一次），绑定任务冻结版本；
 *  - 检查与新建在同一事务内完成，且有「同一人至多一条进行中会话」的唯一索引兜底：
 *    并发/重复开始绝不多建会话、不多扣次数。
 */
function startAttempt(db, { taskId, token }) {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, status: 404, errorCode: 'TASK_NOT_FOUND', error: '训练任务不存在，请核对任务编号' };
  const trainee = findTrainee(db, taskId, token);
  if (!trainee) {
    return { ok: false, status: 401, errorCode: 'TASK_TOKEN_INVALID', error: '参与凭证无效，请核对本人凭证（未开始任何尝试）' };
  }
  const content = getTaskContent(db, task);
  if (!content) {
    return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '任务绑定的冻结版本内容缺失' };
  }

  let outcome;
  try {
    const tx = db.transaction(() => {
      const active = db.prepare(`
        SELECT * FROM sessions WHERE task_id = ? AND task_trainee_id = ? AND status = 'active'
      `).get(task.id, trainee.id);
      if (active) return { ok: true, resumed: true, session: active };

      const used = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE task_id = ? AND task_trainee_id = ?')
        .get(task.id, trainee.id).c;
      if (used >= task.max_attempts) {
        return { ok: false, status: 409, errorCode: 'TASK_ATTEMPTS_EXHAUSTED',
          error: `你的 ${task.max_attempts} 次尝试次数已用完，不能再开始新的尝试（未新建会话）`, attemptsUsed: used };
      }
      if (nowMs() > task.deadline_ms) {
        return { ok: false, status: 409, errorCode: 'TASK_DEADLINE_PASSED',
          error: `任务已于 ${new Date(task.deadline_ms).toISOString()} 截止，不能再开始新的尝试（未结束的旧尝试仍可续做）`, attemptsUsed: used };
      }

      const code = newSessionCode();
      db.prepare(`
        INSERT INTO sessions (code, scenario_id, version, current_node_id, state_mask, step_no, status,
                              path, trainee_name, root_code, task_id, task_trainee_id, attempt_no)
        VALUES (?, ?, ?, ?, ?, 0, 'active', '[]', ?, ?, ?, ?, ?)
      `).run(code, task.scenario_id, task.version, content.startNodeId, initialMask(content),
        trainee.name, code, task.id, trainee.id, used + 1);
      const session = db.prepare('SELECT * FROM sessions WHERE code = ?').get(code);
      return { ok: true, resumed: false, session };
    });
    outcome = tx();
  } catch (e) {
    if (String(e && e.message).includes('UNIQUE')) {
      // 与并发开始相遇：唯一索引保证至多一条进行中会话；直接返回已存在的那条，不多扣次数
      const active = db.prepare(`
        SELECT * FROM sessions WHERE task_id = ? AND task_trainee_id = ? AND status = 'active'
      `).get(task.id, trainee.id);
      if (active) outcome = { ok: true, resumed: true, session: active };
      else throw e;
    } else {
      throw e;
    }
  }
  if (!outcome.ok) return { ...outcome, task: publicMeta(db, task), traineeName: trainee.name };

  const used = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE task_id = ? AND task_trainee_id = ?')
    .get(task.id, trainee.id).c;
  const snapshot = buildSnapshot(content, outcome.session, task.scenario_id, task.version);
  return {
    ok: true,
    resumed: outcome.resumed,
    task: publicMeta(db, task),
    traineeName: trainee.name,
    attemptNo: outcome.session.attempt_no,
    maxAttempts: task.max_attempts,
    attemptsUsed: used,
    attemptsLeft: Math.max(0, task.max_attempts - used),
    session: snapshot,
  };
}

/** 学员视角：我的任务现状（全部尝试记录 + 进行中的会话快照）。 */
function getMine(db, { taskId, token }) {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, status: 404, errorCode: 'TASK_NOT_FOUND', error: '训练任务不存在，请核对任务编号' };
  const trainee = findTrainee(db, taskId, token);
  if (!trainee) {
    return { ok: false, status: 401, errorCode: 'TASK_TOKEN_INVALID', error: '参与凭证无效，请核对本人凭证' };
  }
  const content = getTaskContent(db, task);
  if (!content) {
    return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '任务绑定的冻结版本内容缺失' };
  }
  const attempts = attemptsOf(db, task.id, trainee.id);
  const active = attempts.find((s) => s.status === 'active') || null;
  return {
    ok: true,
    task: publicMeta(db, task),
    traineeName: trainee.name,
    maxAttempts: task.max_attempts,
    attemptsUsed: attempts.length,
    attemptsLeft: Math.max(0, task.max_attempts - attempts.length),
    attempts: attempts.map((s) => attemptView(content, s)),
    active: active ? buildSnapshot(content, active, task.scenario_id, task.version) : null,
  };
}

/**
 * 学员在任务会话中执行一步选择：{ token, optionId, stepNo }。
 * 只能操作本人“进行中”的那次尝试；推进规则（选项条件、步号、计分）完全沿用冻结版本。
 */
function taskMove(db, { taskId, token, optionId, stepNo }) {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, status: 404, errorCode: 'TASK_NOT_FOUND', error: '训练任务不存在，请核对任务编号' };
  const trainee = findTrainee(db, taskId, token);
  if (!trainee) {
    return { ok: false, status: 401, errorCode: 'TASK_TOKEN_INVALID', error: '参与凭证无效，请核对本人凭证（未推进）' };
  }
  const active = db.prepare(`
    SELECT * FROM sessions WHERE task_id = ? AND task_trainee_id = ? AND status = 'active'
  `).get(task.id, trainee.id);
  if (!active) {
    return { ok: false, status: 409, errorCode: 'TASK_NO_ACTIVE_ATTEMPT',
      error: '当前没有进行中的尝试：请先开始新尝试（或你的尝试已全部结束），未推进' };
  }
  const result = performMove(db, { code: active.code, optionId, stepNo, taskToken: token });
  if (!result.ok) return result;
  const used = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE task_id = ? AND task_trainee_id = ?')
    .get(task.id, trainee.id).c;
  return {
    ok: true,
    session: result.session,
    content: result.content,
    task,
    attemptNo: result.session.attempt_no,
    attemptsUsed: used,
    attemptsLeft: Math.max(0, task.max_attempts - used),
  };
}

/**
 * 培训师凭管理凭证查看成绩报告：各人尝试记录、最高已结束总分、是否达到及格分。
 * 无已结束尝试时成绩为空（bestScore=null，passed=null）。
 */
function manageReport(db, { taskId, adminToken }) {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, status: 404, errorCode: 'TASK_NOT_FOUND', error: '训练任务不存在，请核对任务编号' };
  if (typeof adminToken !== 'string' || task.admin_token !== adminToken) {
    return { ok: false, status: 401, errorCode: 'TASK_ADMIN_TOKEN_INVALID', error: '管理凭证无效（未返回任何成绩）' };
  }
  const content = getTaskContent(db, task);
  if (!content) {
    return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '任务绑定的冻结版本内容缺失' };
  }

  const trainees = db.prepare('SELECT * FROM task_trainees WHERE task_id = ? ORDER BY id').all(task.id);
  const views = trainees.map((t) => {
    const attempts = attemptsOf(db, task.id, t.id).map((s) => attemptView(content, s));
    const endedScores = attempts.filter((a) => a.status === 'ended').map((a) => a.totalScore);
    const bestScore = endedScores.length ? Math.max(...endedScores) : null; // 最高已结束总分；无已结束尝试为空
    const active = attempts.find((a) => a.status === 'active') || null;
    return {
      name: t.name,
      token: t.token, // 管理凭证保护下回显参与凭证，便于培训师补发
      attemptsUsed: attempts.length,
      attemptsLeft: Math.max(0, task.max_attempts - attempts.length),
      activeAttemptNo: active ? active.attemptNo : null,
      bestScore,
      passed: bestScore === null ? null : bestScore >= task.pass_score,
      attempts,
    };
  });

  return {
    ok: true,
    task: publicMeta(db, task),
    summary: {
      traineeCount: trainees.length,
      startedCount: views.filter((v) => v.attemptsUsed > 0).length,
      passedCount: views.filter((v) => v.passed === true).length,
      attemptsTotal: views.reduce((sum, v) => sum + v.attemptsUsed, 0),
    },
    trainees: views,
  };
}

module.exports = {
  createTask,
  listTasks,
  getTask,
  publicMeta,
  startAttempt,
  getMine,
  taskMove,
  manageReport,
};
