'use strict';

// 盲投房间端到端验证（临时库、不写正式数据）：
//   node scripts/test-blind-room.js
//
// 覆盖：
//  1. 开房 blind 参数：缺省/false=公开旧用法；true=盲投；非布尔值（null/字符串/数字/0/1）报错不建房；
//  2. 盲投当前步结算前：围观 / 学员 / 主持三种视图都只有已投人数，看不到各选项票数与逐人选项；
//     学员凭成员凭证仍可查看/修改自己的票；主持人仍可查看成员名单；
//  3. 主持提前结算后公布该步各选项票数与获胜处置；姓名↔选项对应始终不出现在任何响应里；
//  4. 盲投 + 限时叠加：到点自动结算同样公布票数；零票暂停与重开期间继续保密；
//  5. 已结算步结果在后续步快照中保持可见；截止步号、同票顺序、路径、计分沿用现状；
//  6. 盲投设置创建后不可更改（无修改入口，且库列保持建房值）。
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-room-'));
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
  db.prepare('UPDATE room_steps SET deadline_ms = ?, status = ? WHERE room_code = ? AND step_no = ?')
    .run(deadlineMs, status, roomCode, stepNo);
}

// 递归断言对象中不存在指定键（防止姓名↔选项泄露）
function assertNoKey(obj, key, pathName) {
  if (obj === null || typeof obj !== 'object') return;
  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    throw new Error(`在 ${pathName} 中发现不应出现的字段「${key}」`);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') assertNoKey(v, key, `${pathName}.${k}`);
  }
}

