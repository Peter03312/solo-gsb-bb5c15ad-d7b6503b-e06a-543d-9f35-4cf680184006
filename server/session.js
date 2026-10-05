'use strict';

const {
  optionAvailable,
  applyChanges,
  formatStateValues,
  findOption,
  optionScore,
  optionScoreNote,
} = require('./scenario');

function nodesById(content) {
  return new Map(content.nodes.map((n) => [n.id, n]));
}

// 构造返回给前端的完整现状快照
function buildSnapshot(content, session, scenarioId, version) {
  const nodeMap = nodesById(content);
  const node = nodeMap.get(session.current_node_id);
  const stateValues = formatStateValues(content, session.state_mask);
  const path = JSON.parse(session.path || '[]');

  const available = [];
  const unavailable = [];
  if (node && !node.isEnd && session.status === 'active') {
    for (const o of node.options) {
      const ok = optionAvailable(o, session.state_mask, content);
      const failing = o.conditions
        .filter((c) => {
          const st = content.states.find((s) => s.id === c.stateId);
          const cur = stateValues.find((v) => v.id === c.stateId);
          return st && cur && cur.value !== c.value;
        })
        .map((c) => {
          const st = content.states.find((s) => s.id === c.stateId);
          return { stateId: c.stateId, stateName: st ? st.name : c.stateId, required: c.value };
        });
      const item = {
        id: o.id,
        label: o.label,
        conditions: o.conditions,
        changes: o.changes,
        toNodeId: o.toNodeId,
      };
      if (ok) available.push(item);
      else unavailable.push({ ...item, reason: '当前现场状态不满足该选项条件', failingConditions: failing });
    }
  }

  const pathView = path.map((p) => {
    const fromNode = nodeMap.get(p.fromNodeId);
    const toNode = nodeMap.get(p.toNodeId);
    const fromN = fromNode ? fromNode.options.find((o) => o.id === p.optionId) : null;
    // 旧版本选项没有评分字段时 findOption/optionScore 均退化为 0 分
    const chosen = findOption(content, p.fromNodeId, p.optionId);
    return {
      step: p.step,
      fromNodeId: p.fromNodeId,
      fromNodeTitle: fromNode ? fromNode.title : p.fromNodeId,
      optionId: p.optionId,
      optionLabel: fromN ? fromN.label : p.optionId,
      toNodeId: p.toNodeId,
      toNodeTitle: toNode ? toNode.title : p.toNodeId,
      stateAfter: formatStateValues(content, p.stateMask),
      score: chosen ? optionScore(chosen) : 0,
      scoreNote: chosen ? optionScoreNote(chosen) : '',
    };
  });
  const totalScore = pathView.reduce((sum, p) => sum + p.score, 0);

  return {
    code: session.code,
    scenarioId,
    version,
    status: session.status,
    stepNo: session.step_no,
    totalScore,
    currentNode: node ? {
      id: node.id,
      title: node.title,
      narrative: node.narrative,
      isEnd: node.isEnd,
    } : null,
    startNodeTitle: nodeMap.has(content.startNodeId) ? nodeMap.get(content.startNodeId).title : content.startNodeId,
    states: stateValues,
    availableOptions: available,
    unavailableOptions: unavailable,
    path: pathView,
    traineeName: session.trainee_name || null,
    startedAt: session.created_at,
    roomCode: session.room_code || null, // 非空表示该会话是共识演练房间的共享会话
    lineage: {
      rootCode: session.root_code || session.code,
      parentCode: session.parent_code || null,
      forkStepNo: session.fork_step_no ?? null,
      isBranch: !!session.parent_code,
    },
  };
}

/**
 * 按“绑定版本的冻结规则 + 已完成路径”计算会话累计分（不写库）。
 * 用于会话列表等只持有 path JSON 的场景；旧版本没有评分字段时各步按 0 分处理。
 */
function computeTotalScore(content, pathRows) {
  let sum = 0;
  for (const p of pathRows || []) {
    const o = findOption(content, p.fromNodeId, p.optionId);
    sum += optionScore(o);
  }
  return sum;
}

/**
 * 执行一步选择。不写库，返回 {ok, error, session}（供事务内调用）。
 * 校验：会话存在/未结束、步号严格匹配当前步号（防过期/重复提交）、
 *       选项属于当前节点、条件满足。任何不满足都不推进。
 * 房间会话（room_code 非空）属于共识演练，必须经“成员投票 + 主持人结算”推进；
 * 仅房间结算内部调用时传 allowRoomSession: true 放行。
 */
