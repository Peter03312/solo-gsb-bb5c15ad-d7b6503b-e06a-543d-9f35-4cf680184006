'use strict';

// 共识演练房间：培训师选定已发布冻结版本开启房间，学员凭加入码取得成员凭证后
// 对当前步的可选处置投票（结算前可改票，每人每步只计最后一票），主持人携所见步号
// 结算，票数最多的选项推进同一条共享会话路径（同票按冻结版本的选项编排顺序）。
//
// 限时模式（step_duration 非空，单位秒，30..3600）：
//  - 每一步“开始时”即在 room_steps 持久写入本步截止时间（epoch 毫秒），页面据此展示
//    截止时间与剩余时间；
//  - 截止前：学员可投票/改票，主持人可提前结算（manual）；
//  - 到点后：本步不再接受新票/改票；有票则沿用既有多数决、同票顺序、路径推进与计分
//    规则自动结算（auto），并从“实际推进时刻”为下一步计完整时长；
//  - 到点零票：不推进，停在本步并标记 awaiting_reopen，主持人可凭凭证 + 所见步号
//    重开完整时长；
//  - 无人访问 / 服务重启：启动时与运行中定时“补办”到期处理（sweepDueRooms），
//    处理纯由持久化的截止时间驱动，与在线与否无关。
//
// 关键不变量：
//  - 房间绑定 (scenario_id, version) 冻结版本，后续发布新版本不改变本场规则；
//  - 房间会话（sessions.room_code 非空）不得经单人选择入口推进（见 session.performMove）；
//  - 投票 / 结算 / 自动到期 / 重开全部在事务内按“当前步号 + room_steps 状态”乐观校验，
//    room_settlements 的 (房间, 步号) 唯一约束兜底，任何交错都不可能重复推进；
//  - 任何校验失败都不改变票数、路径与得分，并返回原因及当前步号。

const crypto = require('crypto');
const { initialMask, optionAvailable } = require('./scenario');
const { nodesById, buildSnapshot, performMove } = require('./session');

const MIN_STEP_SECONDS = 30;
const MAX_STEP_SECONDS = 3600;

function nowMs() {
  return Date.now();
}

function newRoomCode() {
  return crypto.randomBytes(5).toString('hex'); // 10 位，即学员加入码
}
function newHostToken() {
  return `host_${crypto.randomBytes(12).toString('hex')}`;
}
function newMemberToken() {
  return `mem_${crypto.randomBytes(12).toString('hex')}`;
}

function getRoom(db, code) {
  return db.prepare('SELECT * FROM rooms WHERE code = ?').get(code);
}

function getRoomSession(db, room) {
  return db.prepare('SELECT * FROM sessions WHERE code = ?').get(room.session_code);
}

function getRoomContent(db, room) {
  const row = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(room.scenario_id, room.version);
  return row ? JSON.parse(row.content) : null;
}

// 归一化限时参数：缺省/ null → 不限时（旧用法）；整数且 30..3600 → 限时秒数；其余报错。
// 只接受 JSON number（字符串如 "60" 一律拒绝，避免隐式转换带来的歧义）。
function normalizeStepDuration(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, seconds: null };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < MIN_STEP_SECONDS || raw > MAX_STEP_SECONDS) {
    return {
      ok: false,
      error: `每步时长非法：${JSON.stringify(raw)}（必须是 ${MIN_STEP_SECONDS}..${MAX_STEP_SECONDS} 秒之间的整数；省略该字段为不限时的旧用法）`,
    };
  }
  return { ok: true, seconds: raw };
}

function isTimed(room) {
  return Number.isInteger(room.step_duration) && room.step_duration > 0;
}

function isBlind(room) {
  return room.blind_vote === 1;
}

// 归一化盲投参数：仅接受 JSON 布尔值。
//  - 未指定（字段缺省）→ false：维持现有公开投票规则（旧用法），存量房间同样为 false；
//  - true / false → 按布尔值开房；
//  - 其余任何类型（null、字符串、数字等）一律报错且不建房，不做隐式转换。
// 盲投选择创建后不可更改（房间没有任何修改该标记的入口）。
function normalizeBlind(raw) {
  if (raw === undefined) return { ok: true, blind: false };
  if (typeof raw !== 'boolean') {
    return {
      ok: false,
      error: `盲投参数非法：${JSON.stringify(raw)}（blind 必须是布尔值 true/false；省略该字段为公开投票的旧用法）`,
    };
  }
  return { ok: true, blind: raw };
}

// 当前步的票数聚合（optionId -> 票数）
function currentTallies(db, roomCode, stepNo) {
  const rows = db.prepare(`
    SELECT option_id, COUNT(*) AS c FROM room_votes
     WHERE room_code = ? AND step_no = ? GROUP BY option_id
  `).all(roomCode, stepNo);
  return new Map(rows.map((r) => [r.option_id, r.c]));
}