(async () => {
  // ---------- 1. 开房参数 ----------
  console.log('1) 开房：blind 仅接受布尔值；缺省/false 为公开旧用法');
  const legacy = roomOps.createRoom(db, { scenarioId, version: 1 });
  ok('缺省 blind 开房成功', legacy.ok);
  eq('缺省 blind → blind_vote=0（公开）', legacy.room.blind_vote, 0);

  const explicitOpen = roomOps.createRoom(db, { scenarioId, version: 1, blind: false });
  ok('blind=false 开房成功', explicitOpen.ok);
  eq('blind=false → blind_vote=0', explicitOpen.room.blind_vote, 0);

  for (const bad of [null, 'true', 1, 0, 'yes', {}, []]) {
    const r = roomOps.createRoom(db, { scenarioId, version: 1, blind: bad });
    eq(`blind=${JSON.stringify(bad)} 被拒绝且不建房`, r.ok, false);
    eq(`blind=${JSON.stringify(bad)} 错误码 BLIND_INVALID`, r.errorCode, 'BLIND_INVALID');
    eq(`blind=${JSON.stringify(bad)} HTTP 400`, r.status, 400);
  }
  const roomsBefore = db.prepare('SELECT COUNT(*) AS c FROM rooms').get().c;

  const created = roomOps.createRoom(db, { scenarioId, version: 1, blind: true });
  ok('blind=true 开房成功', created.ok);
  eq('blind=true → blind_vote=1', created.room.blind_vote, 1);
  const room = created.room;

  // ---------- 2. 结算前三种视图的可见性 ----------
  console.log('2) 盲投当前步：围观/学员/主持都只看到已投人数');
  const m1 = roomOps.joinRoom(db, { code: room.code, name: '张三' });
  const m2 = roomOps.joinRoom(db, { code: room.code, name: '李四' });
  ok('两人加入', m1.ok && m2.ok);

  const snap0 = roomOps.buildRoomSnapshot(db, room, {}).snapshot;
  const [optA, optB] = snap0.options.map((o) => o.id);
  ok('第 0 步有 2 个可选项', !!optA && !!optB);
  eq('快照标记 blind=true', snap0.blind, true);

  roomOps.castVote(db, { code: room.code, memberToken: m1.memberToken, optionId: optA, stepNo: 0 });
  roomOps.castVote(db, { code: room.code, memberToken: m2.memberToken, optionId: optB, stepNo: 0 });

  // 2a. 围观者
  const pub = roomOps.buildRoomSnapshot(db, room, {}).snapshot;
  eq('围观：只看到已投人数=2', pub.totalVotes, 2);
  ok('围观：各可选项 votes 均为 null', pub.options.every((o) => o.votes === null));
  ok('围观：不可选项 votes 也为 null', pub.unavailableOptions.every((o) => o.votes === null));
  eq('围观：无 myVote', pub.myVote, null);
  eq('围观：votes 字段不存在', Object.prototype.hasOwnProperty.call(pub, 'votes'), false);
  eq('围观：members 字段不存在', Object.prototype.hasOwnProperty.call(pub, 'members'), false);

  // 2b. 学员（张三）：能看/改自己的票，看不到票数与他人
  const mem1 = roomOps.buildRoomSnapshot(db, room, { memberToken: m1.memberToken }).snapshot;
  eq('学员张三：myVote=optA', mem1.myVote.optionId, optA);
  ok('学员：各选项 votes 均为 null', mem1.options.every((o) => o.votes === null));
  eq('学员：已投人数=2', mem1.totalVotes, 2);
  eq('学员视图无 votes 明细字段', Object.prototype.hasOwnProperty.call(mem1, 'votes'), false);

  // 张三改票为 optB（结算前可改）
  const change = roomOps.castVote(db, { code: room.code, memberToken: m1.memberToken, optionId: optB, stepNo: 0 });
  ok('盲投中改票成功', change.ok);
  const mem1b = roomOps.buildRoomSnapshot(db, room, { memberToken: m1.memberToken }).snapshot;
  eq('学员张三改票后 myVote=optB', mem1b.myVote.optionId, optB);

  // 2c. 主持人：看不到逐人选项与各选项票数，但成员名单仍可见
  const host = roomOps.buildRoomSnapshot(db, room, { hostToken: created.hostToken }).snapshot;
  eq('主持：isHost=true', host.isHost, true);
  eq('主持：votes=null（无逐人选项）', host.votes, null);
  ok('主持：各选项 votes 均为 null', host.options.every((o) => o.votes === null));
  eq('主持：只看到已投人数=2', host.totalVotes, 2);
  ok('主持：成员名单仍可见（2 人）', Array.isArray(host.members) && host.members.length === 2);
  ok('主持：成员名单仅含姓名不含选项', host.members.every((m) => !('optionId' in m)));
  const hostNames = host.members.map((m) => m.name).sort();
  ok('主持：名单含张三/李四', JSON.stringify(hostNames) === JSON.stringify(['张三', '李四']));

  // 任何视图中都不应出现“谁投了什么”的结构
  assertNoKey(host, 'option_id', 'hostSnapshot');
  assertNoKey(pub, 'option_id', 'publicSnapshot');

  // ---------- 3. 提前结算：公布票数与获胜处置，不公布姓名 ----------
  console.log('3) 主持提前结算：公布各选项票数与获胜处置，永不公开姓名对应');
  const settled = roomOps.settleRoom(db, { code: room.code, hostToken: created.hostToken, observedStepNo: 0 });
  ok('盲投房结算成功', settled.ok);
  eq('结算推进到第 1 步', settled.snapshot.stepNo, 1);
  const tallyById = Object.fromEntries(settled.settled.tallies.map((t) => [t.optionId, t.votes]));
  eq('公布：optA=0 票（张三改票后无人投 A）', tallyById[optA], 0);
  eq('公布：optB=2 票', tallyById[optB], 2);
  eq('公布：获胜选项 optB', settled.settled.optionId, optB);
  eq('公布：投票人数 2', settled.settled.voterCount, 2);
  // 结算留痕与响应均不含姓名
  assertNoKey(settled.settled, 'name', 'settled');
  assertNoKey(settled.settled, 'memberToken', 'settled');
  const row = db.prepare('SELECT tallies FROM room_settlements WHERE room_code=? AND step_no=0').get(room.code);
  const stored = JSON.parse(row.tallies);
  ok('留痕只有 optionId/optionLabel/votes', stored.every((t) => !('name' in t) && !('memberToken' in t)));

  // 后续步（第 1 步）仍为盲投：第 1 步票数隐藏
  const host1 = roomOps.buildRoomSnapshot(db, room, { hostToken: created.hostToken }).snapshot;
  eq('下一步仍 blind=true', host1.blind, true);
  ok('下一步当前步 votes=null', host1.options.every((o) => o.votes === null));

  // 已结算的第 0 步结果在第 1 步快照中保持可见
  const past = host1.settlements.find((s) => s.stepNo === 0);
  ok('已结算步结果保持可见', !!past && past.optionId === optB);
  const pastTally = Object.fromEntries(past.tallies.map((t) => [t.optionId, t.votes]));
  eq('已结算步票数保持可见（optB=2）', pastTally[optB], 2);
  assertNoKey(past, 'name', 'pastSettlement');

  // ---------- 4. 盲投 + 限时叠加 ----------
  console.log('4) 盲投 × 限时：到点自动结算公布票数；零票暂停/重开期间继续保密');
  const bt = roomOps.createRoom(db, { scenarioId, version: 1, blind: true, stepDuration: 30 });
  ok('盲投+限时开房成功', bt.ok && bt.room.blind_vote === 1 && bt.room.step_duration === 30);
  const z1 = roomOps.joinRoom(db, { code: bt.room.code, name: '王五' });
  const z2 = roomOps.joinRoom(db, { code: bt.room.code, name: '赵六' });
  const bsnap0 = roomOps.buildRoomSnapshot(db, bt.room, { hostToken: bt.hostToken }).snapshot;
  const [ba, bb] = bsnap0.options.map((o) => o.id);
  roomOps.castVote(db, { code: bt.room.code, memberToken: z1.memberToken, optionId: ba, stepNo: 0 });
  roomOps.castVote(db, { code: bt.room.code, memberToken: z2.memberToken, optionId: ba, stepNo: 0 });
  const bh = roomOps.buildRoomSnapshot(db, bt.room, { hostToken: bt.hostToken }).snapshot;
  eq('盲投限时房：结算前主持也只看到人数=2', bh.totalVotes, 2);
  eq('盲投限时房：votes=null', bh.votes, null);
  ok('盲投限时房：votes 字段全部 null', bh.options.every((o) => o.votes === null));

  // 到点自动结算
  backfillStep(bt.room.code, 0, Date.now() - 5000);
  const swept = roomOps.sweepDueRooms(db, Date.now());
  ok('sweep 自动结算', swept.autoSettled >= 1);
  const autoRow = db.prepare('SELECT * FROM room_settlements WHERE room_code=? AND step_no=0').get(bt.room.code);
  eq('自动结算 kind=auto 且获胜 ba', autoRow.kind === 'auto' && autoRow.option_id === ba, true);

  // 第 1 步零票到点 → 暂停：暂停期间继续保密
  backfillStep(bt.room.code, 1, Date.now() - 1000);
  roomOps.sweepDueRooms(db, Date.now());
  const paused = roomOps.buildRoomSnapshot(db, bt.room, { hostToken: bt.hostToken }).snapshot;
  eq('暂停 phase=awaiting_reopen', paused.timer.phase, 'awaiting_reopen');
  eq('暂停仍 blind=true', paused.blind, true);
  ok('暂停期间当前步 votes=null', paused.options.every((o) => o.votes === null));

  // 主持人重开
  const reopened = roomOps.reopenRoom(db, { code: bt.room.code, hostToken: bt.hostToken, observedStepNo: 1 });
  ok('盲投限时房重开成功', reopened.ok);
  const reopenedSnap = roomOps.buildRoomSnapshot(db, bt.room, {}).snapshot;
  eq('重开后 phase=open', reopenedSnap.timer.phase, 'open');
  eq('重开后仍 blind=true', reopenedSnap.blind, true);
  ok('重开后当前步 votes=null', reopenedSnap.options.every((o) => o.votes === null));

  // ---------- 5. 公开房（旧用法）行为完全不变 ----------
  console.log('5) 公开房（缺省 blind）照旧公开各选项票数与主持逐人明细');
  const ls = roomOps.buildRoomSnapshot(db, legacy.room, { hostToken: legacy.hostToken }).snapshot;
  eq('公开房 blind=false', ls.blind, false);
  const lm = roomOps.joinRoom(db, { code: legacy.room.code, name: '旧用法学员' });
  roomOps.castVote(db, { code: legacy.room.code, memberToken: lm.memberToken, optionId: ls.options[0].id, stepNo: 0 });
  const lh = roomOps.buildRoomSnapshot(db, legacy.room, { hostToken: legacy.hostToken }).snapshot;
  eq('公开房：选项票数照常显示', lh.options[0].votes, 1);
  ok('公开房：主持逐人明细照常返回', Array.isArray(lh.votes) && lh.votes.length === 1 && lh.votes[0].optionId === ls.options[0].id);
  const lset = roomOps.settleRoom(db, { code: legacy.room.code, hostToken: legacy.hostToken, observedStepNo: 0 });
  ok('公开房结算成功', lset.ok);

  // ---------- 6. 盲投设置创建后不可更改 ----------
  console.log('6) 盲投设置持久且无修改入口');
  eq('盲投房库内 blind_vote 始终=1', db.prepare('SELECT blind_vote FROM rooms WHERE code=?').get(room.code).blind_vote, 1);
  eq('公开房库内 blind_vote 始终=0', db.prepare('SELECT blind_vote FROM rooms WHERE code=?').get(legacy.room.code).blind_vote, 0);

  const roomsAfter = db.prepare('SELECT COUNT(*) AS c FROM rooms').get().c;
  // 6 个非法 blind 全部未建房；roomsBefore 之后仅成功创建 created（盲投）与 bt（盲投限时）2 个新房
  eq('非法 blind 均未建房（之后仅新增 2 个合法盲投房）', roomsAfter - roomsBefore, 2);

  console.log(`\n全部通过：${passed} 项断言。临时库：${dbPath}`);
  process.exit(0);
})().catch((e) => {
  console.error('❌ 测试失败：', e);
  process.exit(1);
});
