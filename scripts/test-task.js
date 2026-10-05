'use strict';

// 训练任务端到端验证（临时库 + 真实 HTTP 服务，不写正式数据）：
//   node scripts/test-task.js
//
// 覆盖：
//  1. 建任务配置校验：截止时间不晚于当前/非法、次数非正整数、及格分非整数、名单为空、
//     姓名重复（含去空白后重复）、情境/版本不存在 —— 全部整次拒绝，任务数不增；
//  2. 合法建任务：返回管理凭证与各学员独立参与凭证；公开元信息不含任何凭证；
//  3. 学员开始/续做：新尝试 201；有未结束尝试重复开始返回原会话（200，同一会话码，不多扣次数）；
//     结束后才消耗下一次；次数耗尽 409 TASK_ATTEMPTS_EXHAUSTED；
//  4. 截止后不能开新尝试（TASK_DEADLINE_PASSED）但可续做未结束旧会话；
//  5. 任务会话只能凭本人凭证查看/操作：普通会话列表不出现任务会话；普通会话入口
//     （查询/推进/分叉/对照）无凭证一律拒绝；任务入口推进沿用冻结版本的步号与计分规则；
//  6. 管理视图：各人尝试记录、最高已结束总分、是否及格；无已结束尝试成绩为空；
//  7. 并发重复开始：并行多个开始请求只建一条会话、只扣一次；
//  8. 既有普通演练用法不受影响；任务绑定冻结版本（发布新版本不影响任务）。

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-http-'));
const dbPath = path.join(tmpDir, 'test.db');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

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

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* 非 JSON */ }
  return { status: res.status, data };
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch (_) { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('服务启动超时');
}