function getStepRow(db, roomCode, stepNo) {
  return db.prepare('SELECT * FROM room_steps WHERE room_code = ? AND step_no = ?')
    .get(roomCode, stepNo);
}

// 为某一步开始计时（限时房间专用）。insertMode:
//  - 'insert'：步号首次出现（第 0 步 / 刚推进出的新步），步号已存在则冲突报错；
//  - 'reopen'：零票暂停后主持人重开同一当前步，只刷新截止时间与状态。
function startStepTimer(db, room, stepNo, atMs, insertMode) {
  const deadline = atMs + room.step_duration * 1000;
  if (insertMode === 'reopen') {
    db.prepare(`
      UPDATE room_steps
         SET deadline_ms = ?, opened_at_ms = ?, status = 'open',
             reopened_count = reopened_count + 1
       WHERE room_code = ? AND step_no = ?
    `).run(deadline, atMs, room.code, stepNo);
  } else {
    db.prepare(`
      INSERT INTO room_steps (room_code, step_no, deadline_ms, opened_at_ms, status, reopened_count)
      VALUES (?, ?, ?, ?, 'open', 0)
    `).run(room.code, stepNo, deadline, atMs);
  }
  return deadline;
}

/**
 * 从“当前步已有投票”推进共享会话并留痕（必须在事务内调用，调用方已完成步号/选项校验）。
 * 严格按冻结版本的选项编排顺序扫描、严格大于才替换 → 同票时编排在前者胜出。
 * kind: 'manual'（主持人结算）/ 'auto'（到点自动结算）。
 * 推进成功后，若房间为限时模式且下一步仍是可选择节点，则从实际推进时刻为下一步计满时长。
 * 返回 { ok, status?, errorCode?, error?, settledStepNo?, winner?, tallies?, voterCount? }。
 */
