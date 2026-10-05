'use strict';

// 情境草稿规范化/校验，以及发布前的状态空间可达性分析。

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_STATES = 8;
const SCORE_MIN = -10;
const SCORE_MAX = 10;
const SCORE_NOTE_MAX = 500;

function isBool(v) {
  return v === true || v === false;
}

function bad(code, message, at) {
  return { code, message, at: at || null };
}

/**
 * 规范化草稿并做结构校验。
 * 返回 { ok, scenario, errors }。
 * 注意：此函数只保证结构自洽（无无效引用、无矛盾条件），
 * “非结局不得无路可走 / 不得无限循环”由 analyze() 在发布前检查。
 */
function normalizeDraft(raw) {
  const errors = [];
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, scenario: null, errors: [bad('BAD_INPUT', '提交内容必须是 JSON 对象')] };
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) errors.push(bad('TITLE_REQUIRED', '情境标题不能为空', { field: 'title' }));
  if (title.length > 200) errors.push(bad('TITLE_TOO_LONG', '情境标题最长 200 字', { field: 'title' }));

  // ---------- 现场状态（1..8 个布尔状态） ----------
  if (!Array.isArray(raw.states)) {
    errors.push(bad('STATES_INVALID', 'states 必须是数组', { field: 'states' }));
  }
  const states = [];
  const stateIds = new Set();
  if (Array.isArray(raw.states)) {
    if (raw.states.length < 1) {
      errors.push(bad('STATES_EMPTY', '至少定义 1 个现场状态', { field: 'states' }));
    }
    if (raw.states.length > MAX_STATES) {
      errors.push(bad('STATES_TOO_MANY', `现场状态至多 ${MAX_STATES} 个，当前 ${raw.states.length} 个`, { field: 'states' }));
    }
    for (let i = 0; i < raw.states.length; i++) {
      const s = raw.states[i];
      const at = { field: 'states', index: i };
      if (typeof s !== 'object' || s === null) {
        errors.push(bad('STATE_INVALID', '状态必须是对象', at));
        continue;
      }
      if (typeof s.id !== 'string' || !ID_RE.test(s.id)) {
        errors.push(bad('STATE_ID_INVALID', `状态 id 非法：${JSON.stringify(s.id)}（允许字母数字下划线短横线，1-64 字符）`, at));
      } else if (stateIds.has(s.id)) {
        errors.push(bad('STATE_ID_DUPLICATE', `状态 id 重复：${s.id}`, at));
      } else {
        stateIds.add(s.id);
      }
      const name = typeof s.name === 'string' ? s.name.trim() : '';
      if (!name) errors.push(bad('STATE_NAME_REQUIRED', '状态名称不能为空', at));
      if (name.length > 100) errors.push(bad('STATE_NAME_TOO_LONG', '状态名称最长 100 字', at));
      if (!isBool(s.initial)) {
        errors.push(bad('STATE_INITIAL_INVALID', `状态「${name || s.id}」必须指定布尔初值`, at));
      }
      if (errors.length === 0 || (ID_RE.test(s.id || '') && isBool(s.initial))) {
        states.push({ id: s.id, name, initial: s.initial });
      }
    }
  }

  // ---------- 情境节点 ----------
  if (!Array.isArray(raw.nodes)) {
    errors.push(bad('NODES_INVALID', 'nodes 必须是数组', { field: 'nodes' }));
  }
  const nodes = [];
  const nodeIds = new Set();
  if (Array.isArray(raw.nodes)) {
    if (raw.nodes.length < 1) {
      errors.push(bad('NODES_EMPTY', '至少定义 1 个节点', { field: 'nodes' }));
    }
    for (let i = 0; i < raw.nodes.length; i++) {
      const n = raw.nodes[i];
      const at = { field: 'nodes', index: i };
      if (typeof n !== 'object' || n === null) {
        errors.push(bad('NODE_INVALID', '节点必须是对象', at));
        continue;
      }
      if (typeof n.id !== 'string' || !ID_RE.test(n.id)) {
        errors.push(bad('NODE_ID_INVALID', `节点 id 非法：${JSON.stringify(n.id)}`, at));
      } else if (nodeIds.has(n.id)) {
        errors.push(bad('NODE_ID_DUPLICATE', `节点 id 重复：${n.id}`, at));
      } else {
        nodeIds.add(n.id);
      }
      const nTitle = typeof n.title === 'string' ? n.title.trim() : '';
      if (!nTitle) errors.push(bad('NODE_TITLE_REQUIRED', '节点标题不能为空', at));
      if (nTitle.length > 200) errors.push(bad('NODE_TITLE_TOO_LONG', '节点标题最长 200 字', at));
      const narrative = typeof n.narrative === 'string' ? n.narrative.trim() : '';
      const isEnd = isBool(n.isEnd) ? n.isEnd : false;

      // ---------- 选项 ----------
      if (!Array.isArray(n.options)) {
        errors.push(bad('OPTIONS_INVALID', 'options 必须是数组', at));
        continue;
      }
      const optionIds = new Set();
      const options = [];
      if (isEnd && n.options.length > 0) {
        errors.push(bad('END_HAS_OPTIONS', `结局节点「${nTitle || n.id}」不能携带选项`, at));
      }
      if (!isEnd && n.options.length < 1) {
        // 结构阶段先记录为错误的话会与“无路可走”重复；这里允许保存，
        // 交由发布前 analyze() 统一报告（可能其它状态下有出路但本节点没选项）。
        // 但若节点没有任何选项，任何状态下都无路可走，结构阶段也无法规范化出边，
        // analyze 会给出死路报告；草稿阶段放行，便于边编辑边保存。
      }
      for (let j = 0; j < n.options.length; j++) {
        const o = n.options[j];
        const oat = { ...at, optionIndex: j };
        if (typeof o !== 'object' || o === null) {
          errors.push(bad('OPTION_INVALID', '选项必须是对象', oat));
          continue;
        }
        if (typeof o.id !== 'string' || !ID_RE.test(o.id)) {
          errors.push(bad('OPTION_ID_INVALID', `选项 id 非法：${JSON.stringify(o.id)}`, oat));
        } else if (optionIds.has(o.id)) {
          errors.push(bad('OPTION_ID_DUPLICATE', `节点「${nTitle || n.id}」内选项 id 重复：${o.id}`, oat));
        } else {
          optionIds.add(o.id);
        }
        const label = typeof o.label === 'string' ? o.label.trim() : '';
        if (!label) errors.push(bad('OPTION_LABEL_REQUIRED', '选项文案不能为空', oat));
        if (label.length > 200) errors.push(bad('OPTION_LABEL_TOO_LONG', '选项文案最长 200 字', oat));

        // 条件：规范化为 {stateId, value}[]，检查矛盾条件
        const condResult = normalizeTerms(o.conditions, stateIds, { ...oat, term: 'conditions' }, errors);
        const conds = condResult.terms;
        if (condResult.hasConflict) {
          errors.push(bad('CONDITION_CONFLICT',
            `选项「${label || o.id}」对同一状态同时要求真和假（矛盾条件，永远不可选）`, oat));
        }
        for (const c of conds) {
          if (!stateIds.has(c.stateId)) {
            errors.push(bad('CONDITION_BAD_REF', `选项「${label || o.id}」引用了不存在的状态：${c.stateId}`, oat));
          }
        }

        // 状态变更：规范化为 {stateId, value}[]
        const chgResult = normalizeTerms(o.changes, stateIds, { ...oat, term: 'changes' }, errors);
        const changes = chgResult.terms;
        for (const c of changes) {
          if (!stateIds.has(c.stateId)) {
            errors.push(bad('CHANGE_BAD_REF', `选项「${label || o.id}」变更了不存在的状态：${c.stateId}`, oat));
          }
        }

        if (typeof o.toNodeId !== 'string' || !ID_RE.test(o.toNodeId || '')) {
          errors.push(bad('TARGET_ID_INVALID', `选项「${label || o.id}」缺少有效的目标节点 id`, oat));
        }

        // 分值：-10..10 的整数；缺省（null/undefined/空串）按 0 分；
        // 非整数或越界拒绝保存。评分说明为可选文本。
        let score = 0;
        if (o.score === undefined || o.score === null) {
          score = 0; // 未填写视为 0
        } else if (typeof o.score === 'number' && Number.isInteger(o.score)
                   && o.score >= SCORE_MIN && o.score <= SCORE_MAX) {
          score = o.score;
        } else {
          errors.push(bad('OPTION_SCORE_INVALID',
            `选项「${label || o.id}」的分值非法：${JSON.stringify(o.score)}（必须是 ${SCORE_MIN}..${SCORE_MAX} 的整数；留空视为 0）`,
            oat));
        }
        let scoreNote = '';
        if (o.scoreNote === undefined || o.scoreNote === null) {
          scoreNote = '';
        } else if (typeof o.scoreNote === 'string') {
          scoreNote = o.scoreNote.trim();
          if (scoreNote.length > SCORE_NOTE_MAX) {
            errors.push(bad('OPTION_SCORE_NOTE_TOO_LONG',
              `选项「${label || o.id}」的评分说明最长 ${SCORE_NOTE_MAX} 字，当前 ${scoreNote.length} 字`, oat));
          }
        } else {
          errors.push(bad('OPTION_SCORE_NOTE_INVALID', `选项「${label || o.id}」的评分说明必须是文本`, oat));
        }

        options.push({
          id: ID_RE.test(o.id || '') ? o.id : `__bad_opt_${j}`,
          label,
          conditions: conds,
          changes,
          toNodeId: typeof o.toNodeId === 'string' ? o.toNodeId : '',
          score,
          scoreNote,
        });
      }

      nodes.push({ id: ID_RE.test(n.id || '') ? n.id : `__bad_node_${i}`, title: nTitle, narrative, isEnd, options });
    }
  }

  // ---------- 起点 / 结局 ----------
  let startNodeId = typeof raw.startNodeId === 'string' ? raw.startNodeId : '';
  if (!startNodeId) {
    errors.push(bad('START_REQUIRED', '必须指定起点节点', { field: 'startNodeId' }));
  } else if (!nodeIds.has(startNodeId)) {
    errors.push(bad('START_BAD_REF', `起点节点不存在：${startNodeId}`, { field: 'startNodeId' }));
  }
  const endCount = nodes.filter((n) => n.isEnd).length;
  if (endCount < 1) {
    errors.push(bad('END_REQUIRED', '至少需要 1 个结局节点', { field: 'nodes' }));
  }

  // ---------- 第二遍：校验选项目标引用 ----------
  if (nodeIds.size > 0) {
    for (const n of nodes) {
      for (const o of n.options) {
        if (o.toNodeId && !nodeIds.has(o.toNodeId)) {
          errors.push(bad('TARGET_BAD_REF',
            `节点「${n.title || n.id}」的选项「${o.label || o.id}」指向不存在的节点：${o.toNodeId}`,
            { nodeId: n.id, optionId: o.id }));
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, scenario: null, errors };
  }

  const scenario = {
    title,
    states: states.map((s) => ({ id: s.id, name: s.name, initial: s.initial })),
    startNodeId,
    nodes: nodes.map((n) => ({
      id: n.id,
      title: n.title,
      narrative: n.narrative,
      isEnd: n.isEnd,
      options: n.options.map((o) => ({
        id: o.id,
        label: o.label,
        conditions: o.conditions,
        changes: o.changes,
        toNodeId: o.toNodeId,
        score: o.score,
        scoreNote: o.scoreNote || '',
      })),
    })),
  };
  return { ok: true, scenario, errors: [] };
}

function normalizeTerms(input, knownIds, at, errors) {
  const terms = [];
  const seen = new Map(); // stateId -> 要求的值
  let hasConflict = false;
  if (input === undefined || input === null) {
    return { terms, hasConflict };
  }
  if (!Array.isArray(input)) {
    errors.push(bad('TERMS_INVALID', `${at.term === 'conditions' ? '条件' : '变更'}必须是数组`, at));
    return { terms, hasConflict };
  }
  for (let i = 0; i < input.length; i++) {
    const t = input[i];
    const tat = { ...at, index: i };
    if (typeof t !== 'object' || t === null) {
      errors.push(bad('TERM_INVALID', '条件/变更项必须是对象', tat));
      continue;
    }
    if (typeof t.stateId !== 'string' || !ID_RE.test(t.stateId)) {
      errors.push(bad('TERM_STATE_INVALID', `状态引用非法：${JSON.stringify(t.stateId)}`, tat));
      continue;
    }
    if (!isBool(t.value)) {
      errors.push(bad('TERM_VALUE_INVALID', `「${t.stateId}」的值必须是布尔 true/false`, tat));
      continue;
    }
    if (seen.has(t.stateId)) {
      if (seen.get(t.stateId) !== t.value) hasConflict = true;
      // 同一状态重复但同值：保留最后一个（幂等）；矛盾：标记错误
    }
    seen.set(t.stateId, t.value);
    terms.push({ stateId: t.stateId, value: t.value });
  }
  // 折叠重复（同值取最后；矛盾的两个条件在错误报告后也折叠，避免分析阶段重复）
  const folded = [];
  const byId = new Map();
  for (const t of terms) {
    if (!byId.has(t.stateId)) {
      byId.set(t.stateId, folded.length);
      folded.push(t);
    } else {
      folded[byId.get(t.stateId)] = t;
    }
  }
  return { terms: folded, hasConflict };
}

// ---------- 状态空间工具：状态用位掩码表示 ----------

function initialMask(scenario) {
  let mask = 0;
  scenario.states.forEach((s, i) => {
    if (s.initial) mask |= 1 << i;
  });
  return mask;
}

function conditionMaskAndNeed(scenario, conds) {
  let need = 0;
  let mask = 0;
  const idx = new Map(scenario.states.map((s, i) => [s.id, i]));
  for (const c of conds) {
    const i = idx.get(c.stateId);
    if (i === undefined) continue;
    need |= 1 << i;
    if (c.value) mask |= 1 << i;
  }
  return { need, mask };
}

function optionAvailable(option, stateMask, scenario) {
  const { need, mask } = conditionMaskAndNeed(scenario, option.conditions);
  return (stateMask & need) === mask;
}

function applyChanges(option, stateMask, scenario) {
  const idx = new Map(scenario.states.map((s, i) => [s.id, i]));
  for (const c of option.changes) {
    const i = idx.get(c.stateId);
    if (i === undefined) continue;
    if (c.value) stateMask |= 1 << i;
    else stateMask &= ~(1 << i);
  }
  return stateMask;
}

function formatStateValues(scenario, mask) {
  return scenario.states.map((s, i) => ({
    id: s.id,
    name: s.name,
    value: ((mask >> i) & 1) === 1,
  }));
}

// ---------- 评分 ----------
// 规则冻结在版本内容里：选项的 score 为 -10..10 整数。
// 旧版本（早于评分功能发布）的选项没有分值字段，一律按 0 分处理。

function findOption(scenario, nodeId, optionId) {
  const node = scenario.nodes.find((n) => n.id === nodeId);
  return node ? node.options.find((o) => o.id === optionId) || null : null;
}

function optionScore(option) {
  return option && Number.isInteger(option.score) ? option.score : 0;
}

function optionScoreNote(option) {
  return option && typeof option.scoreNote === 'string' ? option.scoreNote : '';
}

/**
 * 发布前分析：从初态出发枚举所有可达的 (节点, 状态组合)。
 * 返回：
 *  - reachableKeys
 *  - deadEnds:   可达的非结局顶点，且没有任何可选边（无路可走）
 *  - doomed:     可达的非结局顶点，无法保证抵达结局（可无限循环）
 *  - unreachableNodeIds: 从初态到不了的节点（警告）
 */
function analyze(scenario) {
  const nodesById = new Map(scenario.nodes.map((n) => [n.id, n]));
  const startKey = `${scenario.startNodeId}|${initialMask(scenario)}`;

  // 顶点 -> {nodeId, mask, edges:[{optionId,toKey}]}
  const V = new Map();
  const queue = [startKey];
  const seen = new Set([startKey]);

  while (queue.length) {
    const key = queue.shift();
    const [nodeId, maskStr] = key.split('|');
    const mask = Number(maskStr);
    const node = nodesById.get(nodeId);
    if (!node || node.isEnd) {
      if (!V.has(key)) V.set(key, { nodeId, mask, edges: [], end: !node || node.isEnd });
      continue;
    }
    const edges = [];
    for (const o of node.options) {
      if (!optionAvailable(o, mask, scenario)) continue;
      const nextMask = applyChanges(o, mask, scenario);
      const toKey = `${o.toNodeId}|${nextMask}`;
      edges.push({ optionId: o.id, toKey });
      if (!seen.has(toKey)) {
        seen.add(toKey);
        queue.push(toKey);
      }
    }
    V.set(key, { nodeId, mask, edges, end: false });
  }

  const reachableKeys = seen;

  // 死路：非结局顶点没有可选边
  const deadEnds = [];
  for (const key of reachableKeys) {
    const v = V.get(key);
    const node = nodesById.get(v.nodeId);
    if (v.end) continue;
    if (v.edges.length === 0) deadEnds.push(key);
  }

  // 无限循环检测：good = 结局顶点；
  // 一个非结局顶点，若存在一条边直达 good，则“可以”抵达结局——
  // 但需求是“不能有可无限循环而不抵达结局的路径”，即所有路径都必须终止。
  // 因此：顶点安全 当且仅当 它是结局，或 它是有至少一条边且所有边都指向安全顶点。
  // 用单调收缩（greatest fixed point）求“可能无法终止”的顶点。
  const safe = new Set();
  for (const key of reachableKeys) {
    if (V.get(key).end) safe.add(key);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of reachableKeys) {
      if (safe.has(key)) continue;
      const v = V.get(key);
      if (v.edges.length > 0 && v.edges.every((e) => safe.has(e.toKey))) {
        safe.add(key);
        changed = true;
      }
    }
  }
  const doomed = [];
  for (const key of reachableKeys) {
    if (V.get(key).end) continue;
    if (!safe.has(key)) doomed.push(key);
  }

  // 到不了的节点
  const reachedNodeIds = new Set();
  for (const key of reachableKeys) reachedNodeIds.add(key.split('|')[0]);
  const unreachableNodeIds = scenario.nodes.map((n) => n.id).filter((id) => !reachedNodeIds.has(id));

  return { V, reachableKeys, deadEnds, doomed, unreachableNodeIds, startKey, initialMask: initialMask(scenario) };
}

