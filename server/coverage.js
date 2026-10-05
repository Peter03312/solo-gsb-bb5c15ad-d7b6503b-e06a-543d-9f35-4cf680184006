'use strict';

// 处置覆盖报告：针对某一“已发布冻结版本”，
// 以该版本从初态可达的「节点 × 进入时现场状态 × 可选选项」组合作为覆盖项，
// 仅按绑定该版本的会话的“已完成选择”统计覆盖情况。
//
// 统计口径：
//  - 覆盖项来自冻结版本自身的状态空间枚举（与发布检查同一套 analyze 结果），
//    只包含非结局局面下“条件满足、确实可选”的选项；结局局面没有可选选项。
//  - 只统计 sessions 中 scenario_id/version 与该冻结版本完全一致的会话，
//    其它版本（更新或更旧）的会话一律不混入。
//  - 同一家族（root_code 相同的原始会话与多级分支）对同一覆盖项至多贡献一次：
//    家族内逐会话回放已完成路径，命中的覆盖项并入“家族集合”去重；
//    分支继承自源会话的前缀因此不会被重复累计。
//  - 进行中会话只统计其已完成（已落库）的步骤；当前停留、尚未提交的局面不计。
//  - 冻结内容无法解析/不再满足发布不变量，或任一会话路径与冻结内容不一致时，
//    一律报错且不返回任何部分统计。

const {
  normalizeDraft,
  analyze,
  initialMask,
  formatStateValues,
  optionAvailable,
  applyChanges,
  optionScore,
  optionScoreNote,
} = require('./scenario');

function fail(status, errorCode, error, detail) {
  return { ok: false, status, errorCode, error, detail: detail || null };
}

/**
 * 生成处置覆盖报告。
 * @param db better-sqlite3 实例
 * @param scenarioId 情境 id
 * @param versionRaw 路径中的版本号（字符串，需为正整数）
 * @param opts { uncoveredOnly: 只返回未覆盖项（计数始终基于全量） }
 */
