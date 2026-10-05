'use strict';

const path = require('path');
const express = require('express');

const { open, newId, newSessionCode } = require('./db');
const { seed } = require('./seed');
const {
  normalizeDraft,
  analyze,
  witnessPath,
  findBadContinuation,
  formatPathReport,
  formatStateValues,
  initialMask,
  decodeKey,
} = require('./scenario');
const { buildSnapshot, performMove, forkSession, loadLineage, computeTotalScore } = require('./session');
const { buildCoverageReport } = require('./coverage');
const roomOps = require('./room');
const taskOps = require('./task');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');

const db = open(DB_PATH);
seed(db);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 限时房间：到期补办 ----------
// 纯由 room_steps 中持久化的截止时间驱动：服务重启后先补办一次，之后周期扫描，
// 因此即使无人访问页面、或服务在到点时刻离线，恢复后也会自动结算/暂停，不会漏办。
function runDueSweep() {
  try {
    const r = roomOps.sweepDueRooms(db);
    if (r.autoSettled || r.awaiting) {
      console.log(`[限时房间] 到期补办：自动结算 ${r.autoSettled} 步，零票暂停 ${r.awaiting} 步`);
    }
  } catch (e) {
    console.error('[限时房间] 周期补办失败：', e);
  }
}
setImmediate(runDueSweep);
setInterval(runDueSweep, 2000).unref();

// ---------- 培训师：情境管理 ----------
// 对循环包含的边做“旋转无关”的规范化，用于同一环去重
function canonicalCycle(cycleSegs) {
  const edges = cycleSegs.map((s) => `${s.optionId}:${s.toKey}`);
  let best = edges.join('|');
  for (let i = 1; i < edges.length; i++) {
    const rot = edges.slice(i).concat(edges.slice(0, i)).join('|');
    if (rot < best) best = rot;
  }
  return best;
}

function buildPublishReport(scenario) {
  const graph = analyze(scenario);
  const problems = [];
  const warnings = [];

  for (const key of graph.deadEnds) {
    const { nodeId, mask } = decodeKey(key);
    const node = scenario.nodes.find((n) => n.id === nodeId);
    const segs = witnessPath(graph, key);
    problems.push({
      kind: 'DEAD_END',
      message: `非结局节点「${node ? node.title : nodeId}」在某条可达路径下没有任何可选项（无路可走）`,
      vertex: {
        nodeId,
        nodeTitle: node ? node.title : nodeId,
        states: formatStateValues(scenario, mask),
      },
      reproduciblePath: formatPathReport(scenario, segs),
    });
  }

  // doomed 中排除已经作为死路报告的顶点（死路必然 doomed），只额外报告“可无限循环”的。
  // 同一个环上的多个顶点会产生重复报告：按循环包含的边去重，每个唯一循环只保留
  // 到达路径最短的一份可复现报告。
  const loopEntries = [];
  for (const key of graph.doomed) {
    if (graph.deadEnds.includes(key)) continue;
    const { nodeId, mask } = decodeKey(key);
    const node = scenario.nodes.find((n) => n.id === nodeId);
    const segs = witnessPath(graph, key);
    const cont = findBadContinuation(graph, key);
    loopEntries.push({ key, nodeId, mask, node, segs, cont });
  }
  const byCycle = new Map();
  for (const entry of loopEntries) {
    const cycleId = entry.cont ? canonicalCycle(entry.cont.cycle) : `noncycle:${entry.key}`;
    const prev = byCycle.get(cycleId);
    if (!prev || entry.segs.length < prev.segs.length) byCycle.set(cycleId, entry);
  }

  for (const entry of byCycle.values()) {
    const { nodeId, mask, node, segs, cont } = entry;
    const lines = formatPathReport(scenario, segs);
    const loopLines = cont ? formatPathReport(scenario, cont.cycle) : [];
    problems.push({
      kind: 'INFINITE_LOOP',
      message: `从节点「${node ? node.title : nodeId}」出发存在可无限循环而不抵达结局的路径`,
      vertex: {
        nodeId,
        nodeTitle: node ? node.title : nodeId,
        states: formatStateValues(scenario, mask),
      },
      reproduciblePath: lines,
      cycle: loopLines,
      hint: cont ? '沿上述路径到达该节点后，重复执行“循环”段中列出的选择即可永不抵达结局。'
                  : '该顶点无法保证抵达结局。',
    });
  }

  for (const nodeId of graph.unreachableNodeIds) {
    const node = scenario.nodes.find((n) => n.id === nodeId);
    warnings.push({
      kind: 'UNREACHABLE_NODE',
      message: `节点「${node ? node.title : nodeId}」从初态不可到达（不影响发布，但通常是编排问题）`,
      nodeId,
    });
  }

  return { ok: problems.length === 0, problems, warnings };
}