// 为某个问题顶点生成从初态出发的可复现路径（BFS 父指针）。
function witnessPath(graph, targetKey) {
  const { V, startKey } = graph;
  const parent = new Map(); // key -> {fromKey, optionId}
  const q = [startKey];
  const visited = new Set([startKey]);
  while (q.length) {
    const key = q.shift();
    if (key === targetKey) break;
    const v = V.get(key);
    for (const e of v.edges) {
      if (!visited.has(e.toKey)) {
        visited.add(e.toKey);
        parent.set(e.toKey, { fromKey: key, optionId: e.optionId });
        q.push(e.toKey);
      }
    }
  }
  const chain = [];
  let cur = targetKey;
  while (cur !== startKey) {
    const p = parent.get(cur);
    if (!p) break;
    chain.unshift({ fromKey: p.fromKey, optionId: p.optionId, toKey: cur });
    cur = p.fromKey;
  }
  return chain;
}

// 从问题顶点出发，找出一条坏走法：进入另一个 doomed 后继（并尽量发现环）。
function findBadContinuation(graph, key) {
  const { V } = graph;
  const v = V.get(key);
  const stack = [key];
  const onStack = new Set([key]);
  const edgeStack = [];

  function dfs(k) {
    const vv = V.get(k);
    for (const e of vv.edges) {
      if (safeSetForContinuation.has(e.toKey)) continue; // 走向安全顶点不算坏走法
      edgeStack.push({ fromKey: k, optionId: e.optionId, toKey: e.toKey });
      if (onStack.has(e.toKey)) {
        // 找到环：截出环部分
        const cycStart = stack.indexOf(e.toKey);
        const cycle = edgeStack.slice(cycStart);
        const prefix = edgeStack.slice(0, cycStart);
        return { prefix, cycle };
      }
      onStack.add(e.toKey);
      stack.push(e.toKey);
      const r = dfs(e.toKey);
      if (r) return r;
      stack.pop();
      onStack.delete(e.toKey);
      edgeStack.pop();
    }
    return null;
  }

  // safe 集合：复用 analyze 的收缩结果代价较大，这里用“后继全部安全”规则在 V 上现算
  // （graph 未直接携带 safe，则按 doomed 集合判定：非 doomed 即安全）
  const safeSetForContinuation = new Set();
  for (const k of graph.reachableKeys) {
    if (!graph.doomed.includes(k) || V.get(k).end) safeSetForContinuation.add(k);
  }
  return dfs(key);
}

