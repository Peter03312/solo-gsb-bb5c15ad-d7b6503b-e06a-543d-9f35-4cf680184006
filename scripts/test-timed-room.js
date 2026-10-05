'use strict';

// 限时房间端到端验证（临时库、不写正式数据）：
//   node scripts/test-timed-room.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'timed-room-'));
const dbPath = path.join(tmpDir, 'test.db');

const { open } = require('../server/db');
const { seed } = require('../server/seed');
const roomOps = require('../server/room');

const db = open(dbPath);
seed(db);

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`  ✅ ${name}`);
}
function eq(name, a, b) {
  assert.strictEqual(a, b, `${name}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
  passed++;
  console.log(`  ✅ ${name}`);
}

const scenarioId = db.prepare('SELECT id FROM scenarios LIMIT 1').get().id;

function backfillStep(roomCode, stepNo, deadlineMs, status = 'open') {
  // 模拟“时间已经过去”：把持久化的截止时间改到过去
  db.prepare('UPDATE room_steps SET deadline_ms = ?, status = ? WHERE room_code = ? AND step_no = ?')
    .run(deadlineMs, status, roomCode, stepNo);
}

(async () => {
  // ---------- 1. 开房参数校验 ----------
  console.log('1) 开房：省略=旧用法；非法时长拒绝；合法 30s 限时');
  const legacy = roomOps.createRoom(db, { scenarioId, version: 1 });
  ok('省略 stepDuration 开房成功', legacy.ok);
  eq('旧用法 step_duration 为 NULL', legacy.room.step_duration, null);

  const bad1 = roomOps.createRoom(db, { scenarioId, version: 1, stepDuration: 29 });
  eq('29 秒被拒绝', bad1.ok, false);
  eq('错误码 STEP_DURATION_INVALID', bad1.errorCode, 'STEP_DURATION_INVALID');
  const bad2 = roomOps.createRoom(db, { scenarioId, version: 1, stepDuration: 3601 });
  eq('3601 秒被拒绝', bad2.ok, false);
  const bad3 = roomOps.createRoom(db, { scenarioId, version: 1, stepDuration: 60.5 });
  eq('非整数被拒绝', bad3.ok, false);
  const bad4 = roomOps.createRoom(db, { scenarioId, version: 1, stepDuration: '60' });
  eq('字符串被拒绝', bad4.ok, false);

  const created = roomOps.createRoom(db, { scenarioId, version: 1, stepDuration: 30 });
  ok('30 秒限时房创建成功', created.ok);
  const room = created.room;
  eq('step_duration=30', room.step_duration, 30);
  const step0 = db.prepare('SELECT * FROM room_steps WHERE room_code=? AND step_no=0').get(room.code);
  ok('第 0 步开始时已持久化截止时间', step0 && step0.deadline_ms > Date.now());
  eq('初始剩余≈30s（允许误差）', Math.round((step0.deadline_ms - step0.opened_at_ms) / 1000), 30);

  // ---------- 2. 成员与投票 ----------
  console.log('2) 加入、投票/改票、截止前主持人提前结算');
  const m1 = roomOps.joinRoom(db, { code: room.code, name: '张三' });
  const m2 = roomOps.joinRoom(db, { code: room.code, name: '李四' });
  ok('两人加入', m1.ok && m2.ok);

  // 取第 0 步两个可选项
  const snap0 = roomOps.buildRoomSnapshot(db, room, { hostToken: created.hostToken }).snapshot;
  const [optA, optB] = snap0.options.map((o) => o.id);
  ok('第 0 步有 2 个可选项', !!optA && !!optB);

  const v1 = roomOps.castVote(db, { code: room.code, memberToken: m1.memberToken, optionId: optA, stepNo: 0 });
  ok('张三投票成功', v1.ok);
  const v1b = roomOps.castVote(db, { code: room.code, memberToken: m1.memberToken, optionId: optB, stepNo: 0 });
  ok('张三改票成功（只计最后一票）', v1b.ok);
  const v2 = roomOps.castVote(db, { code: room.code, memberToken: m2.memberToken, optionId: optA, stepNo: 0 });
  ok('李四投票成功', v2.ok);
  const hostSnapBefore = roomOps.buildRoomSnapshot(db, room, { hostToken: created.hostToken }).snapshot;
  const tallyA = hostSnapBefore.options.find((o) => o.id === optA).votes;
  const tallyB = hostSnapBefore.options.find((o) => o.id === optB).votes;
  eq('改票后 A=1', tallyA, 1);
  eq('改票后 B=1', tallyB, 1);

  // 到点前主持人提前结算（1:1 同票 → 编排顺序 optA 胜）
  const early = roomOps.settleRoom(db, { code: room.code, hostToken: created.hostToken, observedStepNo: 0 });
  ok('截止前主持人提前结算成功', early.ok);
  eq('提前结算 kind=manual', early.settled.kind, 'manual');
  eq('同票按编排顺序 optA 胜出', early.settled.optionId, optA);
  eq('推进到第 1 步', early.snapshot.stepNo, 1);
  const step1 = db.prepare('SELECT * FROM room_steps WHERE room_code=? AND step_no=1').get(room.code);
  ok('第 1 步从实际推进时刻重新计时（完整 30s）', step1 && Math.round((step1.deadline_ms - step1.opened_at_ms) / 1000) === 30);
  eq('第 0 步留痕 kind=manual', db.prepare('SELECT kind FROM room_settlements WHERE room_code=? AND step_no=0').get(room.code).kind, 'manual');

  // ---------- 3. 到点有票自动结算 ----------
  console.log('3) 到点有票：无人访问也自动多数决推进');
  const snap1 = roomOps.buildRoomSnapshot(db, room, { hostToken: created.hostToken }).snapshot;
  const [a1, b1] = snap1.options.map((o) => o.id);
  // 选第一个选项继续推进（示例中第二个选项会直达结局）
  roomOps.castVote(db, { code: room.code, memberToken: m1.memberToken, optionId: a1, stepNo: 1 });
  roomOps.castVote(db, { code: room.code, memberToken: m2.memberToken, optionId: a1, stepNo: 1 });
  // 模拟时间流逝：第 1 步截止时间移到过去；不调用任何接口，直接 sweep（模拟无人访问+重启）
  backfillStep(room.code, 1, Date.now() - 5000);
  const swept = roomOps.sweepDueRooms(db, Date.now());
  ok('sweep 自动结算至少 1 步', swept.autoSettled >= 1);
  const settle1 = db.prepare('SELECT * FROM room_settlements WHERE room_code=? AND step_no=1').get(room.code);
  eq('第 1 步按多数票 a1 胜出', settle1.option_id, a1);
  eq('第 1 步留痕 kind=auto', settle1.kind, 'auto');
  const sess = db.prepare('SELECT * FROM sessions WHERE code=?').get(room.session_code);
  eq('共享会话推进到第 2 步', sess.step_no, 2);
  eq('第 2 步未结束', sess.status, 'active');
  const step2 = db.prepare('SELECT * FROM room_steps WHERE room_code=? AND step_no=2').get(room.code);
  ok('第 2 步已开始计时', step2 && step2.status === 'open' && step2.deadline_ms > Date.now());

  // 到点后针对旧步的投票被拒绝且不改票
  const late = roomOps.castVote(db, { code: room.code, memberToken: m1.memberToken, optionId: b1, stepNo: 1 });
  eq('针对已结算旧步投票 → STEP_STALE', late.errorCode, 'STEP_STALE');
  eq('拒绝时回传当前步号=2', late.current.stepNo, 2);

  // ---------- 4. 到点零票暂停 + 主持人重开 ----------
  console.log('4) 到点零票：停在本步、标记待重开；主持人凭凭证+所见步号重开完整时长');
  // 第 2 步无人投票，直接到点
  backfillStep(room.code, 2, Date.now() - 1000);
  const swept2 = roomOps.sweepDueRooms(db, Date.now());
  ok('sweep 零票暂停至少 1 步', swept2.awaiting >= 1);
  const step2b = db.prepare('SELECT * FROM room_steps WHERE room_code=? AND step_no=2').get(room.code);
  eq('第 2 步状态 awaiting_reopen', step2b.status, 'awaiting_reopen');
  const sess2 = db.prepare('SELECT step_no FROM sessions WHERE code=?').get(room.session_code);
  eq('零票不推进，停在第 2 步', sess2.step_no, 2);

  // 暂停期间投票被拒
  const snap2 = roomOps.buildRoomSnapshot(db, room, {}).snapshot;
  const [a2] = snap2.options.map((o) => o.id);
  const votePaused = roomOps.castVote(db, { code: room.code, memberToken: m1.memberToken, optionId: a2, stepNo: 2 });
  eq('暂停期间投票 → STEP_AWAITING_REOPEN', votePaused.errorCode, 'STEP_AWAITING_REOPEN');
  eq('暂停快照 phase=awaiting_reopen', votePaused.current.timer.phase, 'awaiting_reopen');

  // 主持人直接结算被拒（零票且已暂停）
  const settlePaused = roomOps.settleRoom(db, { code: room.code, hostToken: created.hostToken, observedStepNo: 2 });
  eq('暂停期间直接结算 → STEP_AWAITING_REOPEN', settlePaused.errorCode, 'STEP_AWAITING_REOPEN');

  // 错误步号重开被拒
  const badReopen = roomOps.reopenRoom(db, { code: room.code, hostToken: created.hostToken, observedStepNo: 9 });
  eq('错误所见步号重开 → STEP_STALE', badReopen.errorCode, 'STEP_STALE');
  eq('拒绝重开回传当前步号=2', badReopen.current.stepNo, 2);

  // 正确重开
  const reopened = roomOps.reopenRoom(db, { code: room.code, hostToken: created.hostToken, observedStepNo: 2 });
  ok('凭正确步号重开成功', reopened.ok);
  eq('重开返回的步号=2', reopened.reopened.stepNo, 2);
  eq('重开给完整 30s', reopened.reopened.stepDurationSeconds, 30);
  ok('新截止时间在未来', reopened.reopened.deadlineMs > Date.now());
  const step2r = db.prepare('SELECT * FROM room_steps WHERE room_code=? AND step_no=2').get(room.code);
  eq('重开后状态 open', step2r.status, 'open');
  eq('重开次数=1', step2r.reopened_count, 1);
  eq('重开不推进（仍第 2 步）', db.prepare('SELECT step_no FROM sessions WHERE code=?').get(room.session_code).step_no, 2);

  // 重开后可正常投票、主持人结算
  const vAfter = roomOps.castVote(db, { code: room.code, memberToken: m1.memberToken, optionId: a2, stepNo: 2 });
  ok('重开后投票成功', vAfter.ok);

  // ---------- 5. 非限时旧用法完全不变 ----------
  console.log('5) 旧用法（不限时）行为保持原样');
  const lm = roomOps.joinRoom(db, { code: legacy.room.code, name: '旧' });
  const lsnap = roomOps.buildRoomSnapshot(db, legacy.room, { hostToken: legacy.hostToken }).snapshot;
  eq('旧房间 timed=false', lsnap.timed, false);
  eq('旧房间 timer.phase=open', lsnap.timer.phase, 'open');
  eq('旧房间无截止时间', lsnap.timer.deadlineMs, null);
  const lo = lsnap.options[0].id;
  roomOps.castVote(db, { code: legacy.room.code, memberToken: lm.memberToken, optionId: lo, stepNo: 0 });
  // sweep 不应影响旧房间
  roomOps.sweepDueRooms(db, Date.now());
  eq('sweep 后旧房间仍在第 0 步', db.prepare('SELECT step_no FROM sessions WHERE code=?').get(legacy.room.session_code).step_no, 0);
  const lset = roomOps.settleRoom(db, { code: legacy.room.code, hostToken: legacy.hostToken, observedStepNo: 0 });
  ok('旧房间手动结算成功', lset.ok);
  const lreopen = roomOps.reopenRoom(db, { code: legacy.room.code, hostToken: legacy.hostToken, observedStepNo: 1 });
  eq('旧房间重开 → ROOM_NOT_TIMED', lreopen.errorCode, 'ROOM_NOT_TIMED');

  // ---------- 6. 防重复推进 ----------
  console.log('6) 并发/交错不重复推进');
  const t2 = roomOps.createRoom(db, { scenarioId, version: 1, stepDuration: 30 });
  const x1 = roomOps.joinRoom(db, { code: t2.room.code, name: 'x' });
  const xsnap = roomOps.buildRoomSnapshot(db, t2.room, {}).snapshot;
  const xa = xsnap.options[0].id;
  roomOps.castVote(db, { code: t2.room.code, memberToken: x1.memberToken, optionId: xa, stepNo: 0 });
  backfillStep(t2.room.code, 0, Date.now() - 100);
  // 到点后主持人结算：内部先自动结算推进；再带旧所见步号结算必被 STEP_STALE 拒
  const sLate = roomOps.settleRoom(db, { code: t2.room.code, hostToken: t2.hostToken, observedStepNo: 0 });
  ok('到点后主持人结算请求未重复推进（自动结算生效）', sLate.ok === true || sLate.errorCode === 'STEP_STALE');
  const sAgain = roomOps.settleRoom(db, { code: t2.room.code, hostToken: t2.hostToken, observedStepNo: 0 });
  eq('重复结算旧步号 → STEP_STALE', sAgain.errorCode, 'STEP_STALE');
  eq('只推进一次（第 1 步）', db.prepare('SELECT step_no FROM sessions WHERE code=?').get(t2.room.session_code).step_no, 1);
  eq('第 0 步仅一条留痕', db.prepare('SELECT COUNT(*) AS c FROM room_settlements WHERE room_code=? AND step_no=0').get(t2.room.code).c, 1);

  console.log(`\n全部通过：${passed} 项断言。临时库：${dbPath}`);
  process.exit(0);
})().catch((e) => {
  console.error('❌ 测试失败：', e);
  process.exit(1);
});