// ---------- 健康检查 ----------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------- 培训师：情境管理 ----------

// 情境列表
app.get('/api/scenarios', (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.title, s.current_version, s.created_at, s.updated_at,
           (SELECT COUNT(*) FROM sessions WHERE sessions.scenario_id = s.id) AS session_count
      FROM scenarios s
     ORDER BY s.updated_at DESC
  `).all();
  res.json(rows);
});

// 情境详情（含草稿与版本清单）
app.get('/api/scenarios/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '情境不存在' });
  const versions = db.prepare('SELECT version, created_at FROM versions WHERE scenario_id = ? ORDER BY version DESC').all(row.id);
  res.json({
    id: row.id,
    title: row.title,
    draft: row.draft ? JSON.parse(row.draft) : null,
    currentVersion: row.current_version,
    versions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

// 新建情境（保存第一版草稿；结构不合法直接拒绝）
app.post('/api/scenarios', (req, res) => {
  const { ok, scenario, errors } = normalizeDraft(req.body);
  if (!ok) return res.status(400).json({ error: '草稿校验失败，未保存', errors });
  const id = newId('sc');
  db.prepare(`INSERT INTO scenarios (id, title, draft, current_version) VALUES (?, ?, ?, 0)`)
    .run(id, scenario.title, JSON.stringify(scenario));
  res.status(201).json({ id, draft: scenario, currentVersion: 0 });
});

// 保存草稿（结构校验，拒绝无效引用/矛盾条件）
app.put('/api/scenarios/:id/draft', (req, res) => {
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '情境不存在' });
  const { ok, scenario, errors } = normalizeDraft(req.body);
  if (!ok) return res.status(400).json({ error: '草稿校验失败，未保存', errors });
  db.prepare(`UPDATE scenarios SET title = ?, draft = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(scenario.title, JSON.stringify(scenario), row.id);
  // 附带发布前分析结果（仅提示，不阻断保存）
  const report = buildPublishReport(scenario);
  res.json({ ok: true, title: scenario.title, publishReport: report });
});

// 草稿试分析（不保存、不发布）
app.post('/api/scenarios/:id/analyze', (req, res) => {
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '情境不存在' });
  let draft;
  if (req.body && req.body.draft !== undefined) {
    const r = normalizeDraft(req.body.draft);
    if (!r.ok) return res.status(400).json({ error: '草稿校验失败', errors: r.errors });
    draft = r.scenario;
  } else {
    draft = row.draft ? JSON.parse(row.draft) : null;
    if (!draft) return res.status(400).json({ error: '尚无草稿可分析' });
  }
  res.json(buildPublishReport(draft));
});

// 发布：运行完整分析，有问题则拒绝；通过则冻结新版本
app.post('/api/scenarios/:id/publish', (req, res) => {
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '情境不存在' });
  if (!row.draft) return res.status(400).json({ error: '尚无草稿，无法发布' });
  const draft = JSON.parse(row.draft);

  // 发布前再跑一次结构校验（双保险）
  const normalized = normalizeDraft(draft);
  if (!normalized.ok) {
    return res.status(400).json({ error: '草稿存在结构性错误，拒绝发布', errors: normalized.errors });
  }
  const scenario = normalized.scenario;
  const report = buildPublishReport(scenario);
  if (!report.ok) {
    return res.status(422).json({ error: '发布检查未通过：存在无路可走的节点或可无限循环的路径，已拒绝发布', ...report });
  }

  const nextVersion = row.current_version + 1;
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO versions (scenario_id, version, content) VALUES (?, ?, ?)`)
      .run(row.id, nextVersion, JSON.stringify(scenario));
    db.prepare(`UPDATE scenarios SET title = ?, current_version = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(scenario.title, nextVersion, row.id);
  });
  tx();
  res.status(201).json({
    ok: true,
    publishedVersion: nextVersion,
    warnings: report.warnings,
    note: '内容已冻结；进行中的会话继续沿旧版本进行，新会话使用本版本。',
  });
});