function buildCoverageReport(db, scenarioId, versionRaw, opts = {}) {
  const version = Number(versionRaw);
  if (!Number.isInteger(version) || version < 1) {
    return fail(400, 'VERSION_INVALID', `版本号非法：${JSON.stringify(versionRaw)}（必须为 ≥1 的整数）`);
  }

  const scenarioRow = db.prepare('SELECT id, title FROM scenarios WHERE id = ?').get(scenarioId);
  if (!scenarioRow) {
    return fail(404, 'SCENARIO_NOT_FOUND', `情境不存在：${scenarioId}`);
  }
  const versionRow = db.prepare('SELECT content, created_at FROM versions WHERE scenario_id = ? AND version = ?')
    .get(scenarioId, version);
  if (!versionRow) {
    return fail(404, 'VERSION_NOT_FOUND', `情境「${scenarioRow.title}」不存在已冻结版本 v${version}`);
  }

  // ---- 冻结内容完整性：解析 + 结构校验（损坏则不返回部分统计）----
  let rawContent;
  try {
    rawContent = JSON.parse(versionRow.content);
  } catch (_) {
    return fail(500, 'VERSION_CONTENT_CORRUPT',
      `冻结版本 v${version} 的内容不是合法 JSON，无法生成覆盖报告，请检查数据是否损坏`);
  }
  const normalized = normalizeDraft(rawContent);
  if (!normalized.ok) {
    return fail(500, 'VERSION_CONTENT_CORRUPT',
      `冻结版本 v${version} 的内容存在结构性损坏，无法生成覆盖报告`,
      { errors: normalized.errors.slice(0, 20) });
  }
  const content = normalized.scenario;

  // 已发布版本必须仍满足发布不变量（无路可走 / 可无限循环说明冻结内容已被破坏）
  const graph = analyze(content);
  if (graph.deadEnds.length || graph.doomed.length) {
    return fail(500, 'VERSION_CONTENT_CORRUPT',
      `冻结版本 v${version} 不再满足发布时的可达性不变量（出现无路可走或可无限循环的局面），`
      + '冻结内容可能已损坏，拒绝据此统计');
  }

  // ---- 枚举覆盖项：可达的非结局局面 × 当时可选的每个选项 ----
  const nodeMap = new Map(content.nodes.map((n) => [n.id, n]));
  const nodeIndex = new Map(content.nodes.map((n, i) => [n.id, i]));
  const optionIndex = new Map();
  for (const n of content.nodes) n.options.forEach((o, i) => optionIndex.set(`${n.id}|${o.id}`, i));

  const itemKeySet = new Set();
  const items = [];
  for (const key of graph.reachableKeys) {
    const v = graph.V.get(key);
    if (v.end) continue;
    const node = nodeMap.get(v.nodeId);
    if (!node) {
      return fail(500, 'VERSION_CONTENT_CORRUPT',
        `冻结版本 v${version} 的可达局面引用了不存在的节点「${v.nodeId}」，冻结内容可能已损坏`);
    }
    for (const edge of v.edges) {
      const itemKey = `${v.nodeId}|${v.mask}|${edge.optionId}`;
      if (itemKeySet.has(itemKey)) continue;
      itemKeySet.add(itemKey);
      const option = node.options.find((o) => o.id === edge.optionId);
      if (!option) {
        return fail(500, 'VERSION_CONTENT_CORRUPT',
          `冻结版本 v${version} 的可达局面引用了不存在的选项「${edge.optionId}」，冻结内容可能已损坏`);
      }
      const target = nodeMap.get(option.toNodeId);
      items.push({
        key: itemKey,
        nodeId: node.id,
        nodeTitle: node.title,
        nodeIndex: nodeIndex.get(node.id),
        optionIndex: optionIndex.get(`${node.id}|${option.id}`),
        entryStateMask: v.mask,
        entryStates: formatStateValues(content, v.mask),
        option: {
          id: option.id,
          label: option.label,
          conditions: option.conditions,
          changes: option.changes,
          toNodeId: option.toNodeId,
          toNodeTitle: target ? target.title : option.toNodeId,
          score: optionScore(option),
          scoreNote: optionScoreNote(option),
        },
      });
    }
  }
  // 确定顺序：按节点编排顺序、进入状态（掩码升序）、选项编排顺序，保证报告稳定可复现
  items.sort((a, b) => (a.nodeIndex - b.nodeIndex)
    || (a.entryStateMask - b.entryStateMask)
    || (a.optionIndex - b.optionIndex));

  // ---- 取绑定该版本的全部会话（其它版本不混入）----
  const sessions = db.prepare(`
    SELECT code, status, step_no, current_node_id, state_mask, path, parent_code, root_code
      FROM sessions
     WHERE scenario_id = ? AND version = ?
     ORDER BY created_at, code
  `).all(scenarioId, version);

  // ---- 逐家族回放已完成路径；任何路径损坏都整体报错 ----
  const familyKeys = new Map(); // rootCode -> Set<itemKey>
  for (const s of sessions) {
    const root = s.root_code || s.code;
    if (!familyKeys.has(root)) familyKeys.set(root, new Set());
    const hit = replaySessionPath(content, itemKeySet, s);
    if (!hit.ok) {
      return fail(500, 'SESSION_PATH_CORRUPT',
        `会话 ${s.code}（绑定 ${scenarioId} v${version}）的路径已损坏：${hit.reason}，拒绝返回部分统计`,
        { sessionCode: s.code, step: hit.step ?? null, reason: hit.reason });
    }
    for (const k of hit.keys) familyKeys.get(root).add(k);
  }

  // ---- 汇总 ----
  const itemViews = items.map((it) => {
    const familyCodes = [];
    for (const [root, set] of familyKeys) {
      if (set.has(it.key)) familyCodes.push(root);
    }
    familyCodes.sort();
    return {
      nodeId: it.nodeId,
      nodeTitle: it.nodeTitle,
      entryStates: it.entryStates,
      option: it.option,
      coveredFamilies: familyCodes.length,
      covered: familyCodes.length > 0,
      familyCodes,
    };
  });

  const familiesWithCoverage = [...familyKeys.values()].filter((set) => set.size > 0).length;
  const coveredItems = itemViews.filter((it) => it.covered).length;
  const report = {
    ok: true,
    scenarioId,
    scenarioTitle: scenarioRow.title,
    version,
    versionPublishedAt: versionRow.created_at,
    totals: {
      total: itemViews.length,
      covered: coveredItems,
      uncovered: itemViews.length - coveredItems,
      sessionsConsidered: sessions.length,
      familiesConsidered: familyKeys.size,
      familiesWithCoverage,
    },
    scope: {
      rule: '仅统计绑定本冻结版本的会话；同一家族（原始会话与多级分支）对同一覆盖项至多计一次；'
          + '继承前缀不重复累计；进行中会话只计已完成步骤；其它版本不混入。',
    },
    items: opts.uncoveredOnly ? itemViews.filter((it) => !it.covered) : itemViews,
  };
  return { ok: true, report };
}