function advanceFromWinner(db, room, content, session, kind) {
  const node = nodesById(content).get(session.current_node_id);
  if (!node || node.isEnd) {
    return { ok: false, status: 409, errorCode: 'NODE_NOT_CHOOSABLE', error: '当前步不是可结算节点' };
  }
  const talliesMap = currentTallies(db, room.code, session.step_no);
  const voterCount = [...talliesMap.values()].reduce((a, b) => a + b, 0);
  if (voterCount === 0) {
    return { ok: false, status: 409, errorCode: 'NO_VOTES', error: '当前步还没有任何投票，不能结算' };
  }
  const eligible = node.options.filter((o) => optionAvailable(o, session.state_mask, content));
  const tallies = eligible.map((o) => ({
    optionId: o.id, optionLabel: o.label, votes: talliesMap.get(o.id) || 0,
  }));
  let winner = null;
  for (const t of tallies) {
    if (!winner || t.votes > winner.votes) winner = t;
  }
  if (!winner || winner.votes === 0) {
    // 理论上不会发生（投票接口只接受可选项），兜底防呆
    return { ok: false, status: 409, errorCode: 'NO_VOTES', error: '当前步没有落在可选项上的投票，不能结算' };
  }

  const settledStepNo = session.step_no;
  // 推进共享会话（房间结算内部通道，绕过单人入口限制；步号/条件在 performMove 内再次校验）
  const move = performMove(db, {
    code: session.code,
    optionId: winner.optionId,
    stepNo: settledStepNo,
    allowRoomSession: true,
  });
  if (!move.ok) {
    return { ok: false, status: 500, errorCode: 'SETTLE_FAILED', error: `结算推进失败：${move.error}` };
  }

  // 结算留痕；(room_code, step_no) 主键保证同一步不可能被结算两次
  // （自动结算与主持人结算相遇时，第二个 INSERT 抛 UNIQUE，事务回滚 → STEP_STALE）。
  db.prepare(`
    INSERT INTO room_settlements (room_code, step_no, option_id, tallies, voter_count, kind)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(room.code, settledStepNo, winner.optionId, JSON.stringify(tallies), voterCount, kind);

  // 限时房间：从实际推进时刻为下一步计满时长（若下一步到达结局则不计时）。
  if (isTimed(room) && move.session.status === 'active') {
    startStepTimer(db, room, move.session.step_no, nowMs(), 'insert');
  }
  db.prepare("UPDATE rooms SET updated_at = datetime('now') WHERE code = ?").run(room.code);

  return { ok: true, settledStepNo, winner, tallies, voterCount };
}

/**
 * 限时房间到期补办（必须在事务内调用）。检查当前步的持久截止时间：
 *  - 不限时房间 / 无计时记录 / 尚未到点 / 已暂停待重开：不做任何事；
 *  - 到点且有票：按既有投票自动多数决推进（kind='auto'），下一步从实际时刻计满时长；
 *  - 到点零票：不推进，标记当前步 awaiting_reopen，等待主持人重开。
 * 返回 { acted: 'auto'|'await'|null, result? }，result 为 advanceFromWinner 的结果。
 */
function processDueStep(db, room, content, atMs) {
  if (!isTimed(room)) return { acted: null };
  const session = getRoomSession(db, room);
  if (!session || session.status !== 'active') return { acted: null };
  const step = getStepRow(db, room.code, session.step_no);
  if (!step || step.status !== 'open' || step.deadline_ms === null) return { acted: null };
  if (atMs < step.deadline_ms) return { acted: null };

  const node = nodesById(content).get(session.current_node_id);
  if (!node || node.isEnd) return { acted: null };

  const talliesMap = currentTallies(db, room.code, session.step_no);
  const voterCount = [...talliesMap.values()].reduce((a, b) => a + b, 0);
  if (voterCount === 0) {
    // 零票：停在本步，标记待重开（不改票数、路径、得分；本步没有任何投票故无票可清）
    db.prepare("UPDATE room_steps SET status = 'awaiting_reopen' WHERE room_code = ? AND step_no = ?")
      .run(room.code, session.step_no);
    db.prepare("UPDATE rooms SET updated_at = datetime('now') WHERE code = ?").run(room.code);
    return { acted: 'await' };
  }

  const result = advanceFromWinner(db, room, content, session, 'auto');
  if (!result.ok) return { acted: null, result };
  return { acted: 'auto', result };
}

/**
 * 扫描全部限时房间，补办任何已到期但尚未处理的步（服务启动后调用一次，之后周期调用）。
 * 纯由 room_steps.deadline_ms 驱动：无人访问、服务重启期间到期也会在这里补处理。
 */
function sweepDueRooms(db, atMs = nowMs()) {
  const rooms = db.prepare('SELECT * FROM rooms WHERE step_duration IS NOT NULL').all();
  let autoSettled = 0;
  let awaiting = 0;
  for (const room of rooms) {
    const content = getRoomContent(db, room);
    if (!content) continue;
    try {
      // 每房独立事务；极端情况下一次重启后可能连续补多步（每步处理后下一步 deadline
      // 基于“实际补办时刻”，故通常只有一步会到期），循环直至没有到期步。
      for (let guard = 0; guard < 1000; guard++) {
        const acted = db.transaction(() => processDueStep(db, room, content, atMs))();
        if (acted.acted === 'auto') autoSettled++;
        else if (acted.acted === 'await') awaiting++;
        else break;
      }
    } catch (e) {
      // 与并发补办/手动结算相遇时可能 UNIQUE；跳过等下一轮即可
      if (!String(e && e.message).includes('UNIQUE')) {
        console.error(`[限时房间] 到期补办失败 room=${room.code}:`, e);
      }
    }
  }
  return { autoSettled, awaiting };
}

// 组装限时信息（快照用）：timed=false 时为旧用法；true 时给出本步截止时刻、
// 剩余毫秒与阶段（open / awaiting_reopen / ended）。
function timedInfo(db, room, session, atMs) {
  if (!isTimed(room)) {
    return {
      timed: false,
      stepDurationSeconds: null,
      phase: session.status === 'ended' ? 'ended' : 'open',
      deadlineMs: null,
      deadlineAt: null,
      openedAtMs: null,
      remainingMs: null,
      reopenedCount: 0,
    };
  }
  if (session.status === 'ended') {
    return {
      timed: true,
      stepDurationSeconds: room.step_duration,
      phase: 'ended',
      deadlineMs: null,
      deadlineAt: null,
      openedAtMs: null,
      remainingMs: 0,
      reopenedCount: 0,
    };
  }
  const step = getStepRow(db, room.code, session.step_no);
  if (!step) {
    // 不应发生（限时房每步开始即写计时），容错为开放阶段、无倒计时
    return {
      timed: true,
      stepDurationSeconds: room.step_duration,
      phase: 'open',
      deadlineMs: null,
      deadlineAt: null,
      openedAtMs: null,
      remainingMs: null,
      reopenedCount: 0,
    };
  }
  const phase = step.status === 'awaiting_reopen' ? 'awaiting_reopen' : 'open';
  const deadlineMs = step.deadline_ms;
  return {
    timed: true,
    stepDurationSeconds: room.step_duration,
    phase,
    deadlineMs,
    deadlineAt: deadlineMs ? new Date(deadlineMs).toISOString() : null,
    openedAtMs: step.opened_at_ms,
    remainingMs: phase === 'open' && deadlineMs ? Math.max(0, deadlineMs - atMs) : 0,
    reopenedCount: step.reopened_count || 0,
  };
}

/**
 * 房间现状快照。viewer 可带 { memberToken, hostToken }：
 *  - 任何人可见：当前步各选项的聚合票数、已结算路径、累计分；
 *  - 有效成员凭证：附加 myVote（自己的投票）；
 *  - 有效主持凭证：附加 votes（逐人投票明细）与 members（成员名单）；
 *  - 未结算前，任何视图都不暴露“谁投了什么”给学员。
 * 凭证提供了但无效时返回 401，不静默降级。
 *
 * 盲投房间（blind_vote=1）在“当前步结算前”额外保密：
 *  - 围观者、学员、主持人都只能看到已投人数（totalVotes），各选项 votes 一律为 null，
 *    不返回逐人选项明细（即使持主持凭证，votes 也为 null）；
 *  - 学员凭有效成员凭证仍可查看/修改自己的票（myVote 照常返回）；
 *  - 主持人仍可查看成员名单（members 照常返回）；
 *  - 已结算步的结果（settlements / path 中的各选项票数与获胜处置）保持可见，
 *    但任何留痕都不含姓名↔选项对应。
 */
function buildRoomSnapshot(db, room, viewer = {}, atMs = nowMs()) {
  const session = getRoomSession(db, room);
  const content = getRoomContent(db, room);
  if (!session || !content) {
    return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '房间绑定的会话或冻结版本内容缺失' };
  }
  const base = buildSnapshot(content, session, room.scenario_id, room.version);
  const sc = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(room.scenario_id);

  const blind = isBlind(room);
  const tallies = currentTallies(db, room.code, session.step_no);
  // 盲投房当前步（结算前）：只保留已投人数，不暴露各选项票数；
  // 公开房（旧用法）：各选项附当前聚合票数。
  const withVotes = (list) => list.map((o) => ({
    ...o,
    votes: blind ? null : (tallies.get(o.id) || 0),
  }));
  const totalVotes = [...tallies.values()].reduce((a, b) => a + b, 0);
  const memberCount = db.prepare('SELECT COUNT(*) AS c FROM room_members WHERE room_code = ?').get(room.code).c;

  const timer = timedInfo(db, room, session, atMs);
  const snapshot = {
    code: room.code,
    joinCode: room.code, // 加入码即房间码
    sessionCode: session.code,
    scenarioId: room.scenario_id,
    scenarioTitle: sc ? sc.title : null,
    version: room.version,
    status: session.status, // active / ended（以绑定会话为准）
    stepNo: session.step_no,
    totalScore: base.totalScore,
    currentNode: base.currentNode,
    startNodeTitle: base.startNodeTitle,
    states: base.states,
    // 投票前不暴露分值/说明（与单人演练一致）；盲投房当前步 votes=null（只给已投人数）
    options: withVotes(base.availableOptions),
    unavailableOptions: withVotes(base.unavailableOptions),
    memberCount,
    totalVotes,
    // 盲投模式：true=当前步结算前仅公开已投人数；创建后不可更改
    blind,
    // 限时模式：false 为旧用法；true 时附每步时长、本步截止时间/剩余时间/阶段
    timed: timer.timed,
    stepDurationSeconds: timer.stepDurationSeconds,
    timer,
    path: base.path, // 已结算路径（含每步得分与评分说明）
    settlements: db.prepare('SELECT * FROM room_settlements WHERE room_code = ? ORDER BY step_no')
      .all(room.code)
      .map((r) => ({
        stepNo: r.step_no,
        optionId: r.option_id,
        tallies: JSON.parse(r.tallies),
        voterCount: r.voter_count,
        kind: r.kind || 'manual', // manual=主持人结算；auto=到点自动结算
        settledAt: r.created_at,
      })),
    createdAt: room.created_at,
    myVote: null,
    isHost: false,
  };

  if (viewer.memberToken) {
    const member = db.prepare('SELECT * FROM room_members WHERE room_code = ? AND member_token = ?')
      .get(room.code, viewer.memberToken);
    if (!member) {
      return { ok: false, status: 401, errorCode: 'MEMBER_TOKEN_INVALID', error: '成员凭证无效，请重新加入房间' };
    }
    const my = db.prepare('SELECT option_id FROM room_votes WHERE room_code = ? AND step_no = ? AND member_token = ?')
      .get(room.code, session.step_no, viewer.memberToken);
    snapshot.myVote = my ? { optionId: my.option_id } : null;
    snapshot.memberName = member.name || null;
  }
  if (viewer.hostToken) {
    if (room.host_token !== viewer.hostToken) {
      return { ok: false, status: 401, errorCode: 'HOST_TOKEN_INVALID', error: '主持凭证无效' };
    }
    snapshot.isHost = true;
    if (blind) {
      // 盲投当前步：主持人也看不到逐人选项与各选项票数；成员名单仍可见。
      snapshot.votes = null;
    } else {
      // 公开房：主持人可见逐人投票明细
      snapshot.votes = db.prepare(`
        SELECT m.name, v.option_id, v.updated_at FROM room_votes v
          LEFT JOIN room_members m ON m.room_code = v.room_code AND m.member_token = v.member_token
         WHERE v.room_code = ? AND v.step_no = ? ORDER BY v.updated_at, m.id
      `).all(room.code, session.step_no).map((r) => ({ name: r.name || '（匿名学员）', optionId: r.option_id }));
    }
    // 盲投房主持人仍可查看成员名单（不含各自选项）
    snapshot.members = db.prepare('SELECT name, created_at FROM room_members WHERE room_code = ? ORDER BY id')
      .all(room.code).map((r) => ({ name: r.name || '（匿名学员）', joinedAt: r.created_at }));
  }
  return { ok: true, snapshot };
}

/**
 * 开启共识演练房间（培训师）。
 * version 缺省为该情境当前最新发布版；指定时必须是已发布（≤ current_version）的版本。
 * stepDuration 缺省/null 为不限时旧用法；否则必须为 30..3600 的整数秒。
 * blind 仅接受布尔值：缺省/false 为公开投票旧用法，true 为盲投（结算前只公开已投人数）；
 * 非布尔值（null、字符串、数字等）返回 BLIND_INVALID，不建房；盲投选择创建后不可更改。
 * 房间绑定该冻结版本：后续发布新版本不改变本场规则。
 */
function createRoom(db, { scenarioId, version, stepDuration, blind }) {
  const sc = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId);
  if (!sc) return { ok: false, status: 404, errorCode: 'SCENARIO_NOT_FOUND', error: '情境不存在' };
  if (sc.current_version < 1) {
    return { ok: false, status: 400, errorCode: 'VERSION_NOT_PUBLISHED', error: '该情境尚未发布，无法开启共识演练' };
  }
  const dur = normalizeStepDuration(stepDuration);
  if (!dur.ok) {
    return { ok: false, status: 400, errorCode: 'STEP_DURATION_INVALID', error: dur.error };
  }
  const blindOpt = normalizeBlind(blind);
  if (!blindOpt.ok) {
    return { ok: false, status: 400, errorCode: 'BLIND_INVALID', error: blindOpt.error };
  }
  const v = version === undefined || version === null ? sc.current_version : Number(version);
  if (!Number.isInteger(v) || v < 1) {
    return { ok: false, status: 400, errorCode: 'VERSION_INVALID', error: `版本号非法：${JSON.stringify(version)}（必须为 ≥1 的整数）` };
  }
  const versionRow = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?').get(sc.id, v);
  if (!versionRow) {
    return { ok: false, status: 404, errorCode: 'VERSION_NOT_FOUND', error: `情境「${sc.title}」不存在已冻结版本 v${v}（当前已发布至 v${sc.current_version}）` };
  }
  const content = JSON.parse(versionRow.content);

  // 房间码 / 会话码随机碰撞时极小概率重试
  for (let attempt = 0; attempt < 3; attempt++) {
    const roomCode = newRoomCode();
    const hostToken = newHostToken();
    const sessionCode = crypto.randomBytes(5).toString('hex');
    try {
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO sessions (code, scenario_id, version, current_node_id, state_mask, step_no, status,
                                path, trainee_name, root_code, room_code)
          VALUES (?, ?, ?, ?, ?, 0, 'active', '[]', ?, ?, ?)
        `).run(sessionCode, sc.id, v, content.startNodeId, initialMask(content),
          '共识演练房间', sessionCode, roomCode);
        db.prepare('INSERT INTO rooms (code, host_token, scenario_id, version, session_code, step_duration, blind_vote) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(roomCode, hostToken, sc.id, v, sessionCode, dur.seconds, blindOpt.blind ? 1 : 0);
        // 限时房间：第 0 步开始即持久写入截止时间
        if (dur.seconds !== null) {
          const room = db.prepare('SELECT * FROM rooms WHERE code = ?').get(roomCode);
          const startNode = (content.nodes || []).find((n) => n.id === content.startNodeId);
          if (startNode && !startNode.isEnd) startStepTimer(db, room, 0, nowMs(), 'insert');
        }
      });
      tx();
      const room = getRoom(db, roomCode);
      return { ok: true, room, hostToken, scenarioTitle: sc.title };
    } catch (e) {
      if (String(e && e.message).includes('UNIQUE')) continue;
      throw e;
    }
  }
  return { ok: false, status: 500, errorCode: 'ROOM_CODE_CONFLICT', error: '房间码生成失败，请重试' };
}

