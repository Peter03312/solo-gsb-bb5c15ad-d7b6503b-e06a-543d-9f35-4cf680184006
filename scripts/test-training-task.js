'use strict';

// 训练任务端到端验证（临时库、不写正式数据）：
//   node scripts/test-training-task.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'training-task-'));
const dbPath = path.join(tmpDir, 'test.db');

const { open } = require('../server/db');
const { seed } = require('../server/seed');
const taskOps = require('../server/task');

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
const tasksBefore = () => db.prepare('SELECT COUNT(*) AS c FROM training_tasks').get().c;
const traineesBefore = () => db.prepare('SELECT COUNT(*) AS c FROM task_trainees').get().c;

const futureMs = Date.now() + 60 * 60 * 1000;
const baseBody = () => ({
  scenarioId,
  version: 1,
  deadlineMs: futureMs,
  maxAttempts: 2,
  passScore: 0,
  trainees: ['张三', '李四'],
});

(async () => {
  // ---------- 1. 非法配置整次拒绝 ----------
  console.log('1) 建任务参数校验：非法配置整次拒绝，不写任何数据');
  const rejectBody = (body, code) => {
    const t0 = tasksBefore();
    const p0 = traineesBefore();
    const r = taskOps.createTask(db, body);
    eq('被拒绝', r.ok, false);
    eq(`错误码 ${code}`, r.errorCode, code);
    eq('不新增任务', tasksBefore(), t0);
    eq('不新增学员凭证', traineesBefore(), p0);
    return r;
  };

  rejectBody({ ...baseBody(), deadlineMs: Date.now() - 1000 }, 'TASK_CONFIG_INVALID');
  rejectBody({ ...baseBody(), deadlineMs: '2000-01-01' }, 'TASK_CONFIG_INVALID');
  rejectBody({ ...baseBody(), deadlineMs: 'not-a-time' }, 'TASK_CONFIG_INVALID');
  const noDeadline = rejectBody({ scenarioId, maxAttempts: 2, passScore: 0, trainees: ['张三'] }, 'TASK_CONFIG_INVALID');
  ok('缺截止时间给出原因', noDeadline.errors.some((e) => e.includes('截止时间')));

  rejectBody({ ...baseBody(), maxAttempts: 0 }, 'TASK_CONFIG_INVALID');
  rejectBody({ ...baseBody(), maxAttempts: -1 }, 'TASK_CONFIG_INVALID');
  rejectBody({ ...baseBody(), maxAttempts: 2.5 }, 'TASK_CONFIG_INVALID');
  rejectBody({ ...baseBody(), maxAttempts: '2' }, 'TASK_CONFIG_INVALID');
  const badAttempts = taskOps.createTask(db, { ...baseBody(), maxAttempts: 0 });
  ok('次数非法给出原因', badAttempts.errors.some((e) => e.includes('尝试次数')));

  rejectBody({ ...baseBody(), passScore: 1.5 }, 'TASK_CONFIG_INVALID');
  rejectBody({ ...baseBody(), passScore: '60' }, 'TASK_CONFIG_INVALID');
  const badScore = taskOps.createTask(db, { ...baseBody(), passScore: null });
  ok('及格分非法给出原因', badScore.errors.some((e) => e.includes('及格分')));

  rejectBody({ ...baseBody(), trainees: [] }, 'TASK_CONFIG_INVALID');
  rejectBody({ ...baseBody(), trainees: ['张三', '张三'] }, 'TASK_CONFIG_INVALID');
  rejectBody({ ...baseBody(), trainees: [' 王五 ', '王五'] }, 'TASK_CONFIG_INVALID'); // 去空白后重复
  rejectBody({ ...baseBody(), trainees: ['', '李四'] }, 'TASK_CONFIG_INVALID');
  rejectBody({ ...baseBody(), trainees: [null] }, 'TASK_CONFIG_INVALID');
  const dup = taskOps.createTask(db, { ...baseBody(), trainees: ['张三', '张三'] });
  ok('姓名重复给出原因', dup.errors.some((e) => e.includes('重复')));

  rejectBody({ ...baseBody(), scenarioId: 'sc_not_exist' }, 'TASK_CONFIG_INVALID');
  rejectBody({ ...baseBody(), version: 999 }, 'TASK_CONFIG_INVALID');
  rejectBody({ ...baseBody(), version: 0 }, 'TASK_CONFIG_INVALID');
  // 多个非法项一次性收集返回
  const many = taskOps.createTask(db, {
    scenarioId, deadlineMs: Date.now() - 1, maxAttempts: 0, passScore: 1.2, trainees: [],
  });
  ok('多项非法全部列出（>=4 项）', many.errors.length >= 4);

  // ---------- 2. 合法建任务 ----------
  console.log('2) 合法配置建任务：返回管理凭证与各学员独立参与凭证');
  const created = taskOps.createTask(db, baseBody());
  ok('建任务成功', created.ok);
  const task = created.task;
  eq('任务码 10 位', task.code.length, 10);
  ok('管理凭证 tmgr_ 前缀', created.hostToken.startsWith('tmgr_'));
  eq('两名学员凭证', created.trainees.length, 2);
  ok('参与凭证 tmem_ 前缀', created.trainees.every((t) => t.token.startsWith('tmem_')));
  const tokenA = created.trainees.find((t) => t.name === '张三').token;
  const tokenB = created.trainees.find((t) => t.name === '李四').token;
  ok('两人凭证不同', tokenA !== tokenB);

  // ---------- 3. 开始/续做与重复开始幂等 ----------
  console.log('3) 开始/续做：重复开始返回原会话，不多建会话不多扣次数');
  const s1 = taskOps.startAttempt(db, tokenA);
  ok('第 1 次开始为新建', s1.created === true && s1.attemptNo === 1);
  eq('初始第 0 步', s1.snapshot.stepNo, 0);
  const code1 = s1.sessionCode;
  const s1b = taskOps.startAttempt(db, tokenA);
  eq('重复开始为续做', s1b.resumed, true);
  eq('重复开始返回同一会话', s1b.sessionCode, code1);
  eq('重复开始不增加尝试次数', s1b.view.attemptsUsed, 1);
  eq('仍有 1 次剩余', s1b.view.attemptsLeft, 1);

  // ---------- 4. 凭证隔离 ----------
  console.log('4) 权限：无效凭证、他人凭证不能查看/操作');
  const badToken = taskOps.getMyTask(db, 'tmem_deadbeefdeadbeefdeadbeef');
  eq('无效参与凭证 401', badToken.status, 401);
  eq('错误码 TASK_TOKEN_INVALID', badToken.errorCode, 'TASK_TOKEN_INVALID');
  const badReport = taskOps.getTaskReport(db, { code: task.code, hostToken: 'tmgr_wrong' });
  eq('错误管理凭证 401', badReport.status, 401);
  eq('错误码 TASK_HOST_TOKEN_INVALID', badReport.errorCode, 'TASK_HOST_TOKEN_INVALID');
  const noTask = taskOps.getTaskReport(db, { code: '0000000000', hostToken: created.hostToken });
  eq('任务不存在 404', noTask.status, 404);

  // B 不能操作 A 的尝试
  const cross = taskOps.moveAttempt(db, { token: tokenB, attemptNo: 1, optionId: 'o_cut_power', stepNo: 0 });
  eq('他人 move 被拒', cross.ok, false);
  eq('错误码 ATTEMPT_NOT_FOUND', cross.errorCode, 'ATTEMPT_NOT_FOUND');
  const crossGet = taskOps.getAttempt(db, tokenB, 1);
  // B 还没有任何尝试
  eq('他人/不存在尝试 404', crossGet.ok, false);

  // ---------- 5. 推进、步号校验、结束消耗次数 ----------
  console.log('5) 沿冻结版本推进：步号/选项校验；结束后才消耗下一次名额');
  // n_start 选错误选项直达结局（-10 分）
  const m0 = taskOps.moveAttempt(db, { token: tokenA, attemptNo: 1, optionId: 'o_rush_in', stepNo: 0 });
  ok('第 0 步有效选择', m0.ok);
  eq('到达结局', m0.ended, true);
  eq('本步 -10 分', m0.lastMove.score, -10);
  eq('累计 -10 分', m0.snapshot.totalScore, -10);
  // 已结束尝试继续 move
  const mEnd = taskOps.moveAttempt(db, { token: tokenA, attemptNo: 1, optionId: 'o_cut_power', stepNo: 1 });
  eq('已结束再 move → SESSION_ENDED', mEnd.errorCode, 'SESSION_ENDED');
  // 次数：结束后消耗第 1 次
  const afterEnd = taskOps.getMyTask(db, tokenA).view;
  eq('已用 1 次', afterEnd.attemptsUsed, 1);
  eq('进行中尝试已清空', afterEnd.activeAttemptNo, null);
  eq('最高已结束总分 -10', afterEnd.bestScore, -10);
  eq('未达及格分（及格 0）', afterEnd.passed, false);

  // 开始第 2 次
  const s2 = taskOps.startAttempt(db, tokenA);
  ok('结束后可开始第 2 次', s2.created && s2.attemptNo === 2);
  const code2 = s2.sessionCode;
  ok('两次尝试是不同会话', code2 !== code1);

  // 过期步号 / 非法选项（第 2 次尝试停在第 0 步）
  const mStale = taskOps.moveAttempt(db, { token: tokenA, attemptNo: 2, optionId: 'o_cut_power', stepNo: 3 });
  eq('用过期步号 → STEP_STALE', mStale.errorCode, 'STEP_STALE');
  const mBadOpt = taskOps.moveAttempt(db, { token: tokenA, attemptNo: 2, optionId: 'o_no_such', stepNo: 0 });
  eq('不存在选项 → OPTION_NOT_FOUND', mBadOpt.errorCode, 'OPTION_NOT_FOUND');
  // 失败不推进、不扣分
  eq('被拒后仍在第 0 步', taskOps.getAttempt(db, tokenA, 2).snapshot.stepNo, 0);

  // 走一条完整成功路径：cut_power → evac → report → meet，得分 3+4+3+0=10
  const pathA = [
    [0, 'o_cut_power'], [1, 'o_evac'], [2, 'o_report'], [3, 'o_meet'],
  ];
  let cur = s2.snapshot;
  for (const [step, opt] of pathA) {
    const r = taskOps.moveAttempt(db, { token: tokenA, attemptNo: 2, optionId: opt, stepNo: step });
    assert.ok(r.ok, `第 ${step} 步 ${opt} 应成功：${r.error}`);
    cur = r.snapshot;
  }
  eq('第 2 次到达结局', cur.status, 'ended');
  eq('成功路径总分 10', cur.totalScore, 10);
  const finalView = taskOps.getMyTask(db, tokenA).view;
  eq('已用满 2 次', finalView.attemptsUsed, 2);
  eq('剩余 0 次', finalView.attemptsLeft, 0);
  eq('最高已结束总分 10', finalView.bestScore, 10);
  eq('达到及格分', finalView.passed, true);

  // 次数耗尽：不能再开新尝试
  const exhausted = taskOps.startAttempt(db, tokenA);
  eq('次数耗尽 → ATTEMPTS_EXHAUSTED', exhausted.errorCode, 'ATTEMPTS_EXHAUSTED');
  eq('次数耗尽 409', exhausted.status, 409);
  eq('不多建尝试', db.prepare('SELECT COUNT(*) AS c FROM task_attempts WHERE task_code=? AND trainee_id=?')
    .get(task.code, finalView.trainee.id).c, 2);

  // 旧尝试仍可查看（只读）
  const oldGet = taskOps.getAttempt(db, tokenA, 1);
  ok('已结束旧尝试可查看', oldGet.ok && oldGet.attemptStatus === 'ended');
  const noActive = taskOps.getAttempt(db, tokenA);
  eq('无进行中尝试 get() → 404', noActive.status, 404);
  const badNo = taskOps.getAttempt(db, tokenA, 0);
  eq('attemptNo=0 非法', badNo.errorCode, 'ATTEMPT_NO_INVALID');

  // ---------- 6. 截止后：不能开新尝试，但可续做旧会话 ----------
  console.log('6) 截止控制：截止后不能新开，未结束旧尝试可续做');
  // 给李四开一个进行中尝试，走一步但不结束，然后把任务截止时间改到过去
  const b1 = taskOps.startAttempt(db, tokenB);
  ok('李四第 1 次开始', b1.created && b1.attemptNo === 1);
  const bm = taskOps.moveAttempt(db, { token: tokenB, attemptNo: 1, optionId: 'o_cut_power', stepNo: 0 });
  ok('李四走到第 1 步（未结束）', bm.ok && bm.snapshot.stepNo === 1);
  db.prepare('UPDATE training_tasks SET deadline_ms = ? WHERE code = ?').run(Date.now() - 1000, task.code);

  // 截止后重复“开始”：仍有进行中尝试 → 返回旧会话续做（不是新开，不报错）
  const bResumeStart = taskOps.startAttempt(db, tokenB);
  ok('截止后有进行中尝试时开始→续做旧会话', bResumeStart.ok && bResumeStart.resumed);
  eq('续做返回同一会话', bResumeStart.sessionCode, b1.sessionCode);
  eq('续做未多建尝试', bResumeStart.view.attemptsUsed, 1);
  // 旧尝试仍可续做
  const bResume = taskOps.getAttempt(db, tokenB, 1);
  ok('截止后仍可读取旧尝试', bResume.ok && bResume.snapshot.stepNo === 1);
  const bContinue = taskOps.moveAttempt(db, { token: tokenB, attemptNo: 1, optionId: 'o_tighten', stepNo: 1 });
  ok('截止后续做旧会话成功', bContinue.ok);
  eq('续做到结局', bContinue.ended, true);
  // 已结束后即使次数没用完，截止了也不能再开新尝试
  const bAfterEnd = taskOps.startAttempt(db, tokenB);
  eq('截止后旧尝试结束再开始 → TASK_DEADLINE_PASSED', bAfterEnd.errorCode, 'TASK_DEADLINE_PASSED');
  eq('截止新开 409', bAfterEnd.status, 409);
  eq('截止后未多建尝试', bAfterEnd.view.attemptsUsed, 1);

  // ---------- 7. 管理凭证报表 ----------
  console.log('7) 管理报表：各人尝试记录、最高已结束总分、是否及格');
  const rep = taskOps.getTaskReport(db, { code: task.code, hostToken: created.hostToken });
  ok('报表获取成功', rep.ok);
  eq('学员 2 人', rep.report.trainees.length, 2);
  const ra = rep.report.trainees.find((t) => t.name === '张三');
  const rb = rep.report.trainees.find((t) => t.name === '李四');
  eq('张三 2 次尝试', ra.attemptsUsed, 2);
  eq('张三最高分 10', ra.bestScore, 10);
  eq('张三及格', ra.passed, true);
  eq('张三第 1 次 -10', ra.attempts[0].totalScore, -10);
  eq('张三第 2 次 10', ra.attempts[1].totalScore, 10);
  eq('李四 1 次尝试', rb.attemptsUsed, 1);
  eq('李四最高分 -6（断电 +3、带压紧固 -9）', rb.bestScore, -6);
  eq('李四不及格', rb.passed, false);
  ok('报表含每次会话码与状态', ra.attempts.every((a) => a.sessionCode && a.status));

  // ---------- 8. 无已结束尝试时成绩为空 ----------
  console.log('8) 无已结束尝试：最高分为空（null）');
  const t2 = taskOps.createTask(db, {
    scenarioId, version: 1, deadlineMs: Date.now() + 3600_000,
    maxAttempts: 3, passScore: 5, trainees: ['王五'],
  });
  const tokenW = t2.trainees[0].token;
  taskOps.startAttempt(db, tokenW);
  const wView = taskOps.getMyTask(db, tokenW).view;
  eq('进行中但未结束：bestScore=null', wView.bestScore, null);
  eq('passed=null', wView.passed, null);
  eq('进行中尝试占用 1 个名额', wView.attemptsUsed, 1);
  eq('进行中尝试尚未消耗（endedCount=0）', wView.endedCount, 0);
  eq('剩余 2 次', wView.attemptsLeft, 2);
  const wRep = taskOps.getTaskReport(db, { code: t2.task.code, hostToken: t2.hostToken }).report;
  eq('报表中王五 bestScore=null', wRep.trainees[0].bestScore, null);
  eq('报表中王五 passed=null', wRep.trainees[0].passed, null);
  eq('进行中尝试号=1', wRep.trainees[0].activeAttemptNo, 1);

  // ---------- 9. 并发重复开始不多建会话/不多扣次数 ----------
  console.log('9) 并发重复开始：只有一个会话，不多扣次数');
  const t3 = taskOps.createTask(db, {
    scenarioId, version: 1, deadlineMs: Date.now() + 3600_000,
    maxAttempts: 1, passScore: 0, trainees: ['赵六'],
  });
  const tokenZ = t3.trainees[0].token;
  const results = [0, 1, 2, 3, 4].map(() => taskOps.startAttempt(db, tokenZ));
  const codes = new Set(results.map((r) => r.sessionCode));
  eq('5 次并发/重复开始只产生 1 个会话', codes.size, 1);
  eq('只有第 1 次是新建', results.filter((r) => r.created).length, 1);
  const zRows = db.prepare('SELECT COUNT(*) AS c FROM task_attempts WHERE task_code=?')
    .get(t3.task.code).c;
  eq('数据库只有 1 条尝试', zRows, 1);
  eq('进行中尝试号=1', results[0].view.activeAttemptNo || taskOps.getMyTask(db, tokenZ).view.activeAttemptNo, 1);

  // ---------- 10. 任务会话绕过普通入口 ----------
  console.log('10) 普通会话入口不得绕过任务权限/次数');
  const zCode = results[0].sessionCode;
  const zSession = db.prepare('SELECT * FROM sessions WHERE code=?').get(zCode);
  eq('会话带 task_code 标记', zSession.task_code, t3.task.code);
  // 任务会话不出现在普通会话列表
  const { computeTotalScore } = require('../server/session');
  const listRow = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE task_code IS NULL AND code = ?').get(zCode).c;
  eq('任务会话被普通列表查询排除', listRow, 0);
  // performMove 普通通道拒绝任务会话
  const { performMove } = require('../server/session');
  const soloMove = performMove(db, { code: zCode, optionId: 'o_cut_power', stepNo: 0 });
  eq('普通单人 move → TASK_SOLO_MOVE_FORBIDDEN', soloMove.errorCode, 'TASK_SOLO_MOVE_FORBIDDEN');
  // 复盘分叉拒绝任务会话
  const { forkSession } = require('../server/session');
  const frk = forkSession(db, { sourceCode: zCode, forkStepNo: 0, observedStepNo: 0, newCode: 'fffffffff0' });
  eq('任务会话 fork → TASK_FORK_FORBIDDEN', frk.errorCode, 'TASK_FORK_FORBIDDEN');
  // 房间共享会话规则不受影响（回归）
  const room = require('../server/room').createRoom(db, { scenarioId, version: 1 });
  ok('房间仍可创建（回归）', room.ok);
  const roomMove = performMove(db, { code: room.room.session_code, optionId: 'o_cut_power', stepNo: 0 });
  eq('房间会话普通 move 仍被拒（回归 ROOM_SOLO_MOVE_FORBIDDEN）', roomMove.errorCode, 'ROOM_SOLO_MOVE_FORBIDDEN');

  console.log(`\n全部通过：${passed} 项断言。临时库：${dbPath}`);
  process.exit(0);
})().catch((e) => {
  console.error('❌ 测试失败：', e);
  process.exit(1);
});