(async () => {
  const child = spawn(process.execPath, ['server/server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  try {
    await waitReady();
    console.log('0) 服务已启动（临时库）');

    // ---------- 1. 建任务配置校验：非法配置整次拒绝 ----------
    console.log('1) 建任务：非法配置整次拒绝，任务数不增');
    const pub = await req('GET', '/api/published');
    const scenarioId = pub.data[0].id;
    const future = Date.now() + 3600 * 1000;
    const base = { scenarioId, version: 1, deadline: future, maxAttempts: 2, passScore: 5, trainees: ['张三', '李四'] };

    const badCases = [
      ['截止时间早于当前', { ...base, deadline: Date.now() - 1000 }, 'TASK_DEADLINE_INVALID'],
      ['截止时间非法字符串', { ...base, deadline: '不是时间' }, 'TASK_DEADLINE_INVALID'],
      ['截止时间为 null', { ...base, deadline: null }, 'TASK_DEADLINE_INVALID'],
      ['次数为 0', { ...base, maxAttempts: 0 }, 'TASK_MAX_ATTEMPTS_INVALID'],
      ['次数为负', { ...base, maxAttempts: -2 }, 'TASK_MAX_ATTEMPTS_INVALID'],
      ['次数非整数', { ...base, maxAttempts: 1.5 }, 'TASK_MAX_ATTEMPTS_INVALID'],
      ['次数为字符串', { ...base, maxAttempts: '3' }, 'TASK_MAX_ATTEMPTS_INVALID'],
      ['及格分非整数', { ...base, passScore: 4.5 }, 'TASK_PASS_SCORE_INVALID'],
      ['及格分为字符串', { ...base, passScore: '10' }, 'TASK_PASS_SCORE_INVALID'],
      ['名单为空数组', { ...base, trainees: [] }, 'TASK_TRAINEES_INVALID'],
      ['名单非数组', { ...base, trainees: '张三' }, 'TASK_TRAINEES_INVALID'],
      ['名单含空姓名', { ...base, trainees: ['张三', '  '] }, 'TASK_TRAINEES_INVALID'],
      ['名单含非文本', { ...base, trainees: ['张三', 42] }, 'TASK_TRAINEES_INVALID'],
      ['姓名重复', { ...base, trainees: ['张三', '李四', '张三'] }, 'TASK_TRAINEE_DUPLICATE'],
      ['去空白后姓名重复', { ...base, trainees: ['张三', ' 张三 '] }, 'TASK_TRAINEE_DUPLICATE'],
      ['版本号非法', { ...base, version: 0 }, 'VERSION_INVALID'],
    ];
    for (const [name, body, code] of badCases) {
      const r = await req('POST', '/api/tasks', body);
      eq(`拒绝：${name}（400）`, r.status, 400);
      eq(`拒绝：${name}（${code}）`, r.data.errorCode, code);
    }
    const nf = await req('POST', '/api/tasks', { ...base, scenarioId: 'sc_nope' });
    eq('拒绝：情境不存在（404）', nf.status, 404);
    eq('拒绝：情境不存在（SCENARIO_NOT_FOUND）', nf.data.errorCode, 'SCENARIO_NOT_FOUND');
    const nv = await req('POST', '/api/tasks', { ...base, version: 99 });
    eq('拒绝：版本不存在（404 VERSION_NOT_FOUND）', nv.data.errorCode, 'VERSION_NOT_FOUND');
    const tasks0 = await req('GET', '/api/tasks');
    eq('非法配置均未建任务', tasks0.data.length, 0);

    // ---------- 2. 合法建任务 ----------
    console.log('2) 合法建任务：管理凭证 + 各学员独立参与凭证');
    const created = await req('POST', '/api/tasks', base);
    eq('建任务 201', created.status, 201);
    ok('返回任务编号', /^[0-9a-f]{10}$/.test(created.data.taskId));
    ok('返回管理凭证 adm_…', created.data.adminToken.startsWith('adm_'));
    eq('两名学员各得凭证', created.data.trainees.length, 2);
    ok('凭证互不相同且为 ptk_…', created.data.trainees.every((t) => t.token.startsWith('ptk_'))
      && created.data.trainees[0].token !== created.data.trainees[1].token);
    eq('绑定冻结版本 v1', created.data.version, 1);
    eq('次数/及格分落库', `${created.data.maxAttempts}/${created.data.passScore}`, '2/5');
    const taskId = created.data.taskId;
    const adminToken = created.data.adminToken;
    const tkA = created.data.trainees.find((t) => t.name === '张三').token;
    const tkB = created.data.trainees.find((t) => t.name === '李四').token;

    const meta = await req('GET', `/api/tasks/${taskId}`);
    eq('公开元信息 200', meta.status, 200);
    ok('公开元信息不含管理凭证', !('adminToken' in meta.data.task) && !('admin_token' in meta.data.task));
    ok('公开元信息不含学员凭证', !('trainees' in meta.data.task));
    eq('公开元信息未截止', meta.data.task.expired, false);

    const listRow = (await req('GET', '/api/tasks')).data.find((t) => t.id === taskId);
    ok('任务列表含元信息', !!listRow && listRow.trainee_count === 2 && listRow.attempt_count === 0);
    ok('任务列表不含凭证', !('admin_token' in listRow));

    // ---------- 3. 开始 / 续做 / 计次 ----------
    console.log('3) 学员开始/续做：重复开始返回原会话，结束后才消耗下一次');
    const badTok = await req('POST', `/api/tasks/${taskId}/start`, { token: 'ptk_nope' });
    eq('无效参与凭证 401', badTok.status, 401);
    eq('无效参与凭证 TASK_TOKEN_INVALID', badTok.data.errorCode, 'TASK_TOKEN_INVALID');

    const s1 = await req('POST', `/api/tasks/${taskId}/start`, { token: tkA });
    eq('张三首次开始 201', s1.status, 201);
    eq('第 1 次尝试', s1.data.attemptNo, 1);
    eq('已用 1 次', s1.data.attemptsUsed, 1);
    const code1 = s1.data.session.code;
    eq('会话标记为任务会话', s1.data.session.taskId, taskId);

    const s1b = await req('POST', `/api/tasks/${taskId}/start`, { token: tkA });
    eq('有未结束尝试：重复开始 200', s1b.status, 200);
    eq('返回原会话（不多建）', s1b.data.session.code, code1);
    eq('resumed=true', s1b.data.resumed, true);
    eq('不多扣次数（仍用 1 次）', s1b.data.attemptsUsed, 1);

    // 普通会话列表与入口不得绕过权限
    const normalList = await req('GET', '/api/sessions');
    ok('普通会话列表不含任务会话', !normalList.data.some((s) => s.code === code1));
    const noTok = await req('GET', `/api/sessions/${code1}`);
    eq('普通入口查任务会话无凭证 401', noTok.status, 401);
    eq('错误码 TASK_TOKEN_INVALID', noTok.data.errorCode, 'TASK_TOKEN_INVALID');
    const wrongTok = await req('GET', `/api/sessions/${code1}?token=${tkB}`);
    eq('他人凭证也不能看 401', wrongTok.status, 401);
    const withTok = await req('GET', `/api/sessions/${code1}?token=${tkA}`);
    eq('本人凭证可查 200', withTok.status, 200);
    const linNoTok = await req('GET', `/api/sessions/${code1}/lineage`);
    eq('家族对照无凭证 401', linNoTok.status, 401);
    const mvNoTok = await req('POST', `/api/sessions/${code1}/move`, { optionId: 'o_cut_power', stepNo: 0 });
    eq('普通入口推任务会话无凭证 401', mvNoTok.status, 401);
    const mvTok = await req('POST', `/api/sessions/${code1}/move`, { optionId: 'o_cut_power', stepNo: 0, token: tkA });
    eq('普通入口+本人凭证可推进 200', mvTok.status, 200);
    eq('沿冻结版本计分（断电 +3）', mvTok.data.lastMove.score, 3);
    const forkTask = await req('POST', `/api/sessions/${code1}/fork`, { forkStepNo: 0, observedStepNo: 1 });
    eq('任务会话不得分叉 409', forkTask.status, 409);
    eq('TASK_SESSION_FORK_FORBIDDEN', forkTask.data.errorCode, 'TASK_SESSION_FORK_FORBIDDEN');

    // 任务入口推进（沿冻结版本步号/计分）
    const stale = await req('POST', `/api/tasks/${taskId}/move`, { token: tkA, optionId: 'o_evac', stepNo: 0 });
    eq('任务入口步号过期 409 STEP_STALE', stale.status, 409);
    eq('STEP_STALE', stale.data.errorCode, 'STEP_STALE');
    const m2 = await req('POST', `/api/tasks/${taskId}/move`, { token: tkA, optionId: 'o_evac', stepNo: 1 });
    eq('任务入口推进第 2 步', m2.status, 200);
    const m3 = await req('POST', `/api/tasks/${taskId}/move`, { token: tkA, optionId: 'o_report', stepNo: 2 });
    eq('任务入口推进第 3 步', m3.status, 200);
    const m4 = await req('POST', `/api/tasks/${taskId}/move`, { token: tkA, optionId: 'o_meet', stepNo: 3 });
    eq('到达结局，会话结束', m4.data.status, 'ended');
    eq('第 1 次尝试总分 10', m4.data.totalScore, 10);

    // 结束后才开始下一次并消耗次数
    const s2 = await req('POST', `/api/tasks/${taskId}/start`, { token: tkA });
    eq('结束后开始第 2 次 201', s2.status, 201);
    eq('第 2 次尝试', s2.data.attemptNo, 2);
    ok('新会话码不同', s2.data.session.code !== code1);
    const s2b = await req('POST', `/api/tasks/${taskId}/start`, { token: tkA });
    eq('第 2 次进行中重复开始仍返回原会话', s2b.data.session.code, s2.data.session.code);
    eq('仍只消耗 2 次', s2b.data.attemptsUsed, 2);
    const bad = await req('POST', `/api/tasks/${taskId}/move`, { token: tkA, optionId: 'o_rush_in', stepNo: 0 });
    eq('第 2 次以坏结局结束（-10）', bad.data.totalScore, -10);
    const s3 = await req('POST', `/api/tasks/${taskId}/start`, { token: tkA });
    eq('次数耗尽 409', s3.status, 409);
    eq('TASK_ATTEMPTS_EXHAUSTED', s3.data.errorCode, 'TASK_ATTEMPTS_EXHAUSTED');
    const mvNone = await req('POST', `/api/tasks/${taskId}/move`, { token: tkA, optionId: 'o_cut_power', stepNo: 0 });
    eq('无进行中尝试时推进 409 TASK_NO_ACTIVE_ATTEMPT', mvNone.data.errorCode, 'TASK_NO_ACTIVE_ATTEMPT');

    // ---------- 4. 截止后：不能开新尝试，可续做旧会话 ----------
    console.log('4) 截止后不能开新尝试，但可续做未结束旧会话');
    const sB = await req('POST', `/api/tasks/${taskId}/start`, { token: tkB });
    eq('李四开始第 1 次 201', sB.status, 201);
    const codeB = sB.data.session.code;
    // 直接把库里的截止时间改到过去（模拟时间流逝；服务无需重启）
    const { open } = require('../server/db');
    const dbw = open(dbPath);
    dbw.prepare('UPDATE tasks SET deadline_ms = ? WHERE id = ?').run(Date.now() - 1000, taskId);
    dbw.close();
    const sB2 = await req('POST', `/api/tasks/${taskId}/start`, { token: tkB });
    eq('截止后续做旧会话 200', sB2.status, 200);
    eq('仍是原会话', sB2.data.session.code, codeB);
    const endB = await req('POST', `/api/tasks/${taskId}/move`, { token: tkB, optionId: 'o_rush_in', stepNo: 0 });
    eq('李四旧会话截止后仍可推进至结束', endB.data.status, 'ended');
    const sB3 = await req('POST', `/api/tasks/${taskId}/start`, { token: tkB });
    eq('截止后开新尝试 409', sB3.status, 409);
    eq('TASK_DEADLINE_PASSED', sB3.data.errorCode, 'TASK_DEADLINE_PASSED');

    // ---------- 5. 管理视图 ----------
    console.log('5) 管理凭证查看成绩：最高已结束总分与及格判定；无已结束尝试成绩为空');
    const badAdm = await req('GET', `/api/tasks/${taskId}/manage?token=adm_nope`);
    eq('无效管理凭证 401', badAdm.status, 401);
    eq('TASK_ADMIN_TOKEN_INVALID', badAdm.data.errorCode, 'TASK_ADMIN_TOKEN_INVALID');
    const mg = await req('GET', `/api/tasks/${taskId}/manage?token=${adminToken}`);
    eq('管理视图 200', mg.status, 200);
    const za = mg.data.trainees.find((t) => t.name === '张三');
    const li = mg.data.trainees.find((t) => t.name === '李四');
    eq('张三已用 2 次', za.attemptsUsed, 2);
    eq('张三最高已结束总分 10（max(10,-10)）', za.bestScore, 10);
    eq('张三已及格（10>=5）', za.passed, true);
    eq('张三两次尝试记录齐全', za.attempts.length, 2);
    eq('李四最高已结束总分 -10', li.bestScore, -10);
    eq('李四未及格（-10<5）', li.passed, false);
    eq('汇总：2 人都已开始', mg.data.summary.startedCount, 2);
    eq('汇总：1 人及格', mg.data.summary.passedCount, 1);
    eq('汇总：共 3 次尝试', mg.data.summary.attemptsTotal, 3);

    // 无已结束尝试 → 成绩为空
    const c2 = await req('POST', '/api/tasks', { ...base, deadline: Date.now() + 3600e3, trainees: ['王五'] });
    const tkC = c2.data.trainees[0].token;
    await req('POST', `/api/tasks/${c2.data.taskId}/start`, { token: tkC }); // 开始但不结束
    const mg2 = await req('GET', `/api/tasks/${c2.data.taskId}/manage?token=${c2.data.adminToken}`);
    const w5 = mg2.data.trainees[0];
    eq('进行中尝试不计入成绩：bestScore=null', w5.bestScore, null);
    eq('passed=null（成绩为空）', w5.passed, null);
    eq('进行中标出第 1 次', w5.activeAttemptNo, 1);

    // ---------- 6. 并发重复开始 ----------
    console.log('6) 并发重复开始：只建一条会话、只扣一次');
    const par = await Promise.all(Array.from({ length: 6 }, () =>
      req('POST', `/api/tasks/${c2.data.taskId}/start`, { token: tkC })));
    ok('并发开始全部成功', par.every((r) => r.status === 200 || r.status === 201));
    const codes = new Set(par.map((r) => r.data.session.code));
    eq('并发开始只产生一条会话', codes.size, 1);
    ok('并发开始至多一次 201', par.filter((r) => r.status === 201).length <= 1);
    const mine = await req('GET', `/api/tasks/${c2.data.taskId}/my?token=${tkC}`);
    eq('仍只消耗 1 次', mine.data.attemptsUsed, 1);

    // ---------- 7. 冻结版本与旧用法兼容 ----------
    console.log('7) 任务绑定冻结版本；普通演练用法不受影响');
    // 发布 v2（改分），任务仍按 v1 推进
    const scDetail = await req('GET', `/api/scenarios/${scenarioId}`);
    const draft = scDetail.data.draft;
    draft.nodes[0].options[0].score = 9; // v2 把断电改为 9 分
    await req('PUT', `/api/scenarios/${scenarioId}/draft`, draft);
    const pub2 = await req('POST', `/api/scenarios/${scenarioId}/publish`);
    eq('已发布 v2', pub2.data.publishedVersion, 2);
    const c3 = await req('POST', '/api/tasks', { scenarioId, deadline: Date.now() + 3600e3, maxAttempts: 1, passScore: 0, trainees: ['赵六'] });
    eq('缺省版本取最新发布版 v2', c3.data.version, 2);
    const tkD = c3.data.trainees[0].token;
    const sD = await req('POST', `/api/tasks/${c3.data.taskId}/start`, { token: tkD });
    eq('新任务会话绑定 v2', sD.data.session.version, 2);
    const mvD = await req('POST', `/api/tasks/${c3.data.taskId}/move`, { token: tkD, optionId: 'o_cut_power', stepNo: 0 });
    eq('v2 规则计分（断电 +9）', mvD.data.lastMove.score, 9);
    // 旧任务（绑定 v1）的进行中会话仍按 v1 计分
    const mineB = await req('GET', `/api/tasks/${taskId}/my?token=${tkB}`);
    eq('旧任务会话仍是 v1', mineB.data.attempts[0] && mineB.data.task.version, 1);

    // 普通演练：开始/列表/推进完全照旧（无需任何凭证）
    const ns = await req('POST', '/api/sessions', { scenarioId, traineeName: '普通学员' });
    eq('普通会话开始 201', ns.status, 201);
    eq('普通会话绑定最新版 v2', ns.data.version, 2);
    const nl = await req('GET', '/api/sessions');
    ok('普通会话出现在列表', nl.data.some((s) => s.code === ns.data.code));
    const nm = await req('POST', `/api/sessions/${ns.data.code}/move`, { optionId: 'o_cut_power', stepNo: 0 });
    eq('普通会话推进 200', nm.status, 200);
    const roomSolo = await req('POST', `/api/sessions/${ns.data.code}/fork`, { forkStepNo: 0, observedStepNo: 1 });
    eq('普通会话仍可分叉 201', roomSolo.status, 201);

    console.log(`\n全部通过：${passed} 项断言。临时库：${dbPath}`);
    child.kill();
    process.exit(0);
  } catch (e) {
    console.error('❌ 测试失败：', e);
    child.kill();
    process.exit(1);
  }
})();