/** 学员凭加入码加入房间，取得成员凭证。已结束的房间仍可加入观摩（投票会被拒绝）。 */
function joinRoom(db, { code, name }) {
  const room = getRoom(db, code);
  if (!room) return { ok: false, status: 404, errorCode: 'ROOM_NOT_FOUND', error: '房间不存在，请核对加入码' };
  const trimmed = typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const memberToken = newMemberToken();
    try {
      db.prepare('INSERT INTO room_members (room_code, member_token, name) VALUES (?, ?, ?)')
        .run(room.code, memberToken, trimmed);
      const snap = buildRoomSnapshot(db, room, { memberToken });
      return { ok: true, room, memberToken, memberName: trimmed, snapshot: snap.snapshot };
    } catch (e) {
      if (String(e && e.message).includes('UNIQUE')) continue;
      throw e;
    }
  }
  return { ok: false, status: 500, errorCode: 'MEMBER_TOKEN_CONFLICT', error: '成员凭证生成失败，请重试' };
}

/**
 * 学员投票 / 改票：{ memberToken, optionId, stepNo }。
 *  - stepNo 必须等于当前步号（过期页面/并发结算后的重复提交一律拒绝）；
 *  - 限时房间先补办到期步：到点后本步拒绝一切新票/改票（有票自动结算会推进到下一步，
 *    随后步号不匹配；零票暂停则返回 STEP_AWAITING_REOPEN）；
 *  - 选项必须属于当前节点且条件满足；
 *  - 同一成员同一步只计最后一票（UPSERT）；
 *  - 任何失败都不改变票数、路径与得分，并返回原因及当前步号。
 */