// ---------- 学员：版本与会话 ----------

// 任务会话访问守卫：会话属于训练任务时，必须出示该学员的个人参与凭证
// （query 参数 token、请求体 token 或 x-task-token 请求头）。
function taskSessionAllowed(req, session) {
  if (!session.task_id) return true;
  const token = req.query.token || (req.body && req.body.token) || req.get('x-task-token');
  if (!token) return false;
  const trainee = db.prepare('SELECT token FROM task_trainees WHERE id = ?').get(session.task_trainee_id);
  return !!trainee && trainee.token === token;
}

// 学员可见的已发布情境
app.get('/api/published', (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.title, s.current_version, v.created_at AS published_at
      FROM scenarios s
      JOIN versions v ON v.scenario_id = s.id AND v.version = s.current_version
     WHERE s.current_version > 0
     ORDER BY v.created_at DESC
  `).all();
  res.json(rows);
});

// 查看某已发布版本的冻结内容（供会话卡片展示，不暴露全部结构也无妨，这里给学员用）
app.get('/api/scenarios/:id/versions/:version', (req, res) => {
  const row = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(req.params.id, parseInt(req.params.version, 10));
  if (!row) return res.status(404).json({ error: '版本不存在' });
  res.json(JSON.parse(row.content));
});

// 开始新会话：绑定最新发布版
app.post('/api/sessions', (req, res) => {
  const { scenarioId, traineeName } = req.body || {};
  if (!scenarioId) return res.status(400).json({ error: '缺少 scenarioId' });
  const sc = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId);
  if (!sc) return res.status(404).json({ error: '情境不存在' });
  if (sc.current_version < 1) return res.status(400).json({ error: '该情境尚未发布，无法开始演练' });
  const versionRow = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(sc.id, sc.current_version);
  const content = JSON.parse(versionRow.content);

  const code = newSessionCode();
  db.prepare(`
    INSERT INTO sessions (code, scenario_id, version, current_node_id, state_mask, step_no, status, trainee_name, root_code)
    VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?)
  `).run(code, sc.id, sc.current_version, content.startNodeId, initialMask(content),
    typeof traineeName === 'string' && traineeName.trim() ? traineeName.trim().slice(0, 100) : null,
    code);

  const session = db.prepare('SELECT * FROM sessions WHERE code = ?').get(code);
  res.status(201).json(buildSnapshot(content, session, sc.id, sc.current_version));
});

// 会话列表（便于恢复；总分按各自绑定版本的冻结规则与已完成路径实时计算）
// 训练任务的尝试会话不在普通列表出现（只能凭本人参与凭证经任务入口访问），
// 防止普通列表/入口绕过任务权限与次数限制。
app.get('/api/sessions', (req, res) => {
  const rows = db.prepare(`
    SELECT se.code, se.scenario_id, s.title AS scenario_title, se.version, se.status,
           se.step_no, se.trainee_name, se.current_node_id, se.created_at, se.updated_at,
           se.parent_code, se.fork_step_no, se.root_code, se.room_code, se.path
      FROM sessions se JOIN scenarios s ON s.id = se.scenario_id
     WHERE se.task_id IS NULL
     ORDER BY se.updated_at DESC LIMIT 200
  `).all();
  const contentCache = new Map();
  const contentFor = (scenarioId, version) => {
    const key = `${scenarioId}|${version}`;
    if (!contentCache.has(key)) {
      const r = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
        .get(scenarioId, version);
      contentCache.set(key, r ? JSON.parse(r.content) : null);
    }
    return contentCache.get(key);
  };
  res.json(rows.map((se) => {
    const { path, ...rest } = se;
    let content;
    try {
      content = contentFor(se.scenario_id, se.version);
    } catch (_) { content = null; }
    let totalScore = 0;
    try { totalScore = content ? computeTotalScore(content, JSON.parse(path || '[]')) : 0; } catch (_) { totalScore = 0; }
    return { ...rest, total_score: totalScore };
  }));
});

// 查询会话现状。任务会话（属于训练任务的某次尝试）必须出示本人参与凭证
// （query 参数 token 或 x-task-token 请求头），否则 401 且不返回任何会话信息。
app.get('/api/sessions/:code', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE code = ?').get(req.params.code);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  if (!taskSessionAllowed(req, session)) {
    return res.status(401).json({
      error: '该会话属于训练任务，只能凭本人参与凭证查看（请经任务入口访问）',
      errorCode: 'TASK_TOKEN_INVALID',
    });
  }
  const versionRow = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(session.scenario_id, session.version);
  if (!versionRow) return res.status(500).json({ error: '版本内容缺失' });
  const content = JSON.parse(versionRow.content);
  const sc = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(session.scenario_id);
  res.json({
    ...buildSnapshot(content, session, session.scenario_id, session.version),
    scenarioTitle: sc ? sc.title : null,
  });
});

// 执行一步选择（携带当前步号）。任务会话须在请求体携带本人参与凭证 token。
app.post('/api/sessions/:code/move', (req, res) => {
  const { optionId, stepNo, traineeName, token } = req.body || {};
  if (typeof optionId !== 'string') return res.status(400).json({ error: '缺少 optionId' });
  if (!Number.isInteger(stepNo)) return res.status(400).json({ error: '缺少或非法的 stepNo（必须为整数）' });

  const result = performMove(db, { code: req.params.code, optionId, stepNo, traineeName, taskToken: token || null });
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      errorCode: result.errorCode,
      current: result.current || null,
    });
  }
  const sc = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(result.session.scenario_id);
  const snapshot = buildSnapshot(result.content, result.session, result.session.scenario_id, result.session.version);
  // 本次有效选择的得分与说明（过期/重复/条件不符不会走到这里，故不改变成绩）
  const last = snapshot.path.find((p) => p.step === result.session.step_no) || null;
  res.json({
    ok: true,
    ...snapshot,
    scenarioTitle: sc ? sc.title : null,
    lastMove: last ? {
      step: last.step,
      optionId: last.optionId,
      optionLabel: last.optionLabel,
      score: last.score,
      scoreNote: last.scoreNote,
      totalScore: snapshot.totalScore,
    } : null,
  });
});

// ---------- 培训师复盘：从历史局面分叉 ----------

// 创建分支：{forkStepNo, observedStepNo, traineeName?}
// 成功返回分支会话快照（沿用源绑定版本，步号重置为分歧步号）；
// 源步号已变化/分歧点越界/结局步/会话或版本不存在时返回原因，
// 能定位源会话时一并返回其当前步号（sourceCurrent.stepNo），且不创建分支。
app.post('/api/sessions/:code/fork', (req, res) => {
  const { forkStepNo, observedStepNo, traineeName } = req.body || {};
  if (!Number.isInteger(forkStepNo)) {
    return res.status(400).json({ error: '缺少或非法的 forkStepNo（分歧步号必须为非负整数）' });
  }
  if (!Number.isInteger(observedStepNo)) {
    return res.status(400).json({ error: '缺少或非法的 observedStepNo（所见源当前步号必须为整数）' });
  }

  // 训练任务的尝试会话不得分叉：分支会绕开任务权限与次数限制
  const srcRow = db.prepare('SELECT task_id FROM sessions WHERE code = ?').get(req.params.code);
  if (srcRow && srcRow.task_id) {
    return res.status(409).json({
      error: '该会话属于训练任务的计次尝试，不能复盘分叉（未创建分支）',
      errorCode: 'TASK_SESSION_FORK_FORBIDDEN',
    });
  }

  // 会话码随机碰撞时极小概率重试
  for (let attempt = 0; attempt < 3; attempt++) {
    const newCode = newSessionCode();
    const result = forkSession(db, {
      sourceCode: req.params.code,
      forkStepNo,
      observedStepNo,
      traineeName,
      newCode,
    });
    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        errorCode: result.errorCode,
        sourceCurrent: result.sourceCurrent || null,
        current: result.current || null,
      });
    }
    const sc = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(result.session.scenario_id);
    const snapshot = buildSnapshot(result.content, result.session, result.session.scenario_id, result.session.version);
    // 分支尚未做出自己的选择，当前累计分即“截至分歧步已完成路径”的继承得分
    return res.status(201).json({
      ok: true,
      forkedFrom: req.params.code,
      forkStepNo,
      ...snapshot,
      scenarioTitle: sc ? sc.title : null,
      inheritedScore: snapshot.totalScore,
    });
  }
  return res.status(500).json({ error: '分支会话码生成失败，请重试' });
});

// 来源与分支对照：返回同一家族（root_code）下原始会话与全部分支的树，
// 每个节点携带来源、分歧步与各自完整后续路径。任务会话同样须凭本人参与凭证查看。
app.get('/api/sessions/:code/lineage', (req, res) => {
  const row = db.prepare('SELECT task_id, task_trainee_id FROM sessions WHERE code = ?').get(req.params.code);
  if (row && row.task_id && !taskSessionAllowed(req, row)) {
    return res.status(401).json({
      error: '该会话属于训练任务，只能凭本人参与凭证查看（请经任务入口访问）',
      errorCode: 'TASK_TOKEN_INVALID',
    });
  }
  const result = loadLineage(db, req.params.code);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true, rootCode: result.rootCode, requestedCode: result.requestedCode, tree: result.tree });
});

// ---------- 培训师：处置覆盖报告 ----------

// 针对某个已发布冻结版本：覆盖项 = 从初态可达的（节点 × 进入时现场状态 × 可选选项）。
// 只按绑定该版本的会话已完成选择统计；同一家族（原始会话与多级分支）对同一覆盖项
// 至多贡献一次，继承前缀不重复累计；进行中会话只计已完成步骤；其它版本不混入。
// ?uncovered=1 时 items 只列未覆盖项（totals 仍基于全量统计）。
// 版本不存在 / 冻结内容损坏 / 会话路径损坏时返回明确错误码，不返回部分统计。
app.get('/api/scenarios/:id/versions/:version/coverage', (req, res) => {
  const uncoveredOnly = ['1', 'true', 'yes'].includes(String(req.query.uncovered || '').toLowerCase());
  const result = buildCoverageReport(db, req.params.id, req.params.version, { uncoveredOnly });
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      errorCode: result.errorCode,
      detail: result.detail,
    });
  }
  res.json(result.report);
});

// ---------- 共识演练房间（多人投票推进同一条会话路径） ----------

// 开启房间（培训师）：{scenarioId, version?, stepDuration?, blind?}。version 缺省为当前最新发布版；
// 房间绑定该冻结版本，后续发布新版本不改变本场规则。
// stepDuration 省略/null 为不限时旧用法；否则为限时模式每步秒数（30..3600 的整数）。
// blind 仅接受布尔值：省略/false 为公开投票旧用法，true 为盲投（当前步结算前任何人只看到
// 已投人数，不显示各选项票数或逐人选项；学员凭成员凭证仍可查看/修改自己的票）；非布尔值报错且不建房。
// 成功返回房间码（即学员加入码）与主持凭证。
app.post('/api/rooms', (req, res) => {
  const { scenarioId, version, stepDuration, blind } = req.body || {};
  if (!scenarioId) return res.status(400).json({ error: '缺少 scenarioId' });
  const result = roomOps.createRoom(db, { scenarioId, version, stepDuration, blind });
  if (!result.ok) return res.status(result.status).json({ error: result.error, errorCode: result.errorCode });
  res.status(201).json({
    ok: true,
    code: result.room.code,
    joinCode: result.room.code, // 学员加入码（即房间码）
    hostToken: result.hostToken, // 主持凭证（结算/重开时出示，请妥善保存）
    scenarioId: result.room.scenario_id,
    scenarioTitle: result.scenarioTitle,
    version: result.room.version,
    sessionCode: result.room.session_code,
    stepDurationSeconds: result.room.step_duration ?? null, // 非空=限时模式每步秒数
    timed: result.room.step_duration != null,
    blind: result.room.blind_vote === 1, // true=盲投（结算前只公开已投人数，创建后不可更改）
    note: [
      result.room.step_duration != null
        ? `限时房间：每步 ${result.room.step_duration} 秒，到点有票自动按多数决结算（下一步从实际结算时重新计时），到点零票暂停待主持人重开；截止前可改票或由主持人提前结算。`
        : '房间已绑定该冻结版本，后续发布新版本不影响本场规则；学员凭加入码取得成员凭证后投票，主持人凭主持凭证结算。',
      result.room.blind_vote === 1
        ? '盲投房间：当前步结算前仅公开已投人数，不显示各选项票数或逐人选项（主持人同样不可见）；结算后公布各选项票数与获胜处置，始终不公开姓名与选项的对应关系；盲投设置创建后不可更改。'
        : '',
    ].filter(Boolean).join(''),
  });
});

// 最近房间列表（不暴露凭证与投票明细）
app.get('/api/rooms', (req, res) => {
  res.json(roomOps.listRooms(db));
});

// 房间现状：当前步号、可选处置与聚合票数、已结算路径、累计分。
// 可选凭证：query 参数 memberToken / hostToken（或 x-member-token / x-host-token 请求头）。
// 成员凭证附加 myVote；主持凭证附加逐人投票明细与成员名单；未结算前学员看不到他人选票。
app.get('/api/rooms/:code', (req, res) => {
  const viewer = {};
  const mt = req.query.memberToken || req.get('x-member-token');
  const ht = req.query.hostToken || req.get('x-host-token');
  if (mt) viewer.memberToken = String(mt);
  if (ht) viewer.hostToken = String(ht);
  const room = roomOps.getRoom(db, req.params.code);
  if (!room) return res.status(404).json({ error: '房间不存在', errorCode: 'ROOM_NOT_FOUND' });
  const result = roomOps.buildRoomSnapshot(db, room, viewer);
  if (!result.ok) return res.status(result.status).json({ error: result.error, errorCode: result.errorCode });
  res.json({ ok: true, ...result.snapshot });
});

// 学员加入：{name?} → 成员凭证
app.post('/api/rooms/:code/join', (req, res) => {
  const { name } = req.body || {};
  const result = roomOps.joinRoom(db, { code: req.params.code, name });
  if (!result.ok) return res.status(result.status).json({ error: result.error, errorCode: result.errorCode });
  res.status(201).json({
    ok: true,
    memberToken: result.memberToken,
    memberName: result.memberName,
    room: result.snapshot,
  });
});

// 学员投票/改票：{memberToken, optionId, stepNo}。每人每步只计最后一票；
// 过期步号/无效凭证/条件不符/已结束一律返回原因及当前步号，不改变票数。
app.post('/api/rooms/:code/vote', (req, res) => {
  const { memberToken, optionId, stepNo } = req.body || {};
  if (typeof memberToken !== 'string' || !memberToken) {
    return res.status(400).json({ error: '缺少 memberToken（成员凭证）' });
  }
  if (typeof optionId !== 'string') return res.status(400).json({ error: '缺少 optionId' });
  if (!Number.isInteger(stepNo)) return res.status(400).json({ error: '缺少或非法的 stepNo（必须为整数）' });
  const result = roomOps.castVote(db, { code: req.params.code, memberToken, optionId, stepNo });
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      errorCode: result.errorCode,
      current: result.current || null,
    });
  }
  res.json({ ok: true, myVote: { optionId }, current: result.snapshot });
});

// 主持人结算：{hostToken, observedStepNo}。票数最多的选项推进共享会话，
// 同票按冻结版本的选项编排顺序；无人投票不得结算；过期步号拒绝并返回当前步号。
app.post('/api/rooms/:code/settle', (req, res) => {
  const { hostToken, observedStepNo } = req.body || {};
  if (typeof hostToken !== 'string' || !hostToken) {
    return res.status(400).json({ error: '缺少 hostToken（主持凭证）' });
  }
  if (!Number.isInteger(observedStepNo)) {
    return res.status(400).json({ error: '缺少或非法的 observedStepNo（必须为整数）' });
  }
  const result = roomOps.settleRoom(db, { code: req.params.code, hostToken, observedStepNo });
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      errorCode: result.errorCode,
      current: result.current || null,
    });
  }
  res.json({ ok: true, autoSettled: result.autoSettled, settled: result.settled, current: result.snapshot });
});

// 主持人重开（仅限时房间、本步到点零票暂停后）：{hostToken, observedStepNo}。
// 凭主持凭证与“所见步号”把当前步重新开放完整时长；不推进、不改票数/路径/得分。
app.post('/api/rooms/:code/reopen', (req, res) => {
  const { hostToken, observedStepNo } = req.body || {};
  if (typeof hostToken !== 'string' || !hostToken) {
    return res.status(400).json({ error: '缺少 hostToken（主持凭证）' });
  }
  if (!Number.isInteger(observedStepNo)) {
    return res.status(400).json({ error: '缺少或非法的 observedStepNo（必须为整数）' });
  }
  const result = roomOps.reopenRoom(db, { code: req.params.code, hostToken, observedStepNo });
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      errorCode: result.errorCode,
      current: result.current || null,
    });
  }
  res.json({ ok: true, reopened: result.reopened, current: result.snapshot });
});

// ---------- 训练任务（培训师建任务 / 学员凭个人凭证演练 / 培训师凭管理凭证看成绩） ----------

// 建立训练任务（培训师）：{scenarioId, version?, deadline, maxAttempts, passScore, trainees}。
// version 缺省为当前最新发布版；任务绑定该冻结版本，后续发布新版本不改变本任务规则。
// deadline 为 epoch 毫秒或 ISO-8601 时间串，必须晚于当前时间；maxAttempts 为正整数；
// passScore 为整数；trainees 为非空姓名数组且姓名不重复。任何一项非法都整次拒绝（不写库）。
// 成功返回任务编号、管理凭证与每名学员的独立参与凭证（201）。
app.post('/api/tasks', (req, res) => {
  const { scenarioId, version, deadline, maxAttempts, passScore, trainees } = req.body || {};
  if (!scenarioId) return res.status(400).json({ error: '缺少 scenarioId' });
  const result = taskOps.createTask(db, { scenarioId, version, deadline, maxAttempts, passScore, trainees });
  if (!result.ok) return res.status(result.status).json({ error: result.error, errorCode: result.errorCode });
  res.status(201).json({
    ok: true,
    taskId: result.task.id,
    adminToken: result.adminToken, // 管理凭证，请妥善保存
    ...taskOps.publicMeta(db, result.task),
    trainees: result.trainees, // [{name, token}] 各学员的独立参与凭证，请分发给本人
    note: '任务已绑定所选冻结版本，后续发布新版本不影响本任务规则；'
        + '学员凭「任务编号 + 本人参与凭证」开始或续做演练：有未结束尝试时重复开始返回原会话，'
        + '结束后才消耗下一次；截止后不能开新尝试但可续做旧会话。',
  });
});

// 最近任务列表（元信息；不含任何凭证与成绩）
app.get('/api/tasks', (req, res) => {
  res.json(taskOps.listTasks(db));
});

// 任务公开元信息（供参与页确认任务；不含凭证、名单与成绩）
app.get('/api/tasks/:id', (req, res) => {
  const task = taskOps.getTask(db, req.params.id);
  if (!task) return res.status(404).json({ error: '训练任务不存在', errorCode: 'TASK_NOT_FOUND' });
  res.json({ ok: true, task: taskOps.publicMeta(db, task) });
});

// 学员开始或续做：{token}。有未结束尝试返回原会话（200，resumed=true，不消耗次数）；
// 否则新建一次尝试（201，消耗一次）；次数耗尽 / 已过截止 / 凭证无效均明确反馈且不多建会话。
app.post('/api/tasks/:id/start', (req, res) => {
  const { token } = req.body || {};
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: '缺少 token（个人参与凭证）', errorCode: 'TASK_TOKEN_REQUIRED' });
  }
  const result = taskOps.startAttempt(db, { taskId: req.params.id, token });
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      errorCode: result.errorCode,
      task: result.task || null,
      attemptsUsed: result.attemptsUsed ?? null,
    });
  }
  res.status(result.resumed ? 200 : 201).json({
    ok: true,
    resumed: result.resumed,
    task: result.task,
    traineeName: result.traineeName,
    attemptNo: result.attemptNo,
    maxAttempts: result.maxAttempts,
    attemptsUsed: result.attemptsUsed,
    attemptsLeft: result.attemptsLeft,
    session: result.session,
  });
});

// 学员视角：我的尝试记录与进行中的会话（?token= 或 x-task-token 请求头）
app.get('/api/tasks/:id/my', (req, res) => {
  const token = req.query.token || req.get('x-task-token');
  const result = taskOps.getMine(db, { taskId: req.params.id, token });
  if (!result.ok) return res.status(result.status).json({ error: result.error, errorCode: result.errorCode });
  res.json({
    ok: true,
    task: result.task,
    traineeName: result.traineeName,
    maxAttempts: result.maxAttempts,
    attemptsUsed: result.attemptsUsed,
    attemptsLeft: result.attemptsLeft,
    attempts: result.attempts,
    active: result.active,
  });
});

// 学员在任务会话中执行一步选择：{token, optionId, stepNo}。
// 只能推进本人“进行中”的那次尝试；选项条件、步号与计分规则完全沿用任务冻结版本。
app.post('/api/tasks/:id/move', (req, res) => {
  const { token, optionId, stepNo } = req.body || {};
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: '缺少 token（个人参与凭证）', errorCode: 'TASK_TOKEN_REQUIRED' });
  }
  if (typeof optionId !== 'string') return res.status(400).json({ error: '缺少 optionId' });
  if (!Number.isInteger(stepNo)) return res.status(400).json({ error: '缺少或非法的 stepNo（必须为整数）' });
  const result = taskOps.taskMove(db, { taskId: req.params.id, token, optionId, stepNo });
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      errorCode: result.errorCode,
      current: result.current || null,
    });
  }
  const sc = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(result.session.scenario_id);
  const snapshot = buildSnapshot(result.content, result.session, result.session.scenario_id, result.session.version);
  const last = snapshot.path.find((p) => p.step === result.session.step_no) || null;
  res.json({
    ok: true,
    ...snapshot,
    scenarioTitle: sc ? sc.title : null,
    task: taskOps.publicMeta(db, result.task),
    attemptNo: result.attemptNo,
    attemptsUsed: result.attemptsUsed,
    attemptsLeft: result.attemptsLeft,
    lastMove: last ? {
      step: last.step,
      optionId: last.optionId,
      optionLabel: last.optionLabel,
      score: last.score,
      scoreNote: last.scoreNote,
      totalScore: snapshot.totalScore,
    } : null,
  });
});

// 培训师凭管理凭证查看成绩：各人尝试记录、最高已结束总分、是否达到及格分
// （?token= 或 x-admin-token 请求头）。无已结束尝试时 bestScore/passed 为 null（成绩为空）。
app.get('/api/tasks/:id/manage', (req, res) => {
  const token = req.query.token || req.get('x-admin-token');
  const result = taskOps.manageReport(db, { taskId: req.params.id, adminToken: token });
  if (!result.ok) return res.status(result.status).json({ error: result.error, errorCode: result.errorCode });
  res.json({ ok: true, task: result.task, summary: result.summary, trainees: result.trainees });
});

// 兜底：未匹配的 /api 返回 JSON 404
app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// JSON 解析失败 / 其它异常统一返回 JSON
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法的 JSON' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求体过大' });
  }
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

// 前端单页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[事故处置情境编排] 服务已启动: http://localhost:${PORT}`);
  console.log(`[数据库] ${DB_PATH}`);
});