function decodeKey(key) {
  const i = key.lastIndexOf('|');
  return { nodeId: key.slice(0, i), mask: Number(key.slice(i + 1)) };
}

function formatPathReport(scenario, segments) {
  const nodesById = new Map(scenario.nodes.map((n) => [n.id, n]));
  const opts = new Map();
  for (const n of scenario.nodes) {
    for (const o of n.options) opts.set(`${n.id}|${o.id}`, o);
  }
  function vertexLabel(key) {
    const { nodeId, mask } = decodeKey(key);
    const node = nodesById.get(nodeId);
    const state = formatStateValues(scenario, mask)
      .map((s) => `${s.name}=${s.value ? '是' : '否'}`)
      .join('，');
    return `${node ? node.title : nodeId}（状态：${state || '无'}）`;
  }
  return segments.map((seg, i) => {
    const o = opts.get(`${decodeKey(seg.fromKey).nodeId}|${seg.optionId}`);
    return `第 ${i + 1} 步：在【${vertexLabel(seg.fromKey)}】选择「${o ? o.label : seg.optionId}」→ 到达【${vertexLabel(seg.toKey)}】`;
  });
}

module.exports = {
  MAX_STATES,
  SCORE_MIN,
  SCORE_MAX,
  SCORE_NOTE_MAX,
  normalizeDraft,
  analyze,
  witnessPath,
  findBadContinuation,
  formatPathReport,
  formatStateValues,
  initialMask,
  optionAvailable,
  applyChanges,
  conditionMaskAndNeed,
  decodeKey,
  findOption,
  optionScore,
  optionScoreNote,
};