function castVote(db, { code, memberToken, optionId, stepNo }) {
  const room = getRoom(db, code);
  if (!room) return { ok: false, status: 404, errorCode: 'ROOM_NOT_FOUND', error: '房间不存在' };

  const member = db.prepare('SELECT * FROM room_members WHERE room_code = ? AND member_token = ?')
    .get(room.code, memberToken);
  if (!member) {
    const pub = buildRoomSnapshot(db, room, {});
    return {
      ok: false, status: 401, errorCode: 'MEMBER_TOKEN_INVALID',
      error: '成员凭证无效，请重新加入房间（未计票）',
      current: pub.ok ? pub.snapshot : null,
    };
  }

  const fail = (status, errorCode, error) => {
    const snap = buildRoomSnapshot(db, room, { memberToken });
    return { ok: false, status, errorCode, error, current: snap.ok ? snap.snapshot : null };
  };

  const content = getRoomContent(db, room);
  if (!content) return fail(500, 'VERSION_MISSING', '房间绑定的冻结版本内容缺失');

  try {
    const tx = db.transaction(() => {
      // 限时房间：先补办到期（可能自动推进到下一步，或零票暂停在本步）
      if (isTimed(room)) processDueStep(db, room, content, nowMs());

      const session = getRoomSession(db, room);
      if (!session) return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '房间绑定的会话缺失' };
      if (session.status !== 'active') {
        return { ok: false, status: 409, errorCode: 'ROOM_ENDED', error: `本场共识演练已结束（止步于第 ${session.step_no} 步），不能再投票` };
      }
      const step = isTimed(room) ? getStepRow(db, room.code, session.step_no) : null;
      if (step && step.status === 'awaiting_reopen') {
        return { ok: false, status: 409, errorCode: 'STEP_AWAITING_REOPEN',
          error: `第 ${session.step_no} 步限时结束且无人投票，已暂停等待主持人重开（未计票）` };
      }
      if (step && step.deadline_ms !== null && nowMs() >= step.deadline_ms) {
        // 极窄窗口：processDueStep 未产生动作（如无票但节点异常），仍按到点拒绝
        return { ok: false, status: 409, errorCode: 'STEP_DEADLINE_PASSED',
          error: `第 ${session.step_no} 步已到截止时间，本步不再接受新票或改票（未计票）` };
      }
      if (!Number.isInteger(stepNo) || stepNo !== session.step_no) {
        return { ok: false, status: 409, errorCode: 'STEP_STALE',
          error: `步号不匹配：你针对的是第 ${stepNo} 步，房间当前已进行到第 ${session.step_no} 步（可能已被结算推进），未计票` };
      }
      const node = nodesById(content).get(session.current_node_id);
      if (!node || node.isEnd) return { ok: false, status: 409, errorCode: 'NODE_NOT_CHOOSABLE', error: '当前步不是可投票节点' };
      const option = node.options.find((o) => o.id === optionId);
      if (!option) return { ok: false, status: 400, errorCode: 'OPTION_NOT_FOUND', error: '当前步不存在该选项，未计票' };
      if (!optionAvailable(option, session.state_mask, content)) {
        return { ok: false, status: 409, errorCode: 'CONDITION_NOT_MET', error: `当前现场状态不满足选项「${option.label}」的条件，未计票` };
      }

      // 每人每步只计最后一票：主键 (room, step, member) 冲突即改票
      db.prepare(`
        INSERT INTO room_votes (room_code, step_no, member_token, option_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(room_code, step_no, member_token)
        DO UPDATE SET option_id = excluded.option_id, updated_at = datetime('now')
      `).run(room.code, session.step_no, memberToken, optionId);
      return { ok: true };
    });
    const result = tx();
    if (!result.ok) return fail(result.status, result.errorCode, result.error);
  } catch (e) {
    if (String(e && e.message).includes('UNIQUE')) {
      // 与到期自动结算相遇并已先一步推进：返回现状（步号已变），不计票
      return fail(409, 'STEP_STALE', '该步刚被系统自动结算推进，你的投票未计入，请针对当前步投票');
    }
    throw e;
  }

  const snap = buildRoomSnapshot(db, room, { memberToken });
  return { ok: true, snapshot: snap.snapshot };
}