// 严格回放单个会话的已完成路径，返回其命中的覆盖项 key 列表。
// 任一字段与冻结内容不一致（路径损坏/被外部篡改）都返回错误。
function replaySessionPath(content, itemKeySet, s) {
  const corrupt = (reason, step) => ({ ok: false, reason, step: step ?? null });

  let steps;
  try {
    steps = JSON.parse(s.path || '[]');
  } catch (_) {
    return corrupt('path 不是合法 JSON');
  }
  if (!Array.isArray(steps)) return corrupt('path 不是数组');

  const nodeMap = new Map(content.nodes.map((n) => [n.id, n]));
  const startMask = initialMask(content);
  let nodeId = content.startNodeId;
  let mask = startMask;
  const keys = [];

  for (let i = 0; i < steps.length; i++) {
    const p = steps[i];
    const step = i + 1;
    if (!p || typeof p !== 'object') return corrupt('路径项不是对象', step);
    if (p.step !== step) return corrupt(`步号不连续：第 ${i} 条记录标注为第 ${p.step} 步，应为第 ${step} 步`, step);
    if (p.fromNodeId !== nodeId) {
      return corrupt(`第 ${step} 步所在节点（${p.fromNodeId}）与上一步到达节点（${nodeId}）不一致`, step);
    }
    const node = nodeMap.get(nodeId);
    if (!node) return corrupt(`第 ${step} 步所在节点「${nodeId}」在冻结版本中不存在`, step);
    if (node.isEnd) return corrupt(`第 ${step} 步记录了在结局节点「${nodeId}」上的选择`, step);
    const option = node.options.find((o) => o.id === p.optionId);
    if (!option) return corrupt(`第 ${step} 步选择的选项「${p.optionId}」在节点「${nodeId}」上不存在`, step);
    if (!optionAvailable(option, mask, content)) {
      return corrupt(`第 ${step} 步选项「${option.label}」在当时现场状态下条件并不满足`, step);
    }
    if (p.toNodeId !== option.toNodeId) {
      return corrupt(`第 ${step} 步记录的目标节点（${p.toNodeId}）与冻结版本（${option.toNodeId}）不一致`, step);
    }
    const nextMask = applyChanges(option, mask, content);
    if (!Number.isInteger(p.stateMask) || p.stateMask !== nextMask) {
      return corrupt(`第 ${step} 步后的现场状态与冻结规则应得结果不一致`, step);
    }
    const key = `${nodeId}|${mask}|${option.id}`;
    if (!itemKeySet.has(key)) {
      return corrupt(`第 ${step} 步的选择不属于该版本从初态可达的可选组合`, step);
    }
    keys.push(key);
    nodeId = option.toNodeId;
    mask = nextMask;
  }

  // 会话表上的当前局面列必须与已完成路径严格一致（否则视为损坏）
  if (s.step_no !== steps.length) {
    return corrupt(`step_no=${s.step_no} 与路径步数 ${steps.length} 不一致`);
  }
  if (s.current_node_id !== nodeId) {
    return corrupt(`当前节点（${s.current_node_id}）与路径终点（${nodeId}）不一致`);
  }
  if (!Number.isInteger(s.state_mask) || s.state_mask !== mask) {
    return corrupt('当前现场状态与路径推演结果不一致');
  }
  const endNode = nodeMap.get(nodeId);
  const atEnd = !!(endNode && endNode.isEnd);
  if (s.status !== 'active' && s.status !== 'ended') {
    return corrupt(`会话状态非法：${s.status}`);
  }
  if ((s.status === 'ended') !== atEnd) {
    return corrupt(`会话状态为 ${s.status}，但路径${atEnd ? '' : '不'}位于结局节点`);
  }
  return { ok: true, keys };
}

module.exports = { buildCoverageReport };