function performMove(db, { code, optionId, stepNo, traineeName, allowRoomSession = false }) {
  const session = db.prepare('SELECT * FROM sessions WHERE code = ?').get(code);
  if (!session) {
    return { ok: false, status: 404, errorCode: 'SESSION_NOT_FOUND', error: '会话不存在' };
  }
  const versionRow = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(session.scenario_id, session.version);
  if (!versionRow) {
    return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '会话所绑定的版本内容缺失' };
  }
  const content = JSON.parse(versionRow.content);
  const nodeMap = nodesById(content);

  const fail = (status, errorCode, error) => ({
    ok: false,
    status,
    errorCode,
    error,
    current: buildSnapshot(content, session, session.scenario_id, session.version),
  });

  if (session.room_code && !allowRoomSession) {
    return fail(409, 'ROOM_SOLO_MOVE_FORBIDDEN',
      `该会话属于共识演练房间 ${session.room_code}，须由成员投票、主持人结算推进，不能经单人选择入口操作（未推进）`);
  }
  if (session.status !== 'active') {
    return fail(409, 'SESSION_ENDED', '该会话已结束，不能继续选择');
  }
  if (!Number.isInteger(stepNo) || stepNo !== session.step_no) {
    return fail(409, 'STEP_STALE',
      `步号不匹配：请求携带第 ${stepNo} 步，会话当前为第 ${session.step_no} 步（可能是过期或重复的选择，未推进）`);
  }
  const node = nodeMap.get(session.current_node_id);
  if (!node || node.isEnd) {
    return fail(409, 'NODE_NOT_CHOOSABLE', '当前节点不是可选择节点');
  }
  const option = node.options.find((o) => o.id === optionId);
  if (!option) {
    return fail(400, 'OPTION_NOT_FOUND', '当前节点下不存在该选项');
  }
  if (!optionAvailable(option, session.state_mask, content)) {
    const failing = option.conditions
      .filter((c) => {
        const i = content.states.findIndex((s) => s.id === c.stateId);
        const cur = i >= 0 ? ((session.state_mask >> i) & 1) === 1 : null;
        return cur !== null && cur !== c.value;
      })
      .map((c) => {
        const st = content.states.find((s) => s.id === c.stateId);
        return `${st ? st.name : c.stateId} 需要为「${c.value ? '是' : '否'}」`;
      });
    return fail(409, 'CONDITION_NOT_MET',
      `当前现场状态不满足选项「${option.label}」的条件${failing.length ? '：' + failing.join('；') : ''}`);
  }

  const newMask = applyChanges(option, session.state_mask, content);
  const nextStep = session.step_no + 1;
  const path = JSON.parse(session.path || '[]');
  path.push({
    step: nextStep,
    fromNodeId: node.id,
    optionId: option.id,
    toNodeId: option.toNodeId,
    stateMask: newMask,
  });
  const targetNode = nodeMap.get(option.toNodeId);
  const newStatus = targetNode && targetNode.isEnd ? 'ended' : 'active';

  db.prepare(`
    UPDATE sessions
       SET current_node_id = ?, state_mask = ?, step_no = ?, status = ?,
           path = ?, trainee_name = COALESCE(?, trainee_name), updated_at = datetime('now')
     WHERE code = ?
  `).run(option.toNodeId, newMask, nextStep, newStatus, JSON.stringify(path),
    traineeName ?? null, code);

  const updated = db.prepare('SELECT * FROM sessions WHERE code = ?').get(code);
  return { ok: true, session: updated, content };
}

// 读取会话所绑定冻结版本的内容
function getVersionContent(db, session) {
  const row = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(session.scenario_id, session.version);
  return row ? JSON.parse(row.content) : null;
}

/**
 * 培训师复盘：从源会话的历史局面创建可继续选择的分支。
 *
 * 规则：
 *  - 分支沿用源会话绑定的冻结版本（不跟随最新发布版）；
 *  - 保留分歧步之前已完成的路径与该步现场状态；第 0 步即该版本初态；
 *  - 只推进分支自身，原会话与其它分支不变；
 *  - 已结束会话可从此前的非结局步分叉；结局步（源当前步号）不得分叉；
 *  - 支持分支再次分叉。
 *
 * 入参：{ sourceCode, forkStepNo, observedStepNo, traineeName, newCode }
 * 任何校验失败都不创建分支；能定位源会话时在 error 的 sourceCurrent 中返回其当前步号。
 */