/**
 * 主持人结算：{ hostToken, observedStepNo }。
 *  - 限时房间先补办到期步（自动结算与手动结算相遇时由唯一约束保证只推进一次）；
 *  - observedStepNo 必须等于当前步号（所见步号过期则拒绝并返回当前步号）；
 *  - 限时房间到点零票已暂停：返回 STEP_AWAITING_REOPEN，请改用重开；
 *  - 无人投票不得结算；
 *  - 票数最多的选项推进共享会话；同票按冻结版本的选项编排顺序取先者；
 *  - 推进与留痕在同一事务内完成，(房间, 步号) 唯一约束防并发重复结算。
 */
function settleRoom(db, { code, hostToken, observedStepNo }) {
  const room = getRoom(db, code);
  if (!room) return { ok: false, status: 404, errorCode: 'ROOM_NOT_FOUND', error: '房间不存在' };
  if (room.host_token !== hostToken) {
    const pub = buildRoomSnapshot(db, room, {});
    return {
      ok: false, status: 401, errorCode: 'HOST_TOKEN_INVALID',
      error: '主持凭证无效（未结算）',
      current: pub.ok ? pub.snapshot : null,
    };
  }

  const fail = (status, errorCode, error) => {
    const snap = buildRoomSnapshot(db, room, { hostToken });
    return { ok: false, status, errorCode, error, current: snap.ok ? snap.snapshot : null };
  };

  const content = getRoomContent(db, room);
  if (!content) return fail(500, 'VERSION_MISSING', '房间绑定的冻结版本内容缺失');

  // 事务返回：失败 {ok:false,...}；成功 {ok:true, kind:'manual'|'auto', advance: advanceResult}
  let outcome;
  try {
    const tx = db.transaction(() => {
      let auto = null;
      // 限时房间：先补办到期（到点有票 → 自动推进；到点零票 → 暂停待重开）
      if (isTimed(room)) {
        const acted = processDueStep(db, room, content, nowMs());
        if (acted.acted === 'auto') auto = acted.result;
      }

      const session = getRoomSession(db, room);
      if (!session) return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '房间绑定的会话缺失' };
      if (session.status !== 'active') {
        return { ok: false, status: 409, errorCode: 'ROOM_ENDED', error: `本场共识演练已结束（止步于第 ${session.step_no} 步），不能再结算` };
      }
      const step = isTimed(room) ? getStepRow(db, room.code, session.step_no) : null;
      if (step && step.status === 'awaiting_reopen') {
        return { ok: false, status: 409, errorCode: 'STEP_AWAITING_REOPEN',
          error: `第 ${session.step_no} 步限时结束且无人投票，已暂停；请使用“重开本步”给学员完整时长，不能直接结算` };
      }
      if (!Number.isInteger(observedStepNo) || observedStepNo !== session.step_no) {
        return { ok: false, status: 409, errorCode: 'STEP_STALE',
          error: `步号不匹配：你看到的是第 ${observedStepNo} 步，房间当前为第 ${session.step_no} 步（可能已被他人或系统自动结算），未结算` };
      }

      // 若补办阶段已自动推进，步号必已变化，上面的 STEP_STALE 会拦截，不会走到这里。
      // 截止前主持人可提前结算（manual）；已到点的残余窗口交回系统自动结算。
      if (step && step.deadline_ms !== null && nowMs() >= step.deadline_ms) {
        return { ok: false, status: 409, errorCode: 'STEP_DEADLINE_PASSED',
          error: `第 ${session.step_no} 步已到截止时间，正在由系统自动结算，请刷新查看结果（未结算）` };
      }

      const result = advanceFromWinner(db, room, content, session, 'manual');
      if (!result.ok) return result;
      return { ok: true, kind: auto ? 'auto' : 'manual', advance: auto || result };
    });
    outcome = tx();
  } catch (e) {
    if (String(e && e.message).includes('UNIQUE')) {
      // 与自动结算/并发手动结算相遇：本事务回滚，未重复推进
      return fail(409, 'STEP_STALE', '该步刚刚已被结算（主持人结算或到点自动结算），未重复结算');
    }
    throw e;
  }
  if (!outcome.ok) return fail(outcome.status, outcome.errorCode, outcome.error);

  const { kind, advance } = outcome;
  const snap = buildRoomSnapshot(db, room, { hostToken });
  const last = snap.ok
    ? snap.snapshot.path.find((p) => p.step === advance.settledStepNo + 1)
    : null;
  return {
    ok: true,
    autoSettled: kind === 'auto',
    settled: {
      stepNo: advance.settledStepNo,
      optionId: advance.winner.optionId,
      optionLabel: advance.winner.optionLabel,
      tallies: advance.tallies,
      voterCount: advance.voterCount,
      kind, // manual=主持人手动结算；auto=到点由系统自动结算
      score: last ? last.score : 0,
      scoreNote: last ? last.scoreNote : '',
      totalScore: snap.ok ? snap.snapshot.totalScore : 0,
    },
    snapshot: snap.ok ? snap.snapshot : null,
  };
}

/**
 * 主持人重开（仅限时房间到点零票暂停后可用）：{ hostToken, observedStepNo }。
 *  - 必须处于 awaiting_reopen，且所见步号等于当前步号（步号不会因暂停改变）；
 *  - 从重开时刻起给本步完整的 step_duration，截止时间重新持久化；
 *  - 不推进、不改路径与得分（暂停时本步零票，无票数需要清理）。
 */
function reopenRoom(db, { code, hostToken, observedStepNo }) {
  const room = getRoom(db, code);
  if (!room) return { ok: false, status: 404, errorCode: 'ROOM_NOT_FOUND', error: '房间不存在' };
  if (room.host_token !== hostToken) {
    const pub = buildRoomSnapshot(db, room, {});
    return {
      ok: false, status: 401, errorCode: 'HOST_TOKEN_INVALID',
      error: '主持凭证无效（未重开）',
      current: pub.ok ? pub.snapshot : null,
    };
  }

  const fail = (status, errorCode, error) => {
    const snap = buildRoomSnapshot(db, room, { hostToken });
    return { ok: false, status, errorCode, error, current: snap.ok ? snap.snapshot : null };
  };

  const content = getRoomContent(db, room);
  if (!content) return fail(500, 'VERSION_MISSING', '房间绑定的冻结版本内容缺失');
  if (!isTimed(room)) {
    return fail(400, 'ROOM_NOT_TIMED', '该房间不是限时房间，无需重开计时');
  }

  const tx = db.transaction(() => {
    const session = getRoomSession(db, room);
    if (!session) return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '房间绑定的会话缺失' };
    if (session.status !== 'active') {
      return { ok: false, status: 409, errorCode: 'ROOM_ENDED', error: `本场共识演练已结束（止步于第 ${session.step_no} 步），不能重开` };
    }
    if (!Number.isInteger(observedStepNo) || observedStepNo !== session.step_no) {
      return { ok: false, status: 409, errorCode: 'STEP_STALE',
        error: `步号不匹配：你看到的是第 ${observedStepNo} 步，房间当前为第 ${session.step_no} 步，未重开` };
    }
    const step = getStepRow(db, room.code, session.step_no);
    if (!step) return { ok: false, status: 409, errorCode: 'STEP_NOT_TIMED', error: '当前步没有计时记录，无法重开' };
    if (step.status !== 'awaiting_reopen') {
      return { ok: false, status: 409, errorCode: 'STEP_NOT_PAUSED',
        error: `第 ${session.step_no} 步仍在计时中或已结算，不能重开（仅到点零票暂停的步可重开）` };
    }
    const at = nowMs();
    const deadline = startStepTimer(db, room, session.step_no, at, 'reopen');
    db.prepare("UPDATE rooms SET updated_at = datetime('now') WHERE code = ?").run(room.code);
    return { ok: true, reopenedStepNo: session.step_no, deadlineMs: deadline, reopenedCount: step.reopened_count + 1 };
  });

  let result;
  try {
    result = tx();
  } catch (e) {
    if (String(e && e.message).includes('UNIQUE')) {
      return fail(409, 'STEP_STALE', '该步状态刚发生变化，重开未生效，请刷新后重试');
    }
    throw e;
  }
  if (!result.ok) return fail(result.status, result.errorCode, result.error);

  const snap = buildRoomSnapshot(db, room, { hostToken });
  return {
    ok: true,
    reopened: {
      stepNo: result.reopenedStepNo,
      deadlineMs: result.deadlineMs,
      deadlineAt: new Date(result.deadlineMs).toISOString(),
      reopenedCount: result.reopenedCount,
      stepDurationSeconds: room.step_duration,
    },
    snapshot: snap.ok ? snap.snapshot : null,
  };
}

/** 最近房间列表（含状态、步号、成员数、限时/盲投配置；不暴露任何凭证与投票明细）。 */
function listRooms(db) {
  return db.prepare(`
    SELECT r.code, r.scenario_id, s.title AS scenario_title, r.version, r.session_code,
           r.step_duration, r.blind_vote, se.status, se.step_no, r.created_at,
           (SELECT COUNT(*) FROM room_members m WHERE m.room_code = r.code) AS member_count
      FROM rooms r
      JOIN scenarios s ON s.id = r.scenario_id
      JOIN sessions se ON se.code = r.session_code
     ORDER BY r.created_at DESC, r.code LIMIT 100
  `).all();
}

module.exports = {
  createRoom,
  joinRoom,
  castVote,
  settleRoom,
  reopenRoom,
  buildRoomSnapshot,
  listRooms,
  getRoom,
  sweepDueRooms,
  MIN_STEP_SECONDS,
  MAX_STEP_SECONDS,
};