function forkSession(db, params) {
  const { sourceCode, forkStepNo, observedStepNo, traineeName, newCode } = params;

  const source = db.prepare('SELECT * FROM sessions WHERE code = ?').get(sourceCode);
  if (!source) {
    return { ok: false, status: 404, errorCode: 'SESSION_NOT_FOUND', error: '源会话不存在' };
  }
  const content = getVersionContent(db, source);
  if (!content) {
    return {
      ok: false,
      status: 500,
      errorCode: 'VERSION_MISSING',
      error: `源会话绑定的版本（${source.scenario_id} v${source.version}）不存在或内容缺失，无法创建分支`,
      sourceCurrent: { code: source.code, stepNo: source.step_no },
    };
  }

  const reject = (status, errorCode, error) => ({
    ok: false,
    status,
    errorCode,
    error,
    sourceCurrent: { code: source.code, stepNo: source.step_no },
    current: buildSnapshot(content, source, source.scenario_id, source.version),
  });

  // 所见源当前步号必须与服务端一致（防过期页面/并发后基于旧局面分叉）
  if (!Number.isInteger(observedStepNo) || observedStepNo !== source.step_no) {
    return reject(409, 'STEP_STALE',
      `源会话步号已变化：你看到的是第 ${observedStepNo} 步，源会话当前为第 ${source.step_no} 步，未创建分支（请刷新局面后重试）`);
  }
  // 分歧点越界：0..源当前步号
  if (!Number.isInteger(forkStepNo) || forkStepNo < 0 || forkStepNo > source.step_no) {
    return reject(409, 'FORK_STEP_OUT_OF_RANGE',
      `分歧步号越界：请求在第 ${forkStepNo} 步分叉，源会话仅有第 0..${source.step_no} 步，未创建分支`);
  }

  const nodeMap = nodesById(content);
  const sourcePath = JSON.parse(source.path || '[]');

  // 该步现场状态：第 0 步为该版本初态；之后为“到达该步的那条选择”应用变更后的状态
  let nodeId;
  let stateMask;
  let branchPath;
  if (forkStepNo === 0) {
    // 第 0 步使用该版本初态（从冻结版本声明重新计算，不依赖源会话后续走向）
    nodeId = content.startNodeId;
    stateMask = 0;
    content.states.forEach((s, i) => { if (s.initial) stateMask |= 1 << i; });
    branchPath = [];
  } else {
    const entry = sourcePath.find((p) => p.step === forkStepNo);
    if (!entry) {
      return reject(409, 'FORK_STEP_OUT_OF_RANGE',
        `源会话历史中找不到第 ${forkStepNo} 步的局面（路径数据不完整），未创建分支`);
    }
    nodeId = entry.toNodeId;
    stateMask = entry.stateMask;
    branchPath = sourcePath.filter((p) => p.step <= forkStepNo);
  }

  // 结局步不得分叉（已结束会话只能从其此前的非结局步分叉）
  const forkNode = nodeMap.get(nodeId);
  if (!forkNode) {
    return reject(409, 'NODE_NOT_CHOOSABLE',
      `第 ${forkStepNo} 步所在节点在绑定版本中不存在，未创建分支`);
  }
  if (forkNode.isEnd) {
    return reject(409, 'FORK_AT_END_STEP',
      `第 ${forkStepNo} 步是结局步（${forkNode.title}），结局步不得分叉；可在其之前的非结局步分叉，未创建分支`);
  }

  const trimmedName = typeof traineeName === 'string' && traineeName.trim()
    ? traineeName.trim().slice(0, 100)
    : null;
  const rootCode = source.root_code || source.code;

  db.prepare(`
    INSERT INTO sessions
      (code, scenario_id, version, current_node_id, state_mask, step_no, status, path,
       trainee_name, parent_code, fork_step_no, root_code)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
  `).run(newCode, source.scenario_id, source.version, nodeId, stateMask, forkStepNo,
    JSON.stringify(branchPath), trimmedName, source.code, forkStepNo, rootCode);

  const branch = db.prepare('SELECT * FROM sessions WHERE code = ?').get(newCode);
  return { ok: true, session: branch, content };
}

/**
 * 加载会话家族（同一 root_code 下的原始会话与全部分支）并组装对照树。
 * 每个节点携带各自的完整后续路径（快照视图），便于展示来源、分歧步及后续路径。
 */
function loadLineage(db, code) {
  const seedRow = db.prepare('SELECT * FROM sessions WHERE code = ?').get(code);
  if (!seedRow) return { ok: false, status: 404, errorCode: 'SESSION_NOT_FOUND', error: '会话不存在' };

  const rootCode = seedRow.root_code || seedRow.code;
  const rows = db.prepare('SELECT * FROM sessions WHERE root_code = ? OR (root_code IS NULL AND code = ?) ORDER BY created_at, code')
    .all(rootCode, rootCode);

  // 家族内可能跨分支多次分叉，但都绑定同一情境；版本内容按 (scenario, version) 缓存
  const contentCache = new Map();
  const contentFor = (s) => {
    const key = `${s.scenario_id}|${s.version}`;
    if (!contentCache.has(key)) {
      const r = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
        .get(s.scenario_id, s.version);
      contentCache.set(key, r ? JSON.parse(r.content) : null);
    }
    return contentCache.get(key);
  };
  const sc = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(seedRow.scenario_id);

  const nodes = rows.map((s) => ({
    ...buildSnapshot(contentFor(s) || { states: [], nodes: [], startNodeId: s.current_node_id },
      s, s.scenario_id, s.version),
    scenarioTitle: sc ? sc.title : null,
    versionExists: !!contentFor(s),
    children: [], // 子分支可能因 created_at 更早而排在父会话之前，建节点时即初始化
  }));

  const byCode = new Map(nodes.map((n) => [n.code, n]));
  for (const n of nodes) {
    const parentCode = n.lineage.parentCode;
    if (parentCode && byCode.has(parentCode)) {
      byCode.get(parentCode).children.push(n);
    }
  }
  // 根以 root_code 为准（防止排序变化或自引用导致误判）；缺失时退化为入参会话
  const root = byCode.get(rootCode) || byCode.get(code) || nodes[0];

  return { ok: true, rootCode, requestedCode: code, tree: root };
}


module.exports = { buildSnapshot, performMove, forkSession, loadLineage, nodesById, computeTotalScore };
