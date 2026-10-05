'use strict';

// ====================== 基础工具 ======================

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function uid(prefix = 'id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

function fmtTime(t) {
  return t ? t.replace('T', ' ').slice(0, 16) : '';
}

let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ====================== Tab 切换 ======================

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    const which = tab.dataset.tab;
    $('#view-trainee').hidden = which !== 'trainee';
    $('#view-trainer').hidden = which !== 'trainer';
    $('#view-rooms').hidden = which !== 'rooms';
    $('#view-tasks').hidden = which !== 'tasks';
    leaveManageView();
    if (which === 'trainee') { loadPublished(); loadSessionList(); }
    if (which === 'rooms') { leaveRoomView(); loadRoomHome(); }
    if (which === 'tasks') { loadTaskHome(); }
    if (which === 'trainer') {
      leaveRoomView();
      coverageCtx = null;
      $('#trainer-coverage').hidden = true;
      $('#trainer-editor').hidden = true;
      $('#trainer-home').hidden = false;
      loadScenarios();
    }
  });
});

// ====================== 学员端 ======================

let currentSession = null;
// 会话上下文：{ kind:'normal' } 普通演练；{ kind:'task', taskId, token, task, attemptNo, ... } 训练任务的计次尝试
let sessionCtx = { kind: 'normal' };

async function loadPublished() {
  const list = await api('/api/published');
  const box = $('#published-list');
  if (!list.length) {
    box.innerHTML = '<div class="muted">暂无已发布情境。请培训师在“编排”页发布后再开始演练。</div>';
    return;
  }
  box.innerHTML = list.map((s) => `
    <div class="card sc-card">
      <div class="title">${esc(s.title)}</div>
      <div class="meta">
        <span class="badge v">v${s.current_version}</span>
        发布于 ${fmtTime(s.published_at)}
      </div>
      <div style="margin-top:10px">
        <button class="btn primary" data-start-id="${esc(s.id)}">开始新演练</button>
      </div>
    </div>`).join('');
}

$('#btn-reload-published').addEventListener('click', () => { loadPublished(); loadSessionList(); });

$('#published-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-start-id]');
  if (!btn) return;
  const traineeName = $('#trainee-name').value.trim();
  try {
    const snap = await api('/api/sessions', { method: 'POST', body: { scenarioId: btn.dataset.startId, traineeName } });
    enterSession(snap);
    toast('已开始新演练（绑定当前最新发布版）', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});

async function loadSessionList() {
  const list = await api('/api/sessions');
  const box = $('#session-list');
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <table class="ses-table">
      <thead><tr><th>会话码</th><th>情境</th><th>版本</th><th>状态</th><th>步数</th><th>总分</th><th>来源</th><th>学员</th><th></th></tr></thead>
      <tbody>
        ${list.map((s) => `
          <tr>
            <td><code>${esc(s.code)}</code></td>
            <td>${esc(s.scenario_title)}</td>
            <td>v${s.version}</td>
            <td class="${s.status === 'active' ? 'status-active' : 'status-ended'}">${s.status === 'active' ? '进行中' : '已结局'}</td>
            <td>${s.step_no}</td>
            <td><b class="${scoreClass(s.total_score || 0)}">${s.total_score || 0}</b></td>
            <td>${s.room_code
              ? `<span title="共识演练房间的共享会话，须经房间投票结算推进">🗳️ 房间 <code>${esc(s.room_code)}</code></span>`
              : (s.parent_code
                ? `分支↩<code data-lineage-jump="${esc(s.parent_code)}" title="查看源会话">${esc(s.parent_code)}</code>@${s.fork_step_no}步`
                : '<span class="muted">原始</span>')}</td>
            <td>${esc(s.trainee_name || '—')}</td>
            <td class="ses-actions">
              <button class="btn sm" data-resume="${esc(s.code)}">${s.status === 'active' ? '继续' : '查看'}</button>
              <button class="btn sm" data-fork="${esc(s.code)}" title="从历史步创建复盘分支">🌿 分叉</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

$('#session-list').addEventListener('click', async (e) => {
  const jump = e.target.closest('[data-lineage-jump]');
  if (jump) {
    try {
      const snap = await api(`/api/sessions/${encodeURIComponent(jump.dataset.lineageJump)}`);
      enterSession(snap);
    } catch (err) { toast(err.message, 'err'); }
    return;
  }
  const forkBtn = e.target.closest('[data-fork]');
  if (forkBtn) {
    try {
      const snap = await api(`/api/sessions/${encodeURIComponent(forkBtn.dataset.fork)}`);
      enterSession(snap);
      openForkPanel();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }
  const btn = e.target.closest('[data-resume]');
  if (btn) {
    try {
      const snap = await api(`/api/sessions/${encodeURIComponent(btn.dataset.resume)}`);
      enterSession(snap);
    } catch (err) { toast(err.message, 'err'); }
  }
});

function openForkPanel() {
  const card = document.querySelector('.fork-card');
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 1200);
  }
  const sel = $('#fork-step-select');
  if (sel && sel.options.length) sel.focus();
}

$('#btn-resume').addEventListener('click', async () => {
  const code = $('#resume-code').value.trim();
  if (!code) return toast('请输入会话码');
  try {
    const snap = await api(`/api/sessions/${encodeURIComponent(code)}`);
    enterSession(snap);
  } catch (err) { toast(err.message, 'err'); }
});

$('#btn-exit-session').addEventListener('click', () => {
  if (sessionCtx.kind === 'task') {
    // 任务会话：返回训练任务页，并刷新“我的尝试”
    const { taskId, token } = sessionCtx;
    sessionCtx = { kind: 'normal' };
    currentSession = null;
    $('#trainee-session').hidden = true;
    $('#view-trainee').hidden = true;
    $('#view-tasks').hidden = false;
    loadTaskHome();
    refreshMyTaskSummary(taskId, token);
    return;
  }
  currentSession = null;
  $('#trainee-session').hidden = true;
  $('#trainee-home').hidden = false;
  loadSessionList();
});

function enterSession(snap) {
  sessionCtx = { kind: 'normal' };
  currentSession = snap;
  $('#trainee-home').hidden = true;
  $('#trainee-session').hidden = false;
  hideBanner();
  renderSession();
}

// 训练任务：凭「任务编号 + 个人参与凭证」开始/续做后进入会话视图（复用学员会话界面）
function enterTaskSession(r) {
  sessionCtx = {
    kind: 'task',
    taskId: r.task.id,
    token: r.__token,
    task: r.task,
    attemptNo: r.attemptNo,
    maxAttempts: r.maxAttempts,
    attemptsUsed: r.attemptsUsed,
    attemptsLeft: r.attemptsLeft,
  };
  currentSession = { ...r.session, scenarioTitle: r.task.scenarioTitle };
  $('#view-tasks').hidden = true;
  $('#view-trainee').hidden = false;
  $('#trainee-home').hidden = true;
  $('#trainee-session').hidden = false;
  hideBanner();
  renderSession();
  showBanner(
    `${r.resumed ? '已回到你未完成的尝试（不额外消耗次数）' : `已开始第 ${r.attemptNo} 次尝试`}`
    + `：本任务每人最多 ${r.maxAttempts} 次，你已用 ${r.attemptsUsed} 次；及格分 ${r.task.passScore}，`
    + `截止 ${new Date(r.task.deadlineMs).toLocaleString('zh-CN', { hour12: false })}（截止后不能开新尝试，可续做未结束的会话）。`,
    'info');
}

function hideBanner() {
  const b = $('#ses-banner');
  b.className = 'banner hidden';
  b.textContent = '';
}

function showBanner(msg, kind) {
  const b = $('#ses-banner');
  b.textContent = msg;
  b.className = 'banner ' + kind;
}

function renderSession() {
  const s = currentSession;
  if (!s) return;
  const isTask = sessionCtx.kind === 'task';
  $('#ses-scenario-title').textContent = s.scenarioTitle || '';
  $('#ses-code').textContent = s.code;
  $('#ses-version').textContent = 'v' + s.version;
  $('#ses-step').textContent = s.stepNo;
  $('#ses-score').textContent = s.totalScore;
  $('#ses-score').className = scoreClass(s.totalScore);

  // 溯源标记 / 任务标记
  const lin = s.lineage || {};
  $('#ses-lineage').innerHTML = isTask
    ? ` · <span class="task-flag" title="训练任务的计次尝试，只能凭本人参与凭证操作">🎯 任务 <code>${esc(sessionCtx.taskId)}</code> · 第 ${sessionCtx.attemptNo}/${sessionCtx.maxAttempts} 次尝试 · 及格分 ${sessionCtx.task.passScore}</span>`
    : (lin.isBranch
      ? ` · <span class="branch-flag" title="该会话是复盘分支">🌿 分支（源 <code data-lineage-jump="${esc(lin.parentCode)}">${esc(lin.parentCode)}</code> 的第 ${lin.forkStepNo} 步分叉）</span>`
      : '');

  const node = s.currentNode;
  $('#node-kick').textContent = node && node.isEnd ? '结局' : '当前情境';
  $('#node-title').textContent = node ? node.title : '（节点缺失）';
  $('#node-narrative').textContent = node && node.narrative ? node.narrative : '';

  // 状态
  $('#state-list').innerHTML = s.states.map((st) => `
    <div class="state-row">
      <span>${esc(st.name)}</span>
      <span class="state-val ${st.value ? 'yes' : 'no'}">${st.value ? '● 是' : '○ 否'}</span>
    </div>`).join('');

  // 选项
  const optBox = $('#option-list');
  if (s.status === 'ended') {
    optBox.innerHTML = '<div class="muted">演练已结束。</div>';
    if (isTask) {
      const passScore = sessionCtx.task.passScore;
      const passed = s.totalScore >= passScore;
      showBanner(
        `本次尝试结束：已到达结局「${node ? node.title : ''}」，共 ${s.stepNo} 步，总分 <b>${s.totalScore}</b> 分。`
        + `${passed ? `✅ 已达到及格分 ${passScore}` : `❌ 未达到及格分 ${passScore}`}`
        + `（第 ${sessionCtx.attemptNo}/${sessionCtx.maxAttempts} 次；任务按各人最高已结束总分判定，`
        + (sessionCtx.attemptsLeft > 0 ? `还可再试 ${sessionCtx.attemptsLeft} 次` : '次数已用完')
        + '）。返回任务页可继续。',
        passed ? 'ok' : 'error');
    } else {
      showBanner(`演练结束：已到达结局「${node ? node.title : ''}」，共 ${s.stepNo} 步，总分 <b>${s.totalScore}</b> 分。${lin.isBranch ? '（本会话为复盘分支，可在右侧从更早的步骤再次分叉）' : '（可在右侧从历史步分叉复盘）'}`, 'ok');
    }
  } else {
    const avail = s.availableOptions.map((o) => `
      <button class="option-btn" data-opt="${esc(o.id)}">
        ${esc(o.label)}
        ${o.conditions.length ? `<span class="conds">条件：${o.conditions.map((c) => condText(s, c)).join('；')}</span>` : ''}
      </button>`).join('');
    const unavail = (s.unavailableOptions || []).map((o) => `
      <button class="option-btn disabled-opt" data-opt="${esc(o.id)}" title="当前条件不满足，提交也会被服务器拒绝">
        🔒 ${esc(o.label)}
        <span class="lock">${esc(o.reason)}：${o.failingConditions.map((f) => `${esc(f.stateName)} 需为「${f.required ? '是' : '否'}」`).join('；')}</span>
      </button>`).join('');
    optBox.innerHTML = (avail || '<div class="muted">当前没有可选项。</div>') + unavail;
  }

  // 路径
  $('#path-list').innerHTML = s.path.map((p) => renderPathItem(p, s)).join('');

  // 任务会话不提供复盘分叉与家族对照（计次尝试不得分叉）；普通会话照常
  const forkCard = document.querySelector('.fork-card');
  if (forkCard) forkCard.style.display = isTask ? 'none' : '';
  const lineageCard = $('#lineage-card');
  if (lineageCard) lineageCard.style.display = isTask ? 'none' : '';
  if (isTask) {
    $('#lineage-box').innerHTML = '';
  } else {
    // 复盘分叉：可选分歧步 0..当前步号（结局步即当前步会在服务端拒绝，这里直接禁选）
    renderForkStepSelect(s);
    // 来源与分支对照
    loadLineageView(s.code);
  }
}

function scoreClass(v) {
  if (v > 0) return 'score-pos';
  if (v < 0) return 'score-neg';
  return 'score-zero';
}

function scoreBadge(score) {
  const v = Number.isInteger(score) ? score : 0;
  const sign = v > 0 ? '+' : '';
  return `<span class="step-score ${scoreClass(v)}" title="本步得分">${sign}${v} 分</span>`;
}

function renderPathItem(p, snap) {
  const isFinal = snap && p.toNodeTitle && snap.status === 'ended' && p.step === snap.stepNo;
  const note = p.scoreNote ? `<span class="pl-note">评分说明：${esc(p.scoreNote)}</span>` : '';
  return `
    <li>
      <b>第 ${p.step} 步</b>：${esc(p.fromNodeTitle)}
      —「${esc(p.optionLabel)}」→
      <span class="${isFinal ? 'pl-end' : ''}">${esc(p.toNodeTitle)}</span>
      ${scoreBadge(p.score)}
      <span class="pl-sub">状态：${p.stateAfter.map((x) => `${esc(x.name)}=${x.value ? '是' : '否'}`).join('，') || '无'}</span>
      ${note}
    </li>`;
}

function renderForkStepSelect(s) {
  const sel = $('#fork-step-select');
  const nodeTitleAt = (step) => {
    if (step === 0) return s.startNodeTitle || '初态';
    const p = s.path.find((x) => x.step === step);
    return p ? p.toNodeTitle : '?';
  };
  // 已结束：默认选中结局步之前那一步（最后一个可分叉步）；进行中：默认可从当前步分叉
  const preferred = s.status === 'ended' ? Math.max(0, s.stepNo - 1) : s.stepNo;
  let html = '';
  for (let k = 0; k <= s.stepNo; k++) {
    const isEnd = k === s.stepNo && s.status === 'ended';
    const selAttr = k === preferred ? 'selected' : '';
    html += `<option value="${k}" ${isEnd ? 'disabled' : ''} ${selAttr}>第 ${k} 步 · ${esc(nodeTitleAt(k))}${isEnd ? '（结局步，不可分叉）' : ''}</option>`;
  }
  sel.innerHTML = html;
  $('#fork-name').value = '';
}

function condText(snap, c) {
  const st = snap.states.find((x) => x.id === c.stateId);
  return `${st ? st.name : c.stateId}=${c.value ? '是' : '否'}`;
}

$('#option-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-opt]');
  if (!btn || !currentSession) return;
  if (currentSession.status !== 'active') return;
  const optionId = btn.dataset.opt;
  // 防重复点击：以本地当前步号提交，服务器比对步号决定是否推进
  const stepNo = currentSession.stepNo;
  const isTask = sessionCtx.kind === 'task';
  // 任务会话只能凭本人参与凭证经任务入口推进；普通会话走单人入口
  const url = isTask
    ? `/api/tasks/${encodeURIComponent(sessionCtx.taskId)}/move`
    : `/api/sessions/${currentSession.code}/move`;
  const body = isTask ? { token: sessionCtx.token, optionId, stepNo } : { optionId, stepNo };
  try {
    const snap = await api(url, { method: 'POST', body });
    if (isTask) {
      // 同步任务计数信息（次数/剩余），供结束横幅与元信息使用
      sessionCtx.attemptsUsed = snap.attemptsUsed ?? sessionCtx.attemptsUsed;
      sessionCtx.attemptsLeft = snap.attemptsLeft ?? sessionCtx.attemptsLeft;
      if (snap.task) sessionCtx.task = snap.task;
    }
    currentSession = snap;
    hideBanner();
    renderSession();
    if (!isTask) loadSessionList();
    if (snap.lastMove) {
      const lm = snap.lastMove;
      const sign = lm.score > 0 ? '+' : '';
      showBanner(
        `本步得分 ${sign}${lm.score} 分，当前累计 ${lm.totalScore} 分。`
        + (lm.scoreNote ? ` 评分说明：${lm.scoreNote}` : ''),
        lm.score > 0 ? 'ok' : (lm.score < 0 ? 'error' : 'info'));
    }
  } catch (err) {
    // 过期/不满足条件：展示服务器返回的原因与现状，不推进
    const reason = err.message;
    if (err.data && err.data.current) {
      currentSession = { ...currentSession, ...err.data.current, scenarioTitle: currentSession.scenarioTitle };
      renderSession();
    }
    showBanner(`选择被拒绝：${reason}`, 'error');
  }
});

// ====================== 培训师：复盘分叉 ======================

$('#btn-fork').addEventListener('click', async () => {
  if (!currentSession) return;
  if (sessionCtx.kind === 'task') return toast('训练任务的计次尝试不支持复盘分叉', 'err');
  const sel = $('#fork-step-select');
  const forkStepNo = parseInt(sel.value, 10);
  if (!Number.isInteger(forkStepNo)) return toast('请选择分歧步号');
  const traineeName = $('#fork-name').value.trim();
  // observedStepNo 携带“所见的源当前步号”，服务端比对，源会话若已被推进则拒绝并返回其当前步号
  const observedStepNo = currentSession.stepNo;
  const sourceCode = currentSession.code;
  try {
    const snap = await api(`/api/sessions/${encodeURIComponent(sourceCode)}/fork`, {
      method: 'POST',
      body: { forkStepNo, observedStepNo, traineeName },
    });
    enterSession(snap);
    showBanner(`已从源会话 ${sourceCode} 的第 ${forkStepNo} 步创建分支（沿用冻结版本 v${snap.version}），继承此前路径得分 ${snap.inheritedScore ?? snap.totalScore ?? 0} 分，后续选择只计本分支。`, 'ok');
    toast('分支已创建，可在此局面继续选择', 'ok');
    loadSessionList();
  } catch (err) {
    if (err.data && err.data.sourceCurrent && err.data.errorCode === 'STEP_STALE') {
      // 源步号已变化：刷新到源会话最新现状，让培训师重新选择分歧步
      try {
        const fresh = await api(`/api/sessions/${encodeURIComponent(sourceCode)}`);
        currentSession = fresh;
        renderSession();
      } catch (_) { /* 忽略二次刷新失败 */ }
    } else if (err.data && err.data.current) {
      currentSession = { ...currentSession, ...err.data.current, scenarioTitle: currentSession.scenarioTitle };
      renderSession();
    }
    showBanner(`分叉被拒绝：${err.message}`, 'error');
  }
});

// 会话页溯源标记 / 对照树内的会话跳转
$('#trainee-session').addEventListener('click', async (e) => {
  const jump = e.target.closest('[data-lineage-jump]');
  if (!jump) return;
  try {
    const snap = await api(`/api/sessions/${encodeURIComponent(jump.dataset.lineageJump)}`);
    enterSession(snap);
  } catch (err) { toast(err.message, 'err'); }
});

async function loadLineageView(code) {
  const box = $('#lineage-box');
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(code)}/lineage`);
    box.innerHTML = renderLineageNode(r.tree, code);
  } catch (err) {
    box.innerHTML = `<div class="muted">对照信息加载失败：${esc(err.message)}</div>`;
  }
}

function renderLineageNode(node, currentCode, depth = 0) {
  const isCurrent = node.code === currentCode;
  const isBranch = node.lineage && node.lineage.isBranch;
  const head = `
    <div class="lg-node ${isCurrent ? 'lg-current' : ''}" style="margin-left:${depth * 14}px">
      <div class="lg-head">
        ${isBranch ? '🌿' : '🟢'}
        <code data-lineage-jump="${esc(node.code)}" title="查看该会话">${esc(node.code)}</code>
        ${isBranch ? `<span class="muted">← 源 <code>${esc(node.lineage.parentCode)}</code>@第${node.lineage.forkStepNo}步分叉</span>` : '<span class="muted">原始会话</span>'}
        ${isCurrent ? '<span class="badge v">当前查看</span>' : ''}
      </div>
      <div class="lg-meta muted">
        v${node.version} · ${node.status === 'active' ? `<span class="status-active">进行中·第${node.stepNo}步</span>` : `<span class="status-ended">已结局·共${node.stepNo}步</span>`}
        · 总分 <b class="${scoreClass(node.totalScore)}">${node.totalScore}</b>
        · 当前：${esc(node.currentNode ? node.currentNode.title : '?')}${node.traineeName ? ' · ' + esc(node.traineeName) : ''}
      </div>
      ${node.path.length ? `
        <details class="lg-path" ${isCurrent ? 'open' : ''}>
          <summary>后续路径（${node.path.length} 步）${isBranch ? `；保留源第 1..${node.lineage.forkStepNo} 步，自第 ${node.lineage.forkStepNo} 步局面另走` : ''}</summary>
          <ol class="path-list">${node.path.map((p) => renderPathItem(p, node)).join('')}</ol>
        </details>` : '<div class="muted lg-meta">第 0 步（尚未选择）</div>'}
    </div>`;
  const children = (node.children || []).map((c) => renderLineageNode(c, currentCode, depth + 1)).join('');
  return head + children;
}

// ====================== 培训师端：列表 ======================

let editing = null; // { id, currentVersion, draft }

async function loadScenarios() {
  const list = await api('/api/scenarios');
  const box = $('#scenario-list');
  if (!list.length) {
    box.innerHTML = '<div class="muted">还没有情境，点击右上角“新建情境”开始编排。</div>';
    return;
  }
  box.innerHTML = list.map((s) => `
    <div class="card sc-card" data-open="${esc(s.id)}">
      <div class="title">${esc(s.title)}</div>
      <div class="meta">
        ${s.current_version > 0
          ? `<span class="badge v">已发布 v${s.current_version}</span>`
          : '<span class="badge draft">未发布</span>'}
        会话 ${s.session_count} 个 · 更新于 ${fmtTime(s.updated_at)}
      </div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <span class="btn">编排 / 查看</span>
        ${s.current_version > 0
          ? `<button class="btn" data-coverage="${esc(s.id)}" data-version="${s.current_version}" title="查看已发布版本的处置覆盖情况">📊 处置覆盖报告</button>`
          : ''}
      </div>
    </div>`).join('');
}

$('#scenario-list').addEventListener('click', (e) => {
  const covBtn = e.target.closest('[data-coverage]');
  if (covBtn) {
    e.stopPropagation();
    openCoverage(covBtn.dataset.coverage, parseInt(covBtn.dataset.version, 10));
    return;
  }
  const card = e.target.closest('[data-open]');
  if (card) openEditor(card.dataset.open);
});

$('#btn-new-scenario').addEventListener('click', async () => {
  const template = {
    title: '未命名事故处置情境',
    states: [{ id: 's1', name: '新状态（如：电源已切断）', initial: false }],
    startNodeId: 'n1',
    nodes: [
      { id: 'n1', title: '起点', narrative: '描述事故发生的初始情况……', isEnd: false, options: [
        { id: 'o1', label: '第一个处置选择', conditions: [], changes: [], toNodeId: 'n2', score: null, scoreNote: '' },
      ] },
      { id: 'n2', title: '结局', narrative: '描述该处置的结果……', isEnd: true, options: [] },
    ],
  };
  try {
    const r = await api('/api/scenarios', { method: 'POST', body: template });
    editing = { id: r.id, currentVersion: 0, draft: r.draft };
    showEditor();
    toast('已创建，可以开始编排');
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btn-back-list').addEventListener('click', async () => {
  editing = null;
  $('#trainer-editor').hidden = true;
  $('#trainer-home').hidden = false;
  await loadScenarios();
});

async function openEditor(id) {
  const detail = await api(`/api/scenarios/${id}`);
  if (!detail.draft) { toast('该情境没有草稿数据'); return; }
  editing = { id: detail.id, currentVersion: detail.currentVersion, draft: detail.draft };
  showEditor();
}

function showEditor() {
  $('#trainer-home').hidden = true;
  $('#trainer-editor').hidden = false;
  $('#editor-report').className = 'report hidden';
  renderEditor();
}

// ====================== 培训师端：编辑器渲染 ======================

function stateInUse(stateId) {
  for (const n of editing.draft.nodes) {
    for (const o of n.options) {
      if (o.conditions.some((t) => t.stateId === stateId) || o.changes.some((t) => t.stateId === stateId)) {
        return n.title || n.id;
      }
    }
  }
  return null;
}

function renderEditor() {
  const d = editing.draft;
  $('#editor-title').value = d.title;
  $('#editor-version-label').textContent = editing.currentVersion > 0
    ? `当前已发布 v${editing.currentVersion}；发布将生成 v${editing.currentVersion + 1}，进行中的旧会话不受影响`
    : '尚未发布；发布后学员方可开始演练';

  // 状态
  const sBox = $('#state-editor-list');
  sBox.innerHTML = d.states.map((s, i) => `
    <div class="state-edit-row">
      <input class="input sm" style="width:70px" value="${esc(s.id)}" data-bind="state-id" data-i="${i}" placeholder="id" />
      <input class="input name" value="${esc(s.name)}" data-bind="state-name" data-i="${i}" placeholder="状态名称" />
      <label class="checkbox"><input type="checkbox" data-bind="state-initial" data-i="${i}" ${s.initial ? 'checked' : ''}/> 初值为“是”</label>
      <button class="btn ghost danger" data-act="del-state" data-i="${i}">删除</button>
    </div>`).join('');
  $('#btn-add-state').disabled = d.states.length >= 8;

  // 起点选择
  const startSel = $('#start-select');
  startSel.innerHTML = d.nodes.map((n) =>
    `<option value="${esc(n.id)}" ${n.id === d.startNodeId ? 'selected' : ''}>${esc(n.title || n.id)}</option>`).join('');

  // 节点
  const box = $('#node-editor-list');
  box.innerHTML = d.nodes.map((n, ni) => {
    const optsHtml = n.isEnd ? '' : n.options.map((o, oi) => renderOption(n, o, ni, oi)).join('');
    return `
    <div class="node-block ${n.isEnd ? 'is-end' : ''}">
      <div class="node-block-head">
        <input class="input sm" style="width:90px" value="${esc(n.id)}" data-bind="node-id" data-ni="${ni}" placeholder="节点id" />
        <input class="input node-title-input" value="${esc(n.title)}" data-bind="node-title" data-ni="${ni}" placeholder="节点标题" />
        ${n.id === d.startNodeId ? '<span class="start-flag">▶ 起点</span>' : ''}
        <label class="checkbox"><input type="checkbox" data-bind="node-end" data-ni="${ni}" ${n.isEnd ? 'checked' : ''}/> 结局节点</label>
        <button class="btn ghost danger" data-act="del-node" data-ni="${ni}">删除节点</button>
      </div>
      <div class="field">
        <textarea class="input" data-bind="node-narr" data-ni="${ni}" placeholder="情境描述（学员可见）">${esc(n.narrative)}</textarea>
      </div>
      ${n.isEnd ? '' : `
        <div class="field">
          <label>选项（条件满足时学员可见可选；选择后应用状态变更并跳转）</label>
          ${optsHtml || '<div class="muted">暂无选项（非结局节点无选项在发布检查时会被判为无路可走）</div>'}
          <button class="btn dashed" data-act="add-opt" data-ni="${ni}">＋ 添加选项</button>
        </div>`}
    </div>`;
  }).join('');
}

function stateOptions(selected) {
  return editing.draft.states.map((s) =>
    `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)} (${esc(s.id)})</option>`).join('');
}

function nodeOptions(selected) {
  return editing.draft.nodes.map((n) =>
    `<option value="${esc(n.id)}" ${n.id === selected ? 'selected' : ''}>${esc(n.title || n.id)}</option>`).join('');
}

function renderTermRows(kind, terms, ni, oi) {
  const verb = kind === 'cond' ? '要求' : '置为';
  return terms.map((t, ti) => `
    <div class="term-row">
      <span class="term-mini-label">${verb}</span>
      <select class="input sm" data-bind="${kind}-state" data-ni="${ni}" data-oi="${oi}" data-ti="${ti}">
        ${stateOptions(t.stateId)}
      </select>
      <select class="input sm" style="width:70px" data-bind="${kind}-value" data-ni="${ni}" data-oi="${oi}" data-ti="${ti}">
        <option value="true" ${t.value ? 'selected' : ''}>是</option>
        <option value="false" ${!t.value ? 'selected' : ''}>否</option>
      </select>
      <button class="btn ghost danger" data-act="del-${kind}" data-ni="${ni}" data-oi="${oi}" data-ti="${ti}">×</button>
    </div>`).join('');
}

function renderOption(n, o, ni, oi) {
  return `
    <div class="opt-block">
      <div class="opt-head">
        <input class="input sm" style="width:80px" value="${esc(o.id)}" data-bind="opt-id" data-ni="${ni}" data-oi="${oi}" placeholder="选项id" />
        <input class="input label" value="${esc(o.label)}" data-bind="opt-label" data-ni="${ni}" data-oi="${oi}" placeholder="选项文案（学员看到的处置动作）" />
        <button class="btn ghost danger" data-act="del-opt" data-ni="${ni}" data-oi="${oi}">删除</button>
      </div>
      <div class="field">
        <label>显示条件（全部满足时该选项可选）</label>
        ${renderTermRows('cond', o.conditions, ni, oi)}
        <button class="btn dashed" data-act="add-cond" data-ni="${ni}" data-oi="${oi}">＋ 添加条件</button>
      </div>
      <div class="field">
        <label>状态变更（选择后执行）</label>
        ${renderTermRows('chg', o.changes, ni, oi)}
        <button class="btn dashed" data-act="add-chg" data-ni="${ni}" data-oi="${oi}">＋ 添加变更</button>
      </div>
      <div class="term-row">
        <span class="term-mini-label">跳转</span>
        <select class="input sm" data-bind="opt-target" data-ni="${ni}" data-oi="${oi}">${nodeOptions(o.toNodeId)}</select>
      </div>
      <div class="field score-field">
        <label>评分（选择该选项的得分：-10 至 10 的整数，留空视为 0）</label>
        <div class="score-edit-row">
          <input class="input sm score-input" type="number" min="-10" max="10" step="1"
                 value="${o.score === undefined || o.score === null ? '' : esc(String(o.score))}"
                 data-bind="opt-score" data-ni="${ni}" data-oi="${oi}" placeholder="0" />
          <input class="input score-note" maxlength="500"
                 value="${esc(o.scoreNote || '')}"
                 data-bind="opt-score-note" data-ni="${ni}" data-oi="${oi}"
                 placeholder="评分说明（学员选后可见，可说明该处置好/坏在哪里）" />
        </div>
      </div>
    </div>`;
}

// ---------- 编辑器：结构变更（事件委托） ----------

$('#trainer-editor').addEventListener('click', onEditorAction);

function onEditorAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const d = editing.draft;
  const act = btn.dataset.act;
  const ni = +btn.dataset.ni;
  const oi = +btn.dataset.oi;
  const ti = +btn.dataset.ti;

  switch (act) {
    case 'add-state':
      if (d.states.length >= 8) return toast('至多 8 个现场状态');
      d.states.push({ id: uid('s'), name: '新状态', initial: false });
      break;
    case 'del-state': {
      const st = d.states[ni];
      const usedIn = stateInUse(st.id);
      if (usedIn) return toast(`状态「${st.name}」仍被节点「${usedIn}」的条件/变更引用，请先移除引用`, 'err');
      d.states.splice(ni, 1);
      break;
    }
    case 'add-node': {
      const id = uid('n');
      d.nodes.push({ id, title: '新节点', narrative: '', isEnd: false, options: [] });
      break;
    }
    case 'del-node': {
      const n = d.nodes[ni];
      if (!window.confirm(`确定删除节点「${n.title || n.id}」？指向它的选项会在保存时被服务端判为无效引用。`)) return;
      d.nodes.splice(ni, 1);
      if (d.startNodeId === n.id) d.startNodeId = d.nodes[0] ? d.nodes[0].id : '';
      break;
    }
    case 'add-opt':
      d.nodes[ni].options.push({
        id: uid('o'), label: '新选择', conditions: [], changes: [],
        toNodeId: d.nodes[ni].id, score: null, scoreNote: '',
      });
      break;
    case 'del-opt':
      d.nodes[ni].options.splice(oi, 1);
      break;
    case 'add-cond':
      if (!d.states.length) { toast('请先在右侧定义至少一个状态', 'err'); break; }
      d.nodes[ni].options[oi].conditions.push({ stateId: d.states[0].id, value: true });
      break;
    case 'del-cond':
      d.nodes[ni].options[oi].conditions.splice(ti, 1);
      break;
    case 'add-chg':
      if (!d.states.length) { toast('请先在右侧定义至少一个状态', 'err'); break; }
      d.nodes[ni].options[oi].changes.push({ stateId: d.states[0].id, value: true });
      break;
    case 'del-chg':
      d.nodes[ni].options[oi].changes.splice(ti, 1);
      break;
  }
  renderEditor();
}

// ---------- 编辑器：字段变更（不整体重绘，避免失焦） ----------

$('#trainer-editor').addEventListener('input', (e) => {
  const el = e.target;
  const b = el.dataset.bind;
  if (!b || !editing) return;
  const d = editing.draft;
  const ni = +el.dataset.ni, oi = +el.dataset.oi, ti = +el.dataset.ti, i = +el.dataset.i;
  switch (b) {
    case 'state-id': d.states[i].id = el.value; break;
    case 'state-name': d.states[i].name = el.value; break;
    case 'node-id': d.nodes[ni].id = el.value; break;
    case 'node-title': d.nodes[ni].title = el.value; break;
    case 'node-narr': d.nodes[ni].narrative = el.value; break;
    case 'opt-id': d.nodes[ni].options[oi].id = el.value; break;
    case 'opt-label': d.nodes[ni].options[oi].label = el.value; break;
    case 'opt-score': {
      const v = el.value.trim();
      // 留空按未填写处理（服务端保存时视为 0）；非整数/越界仍由服务端拒绝
      d.nodes[ni].options[oi].score = v === '' ? null : Number(v);
      break;
    }
    case 'opt-score-note': d.nodes[ni].options[oi].scoreNote = el.value; break;
    default: break;
  }
});

$('#trainer-editor').addEventListener('change', (e) => {
  const el = e.target;
  const b = el.dataset.bind;
  if (!b || !editing) return;
  const d = editing.draft;
  const ni = +el.dataset.ni, oi = +el.dataset.oi, ti = +el.dataset.ti, i = +el.dataset.i;
  switch (b) {
    case 'state-initial': d.states[i].initial = el.checked; break;
    case 'node-end': {
      const n = d.nodes[ni];
      if (el.checked && n.options.length > 0) {
        if (!window.confirm('结局节点不能携带选项，勾选将清空该节点的全部选项，确定？')) {
          el.checked = false;
          return;
        }
        n.options = [];
      }
      n.isEnd = el.checked;
      renderEditor();
      break;
    }
    case 'opt-target': d.nodes[ni].options[oi].toNodeId = el.value; break;
    case 'cond-state': d.nodes[ni].options[oi].conditions[ti].stateId = el.value; break;
    case 'cond-value': d.nodes[ni].options[oi].conditions[ti].value = el.value === 'true'; break;
    case 'chg-state': d.nodes[ni].options[oi].changes[ti].stateId = el.value; break;
    case 'chg-value': d.nodes[ni].options[oi].changes[ti].value = el.value === 'true'; break;
    default: break;
  }
});

$('#start-select').addEventListener('change', (e) => {
  editing.draft.startNodeId = e.target.value;
  renderEditor();
});

// ====================== 保存 / 检查 / 发布 ======================

$('#editor-title').addEventListener('input', (e) => {
  if (editing) editing.draft.title = e.target.value;
});

$('#btn-save-draft').addEventListener('click', saveDraft);
$('#btn-analyze').addEventListener('click', () => runAnalyze(true));
$('#btn-publish').addEventListener('click', publish);

async function saveDraft(showOk = true) {
  // 提交前即时校验分值：必须留空或为 -10..10 的整数（服务端仍会再次裁决）
  const scoreErrors = [];
  for (const n of editing.draft.nodes) {
    for (const o of n.options || []) {
      if (o.score === null || o.score === undefined || o.score === '') continue;
      if (!Number.isInteger(o.score) || o.score < -10 || o.score > 10) {
        scoreErrors.push(`节点「${n.title || n.id}」的选项「${o.label || o.id}」分值须为 -10 至 10 的整数（留空视为 0）`);
      }
    }
  }
  if (scoreErrors.length) {
    toast(scoreErrors[0], 'err');
    renderStructuralErrors({ error: '草稿分值不合法，未保存', errors: scoreErrors.map((m) => ({ code: 'OPTION_SCORE_INVALID', message: m })) });
    return false;
  }
  try {
    const r = await api(`/api/scenarios/${editing.id}/draft`, { method: 'PUT', body: editing.draft });
    if (showOk) toast('草稿已保存', 'ok');
    renderReport(r.publishReport, { titleOnly: false });
    return true;
  } catch (err) {
    renderStructuralErrors(err.data);
    return false;
  }
}

async function runAnalyze(persistFirst) {
  try {
    const r = await api(`/api/scenarios/${editing.id}/analyze`, {
      method: 'POST',
      body: { draft: editing.draft },
    });
    renderReport(r, {});
  } catch (err) {
    renderStructuralErrors(err.data);
  }
}

async function publish() {
  // 发布前先保存草稿；结构不合法则中止
  try {
    const r = await api(`/api/scenarios/${editing.id}/draft`, { method: 'PUT', body: editing.draft });
    if (!r.publishReport.ok) {
      renderReport(r.publishReport, {});
      toast('草稿已保存，但发布检查未通过', 'err');
      return;
    }
  } catch (err) {
    renderStructuralErrors(err.data);
    toast('草稿存在结构错误，已拒绝保存与发布', 'err');
    return;
  }
  try {
    const r = await api(`/api/scenarios/${editing.id}/publish`, { method: 'POST' });
    editing.currentVersion = r.publishedVersion;
    renderReport({ ok: true, problems: [], warnings: r.warnings || [] }, {
      successNote: `已发布 v${r.publishedVersion}，内容冻结。进行中的会话仍按旧版本继续，新会话使用本版本。`,
    });
    toast(`发布成功 v${r.publishedVersion}`, 'ok');
    renderEditor();
  } catch (err) {
    if (err.data && (err.data.problems || err.data.errors)) {
      if (err.data.problems) renderReport(err.data, {});
      else renderStructuralErrors(err.data);
    } else {
      toast(err.message, 'err');
    }
  }
}

function renderStructuralErrors(data) {
  const box = $('#editor-report');
  const errors = (data && data.errors) || [];
  box.className = 'report err';
  box.innerHTML = `
    <div class="r-title">❌ 草稿校验失败，未保存（共 ${errors.length} 项）</div>
    ${errors.map((x) => {
      const loc = x.at ? `<span class="muted">[${esc(formatAt(x.at))}]</span> ` : '';
      return `<div class="problem"><span class="p-kind">${esc(x.code)}</span><div>${loc}${esc(x.message)}</div></div>`;
    }).join('') || esc(data && data.error ? data.error : '未知错误')}`;
}

function formatAt(at) {
  if (!at) return '';
  const parts = [];
  if (at.field) parts.push(at.field);
  if (at.index !== undefined) parts.push(`#${at.index}`);
  if (at.optionIndex !== undefined) parts.push(`选项#${at.optionIndex}`);
  if (at.nodeId) parts.push(`节点${at.nodeId}`);
  if (at.optionId) parts.push(`选项${at.optionId}`);
  return parts.join(' ');
}

function renderReport(report, opts = {}) {
  const box = $('#editor-report');
  if (!report) return;
  const problems = report.problems || [];
  const warnings = report.warnings || [];
  if (report.ok && problems.length === 0) {
    box.className = 'report ok';
    box.innerHTML = `
      <div class="r-title">✅ 发布检查通过${opts.successNote ? '：已发布新版本' : ''}</div>
      <div>${esc(opts.successNote || '从初态出发，所有可达的非结局节点/状态组合都有出路，且所有路径都必然抵达结局。')}</div>
      ${warnings.map((w) => `<div class="warning-item">⚠ ${esc(w.message)}</div>`).join('')}`;
    return;
  }
  box.className = 'report err';
  box.innerHTML = `
    <div class="r-title">⛔ 发布检查未通过，已拒绝发布（${problems.length} 项）</div>
    ${problems.map((p) => `
      <div class="problem">
        <span class="p-kind">${p.kind === 'DEAD_END' ? '无路可走（非结局死路）' : '可无限循环（永不抵达结局）'}</span>
        <div>${esc(p.message)}</div>
        <div class="muted" style="margin-top:4px">问题发生时状态：${(p.vertex.states || []).map((s) => `${esc(s.name)}=${s.value ? '是' : '否'}`).join('，')}</div>
        <pre>可复现路径（从初态开始）：\n${(p.reproduciblePath || []).map(esc).join('\n') || '（起点即问题节点）'}</pre>
        ${p.cycle && p.cycle.length ? `<pre class="cycle">循环段（到达上述节点后重复执行即可永远不到结局）：\n${p.cycle.map(esc).join('\n')}</pre><div class="muted">${esc(p.hint || '')}</div>` : ''}
      </div>`).join('')}
    ${warnings.map((w) => `<div class="warning-item">⚠ ${esc(w.message)}</div>`).join('')}`;
}

// ====================== 培训师端：处置覆盖报告 ======================

let coverageCtx = null; // { scenarioId, version, uncoveredOnly, data }

$('#btn-coverage-from-editor').addEventListener('click', () => {
  if (!editing) return;
  if (editing.currentVersion < 1) return toast('该情境尚未发布，暂无冻结版本可统计', 'err');
  openCoverage(editing.id, editing.currentVersion);
});

$('#btn-coverage-back').addEventListener('click', () => {
  coverageCtx = null;
  $('#trainer-coverage').hidden = true;
  $('#trainer-home').hidden = false;
  loadScenarios();
});

$('#btn-coverage-reload').addEventListener('click', () => {
  if (coverageCtx) loadCoverage();
});

$('#coverage-version').addEventListener('change', (e) => {
  if (!coverageCtx) return;
  coverageCtx.version = parseInt(e.target.value, 10);
  loadCoverage();
});

$('#coverage-filter-uncovered').addEventListener('change', (e) => {
  if (!coverageCtx) return;
  coverageCtx.uncoveredOnly = e.target.checked;
  loadCoverage();
});

async function openCoverage(scenarioId, version) {
  $('#trainer-home').hidden = true;
  $('#trainer-editor').hidden = true;
  $('#trainer-coverage').hidden = false;
  coverageCtx = { scenarioId, version, uncoveredOnly: $('#coverage-filter-uncovered').checked, data: null };
  try {
    const detail = await api(`/api/scenarios/${encodeURIComponent(scenarioId)}`);
    const sel = $('#coverage-version');
    const versions = (detail.versions || []).slice().sort((a, b) => b.version - a.version);
    sel.innerHTML = versions.map((v) => `<option value="${v.version}">v${v.version}（${fmtTime(v.created_at)}）</option>`).join('');
    sel.value = String(version);
  } catch (err) {
    toast(err.message, 'err');
  }
  await loadCoverage();
}

async function loadCoverage() {
  if (!coverageCtx) return;
  const { scenarioId, version, uncoveredOnly } = coverageCtx;
  const itemsBox = $('#coverage-items');
  const summaryBox = $('#coverage-summary');
  itemsBox.innerHTML = '<div class="muted">统计中…</div>';
  summaryBox.innerHTML = '';
  let r;
  try {
    const qs = uncoveredOnly ? '?uncovered=1' : '';
    r = await api(`/api/scenarios/${encodeURIComponent(scenarioId)}/versions/${version}/coverage${qs}`);
  } catch (err) {
    coverageCtx.data = null;
    $('#coverage-title').textContent = '处置覆盖报告';
    $('#coverage-sub').textContent = '';
    summaryBox.innerHTML = '';
    itemsBox.innerHTML = `<div class="report err"><div class="r-title">无法生成覆盖报告（${esc(err.data && err.data.errorCode || 'ERROR')}）</div><div>${esc(err.message)}</div></div>`;
    return;
  }
  coverageCtx.data = r;
  $('#coverage-title').textContent = `📊 ${r.scenarioTitle} · v${r.version} 处置覆盖报告`;
  $('#coverage-sub').textContent = `冻结于 ${fmtTime(r.versionPublishedAt)}`;

  const t = r.totals;
  const pct = t.total ? Math.round((t.covered / t.total) * 1000) / 10 : 0;
  summaryBox.innerHTML = `
    <div class="coverage-stat-grid">
      <div class="cov-stat"><div class="cov-num">${t.total}</div><div class="muted">覆盖项总数</div></div>
      <div class="cov-stat covered"><div class="cov-num">${t.covered}</div><div class="muted">已覆盖（${pct}%）</div></div>
      <div class="cov-stat uncovered"><div class="cov-num">${t.uncovered}</div><div class="muted">未覆盖</div></div>
      <div class="cov-stat"><div class="cov-num">${t.sessionsConsidered}</div><div class="muted">绑定本版本的会话</div></div>
      <div class="cov-stat"><div class="cov-num">${t.familiesConsidered}</div><div class="muted">演练家族（原始+分支）</div></div>
    </div>
    <div class="report ${t.uncovered ? 'warn' : 'ok'}">
      ${t.uncovered
        ? `还有 <b>${t.uncovered}</b> 个「节点 × 进入状态 × 选项」组合从未被任何演练家族选到，勾选右上角“只看未覆盖项”可聚焦查漏。`
        : '所有可达处置组合都已被至少一个演练家族覆盖。'}
    </div>`;
  renderCoverageItems(r);
}

function renderCoverageItems(r) {
  const box = $('#coverage-items');
  const items = r.items;
  if (!items.length) {
    box.innerHTML = '<div class="muted">没有符合筛选条件的覆盖项。</div>';
    return;
  }
  box.innerHTML = `
    <table class="cov-table">
      <thead><tr><th style="width:46px">状态</th><th>进入时现场状态</th><th>节点</th><th>可选选项（处置）</th><th style="width:110px">覆盖家族数</th></tr></thead>
      <tbody>
        ${items.map((it) => {
          const stateName = new Map((it.entryStates || []).map((s) => [s.id, s.name]));
          return `
          <tr class="${it.covered ? '' : 'cov-uncovered'}">
            <td>${it.covered ? '<span class="cov-tag yes">已覆盖</span>' : '<span class="cov-tag no">未覆盖</span>'}</td>
            <td class="cov-states">${(it.entryStates || []).map((s) =>
              `<span class="mini-state ${s.value ? 'yes' : 'no'}">${esc(s.name)}=${s.value ? '是' : '否'}</span>`).join(' ')}</td>
            <td><b>${esc(it.nodeTitle)}</b><div class="muted">${esc(it.nodeId)}</div></td>
            <td>
              「${esc(it.option.label)}」<span class="muted">→ ${esc(it.option.toNodeTitle)}</span>
              ${it.option.conditions && it.option.conditions.length
                ? `<div class="muted">可选条件：${it.option.conditions.map((c) =>
                    `${esc(stateName.get(c.stateId) || c.stateId)}=${c.value ? '是' : '否'}`).join('；')}</div>` : ''}
            </td>
            <td class="cov-count ${it.coveredFamilies ? 'has' : ''}">
              <b>${it.coveredFamilies}</b>
              ${it.familyCodes && it.familyCodes.length
                ? `<div class="muted" title="贡献覆盖的家族根会话码">${it.familyCodes.slice(0, 3).map((c) => `<code>${esc(c)}</code>`).join(' ')}${it.familyCodes.length > 3 ? ` +${it.familyCodes.length - 3}` : ''}</div>`
                : '<div class="muted">尚无家族练到</div>'}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

// ====================== 共识演练（房间投票） ======================

// 房间凭证按房间码存 localStorage：{ [code]: { memberToken?, hostToken?, name? } }
function roomCreds() {
  try { return JSON.parse(localStorage.getItem('roomCreds') || '{}'); } catch (_) { return {}; }
}
function saveRoomCred(code, patch) {
  const all = roomCreds();
  all[code] = { ...(all[code] || {}), ...patch };
  localStorage.setItem('roomCreds', JSON.stringify(all));
}
function getRoomCred(code) {
  return roomCreds()[code] || {};
}

// 当前打开的房间视图上下文：{ code, memberToken, hostToken, data, timer }
let roomCtx = null;

async function loadRoomHome() {
  $('#rooms-home').hidden = false;
  $('#room-view').hidden = true;
  // 已发布情境供开启房间选择
  try {
    const list = await api('/api/published');
    const sel = $('#room-scenario');
    sel.innerHTML = list.length
      ? list.map((s) => `<option value="${esc(s.id)}">${esc(s.title)}（当前 v${s.current_version}）</option>`).join('')
      : '<option value="">（暂无已发布情境）</option>';
    await loadRoomVersions();
  } catch (err) { toast(err.message, 'err'); }
  await loadRoomList();
}

async function loadRoomVersions() {
  const id = $('#room-scenario').value;
  const sel = $('#room-version');
  if (!id) { sel.innerHTML = ''; return; }
  try {
    const detail = await api(`/api/scenarios/${encodeURIComponent(id)}`);
    const versions = (detail.versions || []).slice().sort((a, b) => b.version - a.version);
    sel.innerHTML = versions.map((v) =>
      `<option value="${v.version}">v${v.version}（冻结于 ${fmtTime(v.created_at)}）</option>`).join('');
  } catch (err) { sel.innerHTML = ''; }
}

$('#room-scenario').addEventListener('change', loadRoomVersions);
$('#btn-reload-rooms').addEventListener('click', loadRoomHome);

// 限时模式开关：勾选后展示每步时长输入
$('#room-timed-toggle').addEventListener('change', (e) => {
  $('#room-duration-row').hidden = !e.target.checked;
});

$('#btn-create-room').addEventListener('click', async () => {
  const scenarioId = $('#room-scenario').value;
  const version = parseInt($('#room-version').value, 10);
  if (!scenarioId) return toast('请先选择已发布情境', 'err');
  if (!Number.isInteger(version)) return toast('请选择冻结版本', 'err');
  const timed = $('#room-timed-toggle').checked;
  let stepDuration = null;
  if (timed) {
    stepDuration = parseInt($('#room-step-duration').value, 10);
    if (!Number.isInteger(stepDuration) || stepDuration < 30 || stepDuration > 3600) {
      return toast('每步时长必须是 30～3600 秒之间的整数', 'err');
    }
  }
  const blind = $('#room-blind-toggle').checked;
  try {
    const body = { scenarioId, version, blind };
    if (timed) body.stepDuration = stepDuration;
    const r = await api('/api/rooms', { method: 'POST', body });
    saveRoomCred(r.code, { hostToken: r.hostToken });
    $('#room-created').classList.remove('hidden');
    $('#room-join-out').textContent = r.joinCode;
    $('#room-host-out').textContent = r.hostToken;
    const modeText = [
      r.timed ? `限时每步 ${r.stepDurationSeconds} 秒` : '不限时',
      r.blind ? '🔒 盲投' : '公开投票',
    ].join(' · ');
    toast(`房间已开启（${modeText}，绑定 v${r.version}），把加入码发给学员`, 'ok');
    loadRoomList();
  } catch (err) { toast(err.message, 'err'); }
});

$('#btn-enter-host').addEventListener('click', () => {
  const code = $('#room-join-out').textContent.trim();
  const cred = getRoomCred(code);
  if (code && cred.hostToken) enterRoom(code, { hostToken: cred.hostToken });
});

$('#btn-join-room').addEventListener('click', async () => {
  const code = $('#join-code').value.trim();
  const name = $('#join-name').value.trim();
  if (!code) return toast('请输入加入码', 'err');
  try {
    const r = await api(`/api/rooms/${encodeURIComponent(code)}/join`, { method: 'POST', body: { name } });
    saveRoomCred(code, { memberToken: r.memberToken, name: r.memberName || '' });
    toast('已加入房间，可以对当前步投票了', 'ok');
    enterRoom(code, { memberToken: r.memberToken });
  } catch (err) { toast(err.message, 'err'); }
});

$('#btn-enter-host-manual').addEventListener('click', () => {
  const code = $('#host-code').value.trim();
  const hostToken = $('#host-token').value.trim();
  if (!code || !hostToken) return toast('请输入房间码与主持凭证', 'err');
  saveRoomCred(code, { hostToken });
  enterRoom(code, { hostToken });
});

async function loadRoomList() {
  const box = $('#room-list');
  try {
    const list = await api('/api/rooms');
    if (!list.length) { box.innerHTML = '<div class="muted">还没有房间。培训师可在上方开启共识演练。</div>'; return; }
    box.innerHTML = `
      <table class="ses-table">
        <thead><tr><th>房间码</th><th>情境</th><th>版本</th><th>模式</th><th>状态</th><th>当前步</th><th>成员</th><th>开启时间</th><th></th></tr></thead>
        <tbody>
          ${list.map((r) => {
            const cred = getRoomCred(r.code);
            const modeBadges = [
              r.step_duration
                ? `<span class="badge timed" title="限时模式：每步 ${r.step_duration} 秒">⏱️ ${r.step_duration}s/步</span>`
                : '<span class="muted">不限时</span>',
              r.blind_vote
                ? '<span class="badge blind" title="盲投：结算前仅公开已投人数，不显示各选项票数与逐人选项">🔒 盲投</span>'
                : '<span class="muted">公开投票</span>',
            ].join(' ');
            return `<tr>
              <td><code>${esc(r.code)}</code></td>
              <td>${esc(r.scenario_title)}</td>
              <td>v${r.version}</td>
              <td>${modeBadges}</td>
              <td class="${r.status === 'active' ? 'status-active' : 'status-ended'}">${r.status === 'active' ? '进行中' : '已结束'}</td>
              <td>${r.step_no}</td>
              <td>${r.member_count}</td>
              <td>${fmtTime(r.created_at)}</td>
              <td class="ses-actions">
                ${cred.hostToken ? `<button class="btn sm" data-room-host="${esc(r.code)}">🎤 主持台</button>` : ''}
                ${cred.memberToken ? `<button class="btn sm" data-room-member="${esc(r.code)}">🙋 我的投票</button>` : ''}
                <button class="btn sm ghost" data-room-watch="${esc(r.code)}">围观</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch (err) { box.innerHTML = `<div class="muted">房间列表加载失败：${esc(err.message)}</div>`; }
}

$('#room-list').addEventListener('click', (e) => {
  const host = e.target.closest('[data-room-host]');
  const member = e.target.closest('[data-room-member]');
  const watch = e.target.closest('[data-room-watch]');
  if (host) enterRoom(host.dataset.roomHost, { hostToken: getRoomCred(host.dataset.roomHost).hostToken });
  else if (member) enterRoom(member.dataset.roomMember, { memberToken: getRoomCred(member.dataset.roomMember).memberToken });
  else if (watch) enterRoom(watch.dataset.roomWatch, {});
});

// 进入房间视图并启动轮询（多人协作需要看到票数/步号变化）
function enterRoom(code, cred) {
  leaveRoomView();
  roomCtx = {
    code,
    memberToken: cred.memberToken || null,
    hostToken: cred.hostToken || null,
    data: null,
    timer: null,
    ticker: null,   // 限时房间每秒刷新倒计时显示
    clockSkew: 0,   // 本地时钟相对服务器的偏差（ms）：serverNow - localNow
  };
  $('#rooms-home').hidden = true;
  $('#room-view').hidden = false;
  refreshRoom();
  roomCtx.timer = setInterval(refreshRoom, 2500);
  roomCtx.ticker = setInterval(renderRoomCountdown, 1000);
}

function leaveRoomView() {
  if (roomCtx && roomCtx.timer) clearInterval(roomCtx.timer);
  if (roomCtx && roomCtx.ticker) clearInterval(roomCtx.ticker);
  roomCtx = null;
}

$('#btn-exit-room').addEventListener('click', () => {
  leaveRoomView();
  $('#room-view').hidden = true;
  $('#rooms-home').hidden = false;
  loadRoomHome();
});

function roomQuery() {
  const q = [];
  if (roomCtx.memberToken) q.push(`memberToken=${encodeURIComponent(roomCtx.memberToken)}`);
  if (roomCtx.hostToken) q.push(`hostToken=${encodeURIComponent(roomCtx.hostToken)}`);
  return q.length ? `?${q.join('&')}` : '';
}

async function refreshRoom() {
  if (!roomCtx) return;
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomCtx.code)}${roomQuery()}`);
    let data = null;
    try { data = await res.json(); } catch (_) { /* 非 JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `请求失败 (${res.status})`);
      err.status = res.status;
      throw err;
    }
    // 以服务器响应头 Date 校准本地时钟偏差，倒计时按服务器时间显示，避免本机时钟不准
    const dateHdr = res.headers.get('date');
    if (dateHdr) {
      const serverNow = Date.parse(dateHdr);
      if (Number.isFinite(serverNow)) roomCtx.clockSkew = serverNow - Date.now();
    }
    const prevStep = roomCtx.data ? roomCtx.data.stepNo : data.stepNo;
    const prevPhase = roomCtx.data ? (roomCtx.data.timer && roomCtx.data.timer.phase) : null;
    roomCtx.data = data;
    renderRoom();
    // 轮询发现系统已自动结算推进（到点有票）：横幅提示
    if (prevStep != null && data.stepNo > prevStep) {
      const auto = (data.settlements || []).find((s) => s.stepNo === prevStep && s.kind === 'auto');
      if (auto) {
        roomBanner(`⏱️ 第 ${prevStep} 步到点，系统已按投票自动结算：「${esc(auto.optionId)}」胜出并推进到第 ${data.stepNo} 步。`, 'info');
      }
    }
    // 轮询发现本步刚因零票暂停
    if (prevPhase === 'open' && data.timer && data.timer.phase === 'awaiting_reopen') {
      roomBanner(`⏱️ 第 ${data.stepNo} 步到点且无人投票，已暂停，等待主持人重开完整时长。`, 'error');
    }
  } catch (err) {
    if (err.status === 404 || err.status === 401) {
      leaveRoomView();
      $('#room-view').hidden = true;
      $('#rooms-home').hidden = false;
      loadRoomHome();
      toast(err.message, 'err');
    }
    // 其它瞬时错误（网络抖动等）静默，等待下一轮轮询
  }
}

function renderRoom() {
  const d = roomCtx.data;
  if (!d) return;
  $('#room-scenario-title').textContent = `${d.scenarioTitle || ''}`;
  $('#room-code').textContent = d.code;
  $('#room-version').textContent = 'v' + d.version;
  $('#room-step').textContent = d.stepNo;
  $('#room-score').textContent = d.totalScore;
  $('#room-score').className = scoreClass(d.totalScore);
  $('#room-members').textContent = d.memberCount;
  $('#room-votes').textContent = d.totalVotes;
  $('#room-role').innerHTML = d.isHost
    ? ' · <span class="badge v">🎤 主持人</span>'
    : (d.myVote !== null || roomCtx.memberToken ? ' · <span class="badge draft">🙋 学员</span>' : ' · <span class="muted">👀 围观（加入房间后可投票）</span>');

  const timer = d.timer || { timed: !!d.timed, phase: 'open' };
  const isPaused = timer.phase === 'awaiting_reopen';
  const isOpenTimed = timer.timed && timer.phase === 'open';
  const blind = !!d.blind && d.status === 'active'; // 当前步结算前的盲投阶段（已结束步结果全部公开）
  // 盲投阶段提示条：明确告诉所有人“此刻只看得到已投人数”
  const blindBar = $('#room-blind-bar');
  if (blind) {
    blindBar.classList.remove('hidden');
    blindBar.className = 'blind-bar' + (isPaused ? ' pause' : '');
    blindBar.innerHTML = `🔒 <b>盲投阶段</b>：第 <b>${d.stepNo}</b> 步结算前仅显示已投人数（<b>${d.totalVotes}</b> 票），不显示各选项票数或逐人选项（主持人同样不可见）`
      + (isPaused ? '；本步到点零票已暂停，等待主持人重开，暂停期间继续保密。' : '；主持提前结算或到点自动结算后公布各选项票数与获胜处置，始终不公开姓名与选项的对应关系。')
      + (roomCtx.memberToken ? ' 你可查看/修改自己的票。' : '');
  } else {
    blindBar.classList.add('hidden');
    blindBar.textContent = '';
  }
  // 剩余时间（按服务器时钟校准本地）；截止时间以服务器持久值为准
  const remainingMs = () => {
    if (!timer.deadlineMs) return null;
    return Math.max(0, timer.deadlineMs - (Date.now() + (roomCtx.clockSkew || 0)));
  };

  const node = d.currentNode;
  $('#room-node-kick').textContent = node && node.isEnd ? '结局' : '当前情境';
  $('#room-node-title').textContent = node ? node.title : '（节点缺失）';
  $('#room-node-narrative').textContent = node && node.narrative ? node.narrative : '';

  $('#room-state-list').innerHTML = d.states.map((st) => `
    <div class="state-row">
      <span>${esc(st.name)}</span>
      <span class="state-val ${st.value ? 'yes' : 'no'}">${st.value ? '● 是' : '○ 否'}</span>
    </div>`).join('');

  // 选项（带聚合票数；未结算时学员看不到他人选票，只有总数）
  const optBox = $('#room-option-list');
  if (d.status === 'ended') {
    optBox.innerHTML = '<div class="muted">本场共识演练已结束。</div>';
    roomBanner(`演练结束：已到达结局「${node ? node.title : ''}」，共 ${d.stepNo} 步，总分 <b>${d.totalScore}</b> 分。`, 'ok');
  } else {
    const myOpt = d.myVote && d.myVote.optionId;
    const canVote = !!roomCtx.memberToken && !isPaused;
    const deadlineBlocked = isOpenTimed && remainingMs() <= 0;
    const voteHint = isPaused
      ? '<div class="timer-notice pause">⏱️ 本步限时结束且无人投票，已暂停投票，等待主持人重开。</div>'
      : (deadlineBlocked
        ? '<div class="timer-notice end">⏱️ 本步已到截止时间，正在自动结算，请稍候刷新…</div>'
        : '');
    const blindHint = blind
      ? `<div class="blind-notice">🔒 盲投中：各选项票数与他人选择在结算前不显示；当前已投 <b>${d.totalVotes}</b> 票。结算后在此公布各选项票数与获胜处置。</div>`
      : '';
    // 盲投阶段各选项不渲染票数（服务端 votes=null）；公开房照旧显示“N 票”
    const tallyBadge = (o) => blind
      ? '<span class="vote-badge blind" title="盲投：结算前不显示该选项票数">🔒</span>'
      : `<span class="vote-badge" title="本选项当前票数">${o.votes} 票</span>`;
    const avail = d.options.map((o) => `
      <button class="option-btn room-opt ${myOpt === o.id ? 'my-vote' : ''}" data-vote="${esc(o.id)}" ${canVote ? '' : 'disabled'}>
        ${esc(o.label)}
        ${tallyBadge(o)}
        ${myOpt === o.id ? '<span class="my-vote-tag">✓ 我的投票</span>' : ''}
        ${o.conditions.length ? `<span class="conds">条件：${o.conditions.map((c) => condText(d, c)).join('；')}</span>` : ''}
      </button>`).join('');
    const unavail = (d.unavailableOptions || []).map((o) => `
      <button class="option-btn disabled-opt" disabled>
        🔒 ${esc(o.label)}
        ${blind ? '<span class="vote-badge blind">🔒</span>' : `<span class="vote-badge">${o.votes} 票</span>`}
        <span class="lock">${esc(o.reason)}：${o.failingConditions.map((f) => `${esc(f.stateName)} 需为「${f.required ? '是' : '否'}」`).join('；')}</span>
      </button>`).join('');
    optBox.innerHTML = (avail || '<div class="muted">当前没有可投选项。</div>') + unavail
      + blindHint
      + voteHint
      + (roomCtx.memberToken ? '' : '<div class="hint" style="margin-top:6px">你正以围观身份查看；用加入码加入房间后才能投票。</div>');
  }

  // 主持台：公开房=逐人投票明细；盲投阶段=仅成员名单与已投人数（不显示逐人选项与各选项票数）
  const hostPanel = $('#room-host-panel');
  if (d.isHost && d.status === 'active') {
    hostPanel.hidden = false;
    if (blind) {
      const members = d.members || [];
      $('#room-vote-detail').innerHTML = `
        <div class="blind-host-note">🔒 盲投阶段：本步结算前你也只能看到已投 <b>${d.totalVotes}</b> 票，不显示各选项票数或逐人选项；结算后公布各选项票数与获胜处置，且始终不公开姓名与选项的对应关系。</div>
        <div class="muted" style="margin:6px 0">成员 ${d.memberCount} 人，本步已投 ${d.totalVotes} 票。成员名单：</div>
        <ul class="vote-detail">${members.map((m) => `<li>${esc(m.name)}</li>`).join('') || '<li class="muted">（暂无成员）</li>'}</ul>`;
    } else {
      const votes = d.votes || [];
      $('#room-vote-detail').innerHTML = `
        <div class="muted" style="margin-bottom:6px">成员 ${d.memberCount} 人，本步已投 ${d.totalVotes} 票${votes.length ? '：' : '。'}</div>
        ${votes.length ? `<ul class="vote-detail">${votes.map((v) => {
          const opt = d.options.find((o) => o.id === v.optionId);
          return `<li>${esc(v.name)} → 「${esc(opt ? opt.label : v.optionId)}」</li>`;
        }).join('')}</ul>` : ''}`;
    }
    const settleBtn = $('#btn-settle');
    const reopenBtn = $('#btn-reopen');
    settleBtn.disabled = d.totalVotes === 0 || isPaused;
    settleBtn.textContent = isOpenTimed ? '立即结算本步（截止前提前结算）' : '立即结算本步（按票数推进）';
    reopenBtn.hidden = !(timer.timed && isPaused);
    if (!reopenBtn.hidden) {
      reopenBtn.disabled = false;
      reopenBtn.textContent = `⏱️ 重开第 ${d.stepNo} 步（再给 ${timer.stepDurationSeconds} 秒）`;
    }
  } else {
    hostPanel.hidden = true;
  }

  // 已结算路径（每步得分 + 当步票数；自动结算加标记）
  const settleByStep = new Map((d.settlements || []).map((s) => [s.stepNo + 1, s]));
  $('#room-path-list').innerHTML = d.path.map((p) => {
    const st = settleByStep.get(p.step);
    const tallyText = st
      ? `<span class="pl-sub">当场票数：${st.tallies.map((t) => `「${esc(t.optionLabel)}」${t.votes}票`).join('，')}（共 ${st.voterCount} 人投票）${st.kind === 'auto' ? ' · <b class="auto-tag">⏱️ 到点自动结算</b>' : ''}</span>`
      : '';
    return renderPathItem(p, d) + tallyText;
  }).join('') || '<li class="muted">尚未结算任何一步。</li>';

  renderRoomCountdown();
}

// 每秒刷新限时条（不重新请求，按持久化的 deadlineMs 本地倒数；轮询每 2.5s 校正）
function renderRoomCountdown() {
  if (!roomCtx || !roomCtx.data) return;
  const d = roomCtx.data;
  const bar = $('#room-timer-bar');
  const timer = d.timer;
  if (!timer || !timer.timed || d.status === 'ended') {
    bar.className = 'timer-bar hidden';
    bar.textContent = '';
    return;
  }
  bar.classList.remove('hidden');
  if (timer.phase === 'awaiting_reopen') {
    bar.className = 'timer-bar pause';
    bar.innerHTML = `⏱️ 限时模式（每步 ${timer.stepDurationSeconds} 秒）：第 <b>${d.stepNo}</b> 步到点零票，<b>已暂停待重开</b>`
      + (d.isHost ? ' · 请在主持台点“重开本步”' : ' · 等待主持人重开')
      + (timer.reopenedCount ? `（本步已重开 ${timer.reopenedCount} 次）` : '');
    return;
  }
  const remainMs = timer.deadlineMs
    ? Math.max(0, timer.deadlineMs - (Date.now() + (roomCtx.clockSkew || 0)))
    : null;
  const fmt = (ms) => {
    const s = Math.ceil(ms / 1000);
    const mm = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  };
  const deadlineText = timer.deadlineAt
    ? new Date(timer.deadlineMs).toLocaleString('zh-CN', { hour12: false })
    : '—';
  const urgent = remainMs !== null && remainMs <= 10000;
  bar.className = 'timer-bar' + (urgent ? ' urgent' : '');
  bar.innerHTML = `⏱️ 限时模式（每步 <b>${timer.stepDurationSeconds}</b> 秒） · 第 <b>${d.stepNo}</b> 步`
    + ` · 截止 <b>${esc(deadlineText)}</b>`
    + (remainMs === null ? '' : ` · 剩余 <b class="timer-remain">${fmt(remainMs)}</b>`)
    + ` · 到点有票自动结算，零票暂停待重开`
    + (timer.reopenedCount ? ` · 本步已重开 ${timer.reopenedCount} 次` : '');
}

function roomBanner(msg, kind) {
  const b = $('#room-banner');
  b.innerHTML = msg;
  b.className = 'banner ' + kind;
}

// 学员投票 / 改票（携带当前所见步号；过期则服务器拒绝并返回当前步号）
$('#room-option-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-vote]');
  if (!btn || !roomCtx || !roomCtx.memberToken || !roomCtx.data) return;
  if (roomCtx.data.status !== 'active') return;
  const timer = roomCtx.data.timer;
  if (timer && timer.phase === 'awaiting_reopen') {
    return roomBanner('本步已到点且零票暂停，需主持人重开后才能投票。', 'error');
  }
  try {
    const r = await api(`/api/rooms/${encodeURIComponent(roomCtx.code)}/vote`, {
      method: 'POST',
      body: { memberToken: roomCtx.memberToken, optionId: btn.dataset.vote, stepNo: roomCtx.data.stepNo },
    });
    roomCtx.data = r.current;
    renderRoom();
    roomBanner('已计票（结算前可改票，只计最后一票）。', 'ok');
  } catch (err) {
    if (err.data && err.data.current) { roomCtx.data = err.data.current; renderRoom(); }
    roomBanner(`投票被拒绝：${esc(err.message)}`, 'error');
  }
});

// 主持人结算（携带所见步号；步号过期/无人投票会被拒绝并刷新现状）
$('#btn-settle').addEventListener('click', async () => {
  if (!roomCtx || !roomCtx.hostToken || !roomCtx.data) return;
  try {
    const r = await api(`/api/rooms/${encodeURIComponent(roomCtx.code)}/settle`, {
      method: 'POST',
      body: { hostToken: roomCtx.hostToken, observedStepNo: roomCtx.data.stepNo },
    });
    roomCtx.data = r.current;
    renderRoom();
    const s = r.settled;
    const sign = s.score > 0 ? '+' : '';
    const winnerLabel = (r.current.options || []).length ? s.optionLabel : s.optionLabel;
    roomBanner(
      `${r.autoSettled ? '⏱️ 该步已到点，系统自动结算' : '第 ' + s.stepNo + ' 步已结算'}：「${esc(winnerLabel)}」胜出（${s.tallies.map((t) => `「${esc(t.optionLabel)}」${t.votes}票`).join('，')}），`
      + `本步得分 ${sign}${s.score}，累计 ${s.totalScore} 分。`,
      'ok');
  } catch (err) {
    if (err.data && err.data.current) { roomCtx.data = err.data.current; renderRoom(); }
    roomBanner(`结算被拒绝：${esc(err.message)}`, 'error');
  }
});

// 主持人重开（限时房间到点零票暂停后；携带所见步号，给本步完整时长）
$('#btn-reopen').addEventListener('click', async () => {
  if (!roomCtx || !roomCtx.hostToken || !roomCtx.data) return;
  const stepNo = roomCtx.data.stepNo;
  try {
    const r = await api(`/api/rooms/${encodeURIComponent(roomCtx.code)}/reopen`, {
      method: 'POST',
      body: { hostToken: roomCtx.hostToken, observedStepNo: stepNo },
    });
    roomCtx.data = r.current;
    renderRoom();
    roomBanner(`⏱️ 已重开第 ${stepNo} 步：从现在起再给 ${r.reopened.stepDurationSeconds} 秒（截止 ${new Date(r.reopened.deadlineMs).toLocaleString('zh-CN', { hour12: false })}），请通知学员尽快投票。`, 'ok');
    toast('本步已重开，倒计时重新开始', 'ok');
  } catch (err) {
    if (err.data && err.data.current) { roomCtx.data = err.data.current; renderRoom(); }
    roomBanner(`重开被拒绝：${esc(err.message)}`, 'error');
  }
});

// ====================== 训练任务 ======================

// 任务凭证按任务编号存 localStorage：{ [taskId]: { adminToken?, token? } }
function taskCreds() {
  try { return JSON.parse(localStorage.getItem('taskCreds') || '{}'); } catch (_) { return {}; }
}
function saveTaskCred(taskId, patch) {
  const all = taskCreds();
  all[taskId] = { ...(all[taskId] || {}), ...patch };
  localStorage.setItem('taskCreds', JSON.stringify(all));
}
function getTaskCred(taskId) {
  return taskCreds()[taskId] || {};
}

function toLocalInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function loadTaskHome() {
  leaveManageView();
  $('#tasks-home').hidden = false;
  $('#task-manage').hidden = true;
  // 已发布情境供建立任务选择
  try {
    const list = await api('/api/published');
    const sel = $('#task-scenario');
    sel.innerHTML = list.length
      ? list.map((s) => `<option value="${esc(s.id)}">${esc(s.title)}（当前 v${s.current_version}）</option>`).join('')
      : '<option value="">（暂无已发布情境）</option>';
    await loadTaskVersions();
  } catch (err) { toast(err.message, 'err'); }
  // 默认截止时间：当前 +2 小时
  if (!$('#task-deadline').value) {
    $('#task-deadline').value = toLocalInputValue(Date.now() + 2 * 3600 * 1000);
  }
  await loadTaskList();
}

async function loadTaskVersions() {
  const id = $('#task-scenario').value;
  const sel = $('#task-version');
  if (!id) { sel.innerHTML = ''; return; }
  try {
    const detail = await api(`/api/scenarios/${encodeURIComponent(id)}`);
    const versions = (detail.versions || []).slice().sort((a, b) => b.version - a.version);
    sel.innerHTML = versions.map((v) =>
      `<option value="${v.version}">v${v.version}（冻结于 ${fmtTime(v.created_at)}）</option>`).join('');
  } catch (err) { sel.innerHTML = ''; }
}

$('#task-scenario').addEventListener('change', loadTaskVersions);
$('#btn-reload-tasks').addEventListener('click', loadTaskHome);

// ---------- 建立任务（培训师） ----------

$('#btn-create-task').addEventListener('click', async () => {
  const scenarioId = $('#task-scenario').value;
  const version = parseInt($('#task-version').value, 10);
  if (!scenarioId) return toast('请先选择已发布情境', 'err');
  if (!Number.isInteger(version)) return toast('请选择冻结版本', 'err');
  const deadlineVal = $('#task-deadline').value;
  const deadlineMs = deadlineVal ? new Date(deadlineVal).getTime() : NaN;
  if (!Number.isFinite(deadlineMs)) return toast('请填写截止时间', 'err');
  if (deadlineMs <= Date.now()) return toast('截止时间必须晚于当前时间', 'err');
  const maxAttempts = Number($('#task-max-attempts').value);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) return toast('每人最多尝试次数必须为正整数', 'err');
  const passScore = Number($('#task-pass-score').value);
  if (!Number.isInteger(passScore)) return toast('及格分必须为整数', 'err');
  const trainees = $('#task-trainees').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!trainees.length) return toast('学员名单不能为空（每行一个姓名）', 'err');
  if (new Set(trainees).size !== trainees.length) return toast('学员名单中有重复姓名', 'err');
  try {
    const r = await api('/api/tasks', {
      method: 'POST',
      body: { scenarioId, version, deadline: deadlineMs, maxAttempts, passScore, trainees },
    });
    saveTaskCred(r.taskId, { adminToken: r.adminToken });
    $('#task-created').classList.remove('hidden');
    $('#task-id-out').textContent = r.taskId;
    $('#task-admin-out').textContent = r.adminToken;
    $('#task-tokens-out').innerHTML = `
      <div class="hint">各学员独立参与凭证（点击可复制，请分别发给本人）：</div>
      ${r.trainees.map((t) => `
        <div class="token-row">
          <span class="token-name">${esc(t.name)}</span>
          <code class="big-code" title="点击复制" data-copy="${esc(t.token)}">${esc(t.token)}</code>
        </div>`).join('')}`;
    toast(`任务已建立（绑定 v${r.version}，${r.trainees.length} 名学员），请分发任务编号与各学员凭证`, 'ok');
    loadTaskList();
  } catch (err) { toast(err.message, 'err'); }
});

// 点击复制凭证
$('#task-created').addEventListener('click', (e) => {
  const el = e.target.closest('[data-copy]');
  if (!el) return;
  const text = el.dataset.copy;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('已复制参与凭证', 'ok')).catch(() => {});
  }
});

$('#btn-enter-manage').addEventListener('click', () => {
  const taskId = $('#task-id-out').textContent.trim();
  const cred = getTaskCred(taskId);
  if (taskId && cred.adminToken) enterManage(taskId, cred.adminToken);
});

$('#btn-open-manage').addEventListener('click', () => {
  const taskId = $('#manage-task-id').value.trim();
  const adminToken = $('#manage-admin-token').value.trim();
  if (!taskId || !adminToken) return toast('请输入任务编号与管理凭证', 'err');
  saveTaskCred(taskId, { adminToken });
  enterManage(taskId, adminToken);
});

// ---------- 参与任务（学员） ----------

$('#btn-join-task').addEventListener('click', async () => {
  const taskId = $('#join-task-id').value.trim();
  const token = $('#join-task-token').value.trim();
  if (!taskId || !token) return toast('请输入任务编号与个人参与凭证', 'err');
  try {
    const r = await api(`/api/tasks/${encodeURIComponent(taskId)}/start`, {
      method: 'POST',
      body: { token },
    });
    saveTaskCred(taskId, { token });
    enterTaskSession({ ...r, __token: token });
    toast(r.resumed ? '已回到你未完成的尝试' : `已开始第 ${r.attemptNo} 次尝试`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
    // 次数耗尽 / 已截止 / 凭证问题：展示本人当前尝试汇总，便于确认状态
    refreshMyTaskSummary(taskId, token);
  }
});

// 学员视角汇总：我的尝试记录（凭本人凭证）
async function refreshMyTaskSummary(taskId, token) {
  const box = $('#task-my-summary');
  if (!taskId || !token) { box.style.display = 'none'; return; }
  try {
    const r = await api(`/api/tasks/${encodeURIComponent(taskId)}/my?token=${encodeURIComponent(token)}`);
    const rows = r.attempts.map((a) => `
      <tr>
        <td>第 ${a.attemptNo} 次</td>
        <td class="${a.status === 'active' ? 'status-active' : 'status-ended'}">${a.status === 'active' ? '进行中' : '已结束'}</td>
        <td>${a.stepNo}</td>
        <td><b class="${scoreClass(a.totalScore)}">${a.totalScore}</b></td>
        <td>${fmtTime(a.startedAt)}</td>
      </tr>`).join('');
    box.innerHTML = `
      <div class="hint" style="margin-bottom:6px">
        ${esc(r.traineeName || '')} · ${esc(r.task.scenarioTitle || '')} v${r.task.version}
        · 已用 ${r.attemptsUsed}/${r.maxAttempts} 次 · 及格分 ${r.task.passScore}
        · ${r.task.expired ? '<b style="color:var(--err)">已截止（不能开新尝试，可续做未结束的会话）</b>' : `截止 ${new Date(r.task.deadlineMs).toLocaleString('zh-CN', { hour12: false })}`}
      </div>
      ${r.attempts.length ? `
        <table class="ses-table">
          <thead><tr><th>尝试</th><th>状态</th><th>步数</th><th>得分</th><th>开始时间</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>` : '<div class="muted">还没有任何尝试。</div>'}`;
    box.style.display = '';
  } catch (_) {
    box.style.display = 'none';
  }
}

// ---------- 任务列表 ----------

async function loadTaskList() {
  const box = $('#task-list');
  try {
    const list = await api('/api/tasks');
    if (!list.length) { box.innerHTML = '<div class="muted">还没有训练任务。培训师可在上方建立。</div>'; return; }
    box.innerHTML = `
      <table class="ses-table">
        <thead><tr><th>任务编号</th><th>情境</th><th>版本</th><th>截止时间</th><th>状态</th><th>次数/人</th><th>及格分</th><th>学员</th><th>尝试</th><th></th></tr></thead>
        <tbody>
          ${list.map((t) => {
            const cred = getTaskCred(t.id);
            return `<tr>
              <td><code>${esc(t.id)}</code></td>
              <td>${esc(t.scenario_title)}</td>
              <td>v${t.version}</td>
              <td>${new Date(t.deadline_ms).toLocaleString('zh-CN', { hour12: false })}</td>
              <td class="${t.expired ? 'status-ended' : 'status-active'}">${t.expired ? '已截止' : '报名中'}</td>
              <td>${t.max_attempts}</td>
              <td>${t.pass_score}</td>
              <td>${t.trainee_count}</td>
              <td>${t.attempt_count}</td>
              <td class="ses-actions">
                ${cred.adminToken ? `<button class="btn sm" data-task-manage="${esc(t.id)}">📋 管理</button>` : ''}
                ${cred.token ? `<button class="btn sm" data-task-join="${esc(t.id)}">🙋 参与</button>` : ''}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch (err) { box.innerHTML = `<div class="muted">任务列表加载失败：${esc(err.message)}</div>`; }
}

$('#task-list').addEventListener('click', (e) => {
  const manage = e.target.closest('[data-task-manage]');
  const join = e.target.closest('[data-task-join]');
  if (manage) {
    const id = manage.dataset.taskManage;
    enterManage(id, getTaskCred(id).adminToken);
  } else if (join) {
    const id = join.dataset.taskJoin;
    $('#join-task-id').value = id;
    $('#join-task-token').value = getTaskCred(id).token || '';
    $('#btn-join-task').click();
  }
});

// ---------- 管理视图（培训师凭管理凭证） ----------

let manageCtx = null; // { taskId, adminToken, timer }

function enterManage(taskId, adminToken) {
  leaveManageView();
  manageCtx = { taskId, adminToken, timer: null };
  $('#tasks-home').hidden = true;
  $('#task-manage').hidden = false;
  refreshManage();
  manageCtx.timer = setInterval(refreshManage, 4000); // 成绩随学员推进自动刷新
}

function leaveManageView() {
  if (manageCtx && manageCtx.timer) clearInterval(manageCtx.timer);
  manageCtx = null;
}

$('#btn-exit-manage').addEventListener('click', () => {
  leaveManageView();
  $('#task-manage').hidden = true;
  $('#tasks-home').hidden = false;
  loadTaskHome();
});
$('#btn-tm-reload').addEventListener('click', () => refreshManage());

async function refreshManage() {
  if (!manageCtx) return;
  try {
    const r = await api(`/api/tasks/${encodeURIComponent(manageCtx.taskId)}/manage?token=${encodeURIComponent(manageCtx.adminToken)}`);
    renderManage(r);
  } catch (err) {
    if (err.status === 401 || err.status === 404) {
      leaveManageView();
      $('#task-manage').hidden = true;
      $('#tasks-home').hidden = false;
      toast(err.message, 'err');
    }
    // 其它瞬时错误（网络抖动等）静默，等待下一轮轮询
  }
}

function renderManage(r) {
  const t = r.task;
  $('#tm-scenario-title').textContent = `${t.scenarioTitle || ''} · v${t.version}`;
  $('#tm-meta').innerHTML = [
    `任务 <code>${esc(t.id)}</code>`,
    `截止 <b>${new Date(t.deadlineMs).toLocaleString('zh-CN', { hour12: false })}</b>${t.expired ? '（<span class="status-ended">已截止，不能开新尝试</span>）' : '（<span class="status-active">报名中</span>）'}`,
    `每人最多 <b>${t.maxAttempts}</b> 次`,
    `及格分 <b>${t.passScore}</b>`,
  ].join(' · ');

  const s = r.summary;
  $('#tm-summary').innerHTML = `
    <div class="coverage-stat-grid">
      <div class="cov-stat"><div class="cov-num">${s.traineeCount}</div><div class="muted">学员人数</div></div>
      <div class="cov-stat"><div class="cov-num">${s.startedCount}</div><div class="muted">已开始</div></div>
      <div class="cov-stat covered"><div class="cov-num">${s.passedCount}</div><div class="muted">已及格</div></div>
      <div class="cov-stat"><div class="cov-num">${s.attemptsTotal}</div><div class="muted">尝试总次数</div></div>
    </div>`;

  $('#tm-trainees').innerHTML = `
    <table class="cov-table">
      <thead><tr><th>学员</th><th>参与凭证</th><th>已用次数</th><th>当前状态</th><th>最高已结束总分</th><th>是否及格</th><th>尝试明细</th></tr></thead>
      <tbody>
        ${r.trainees.map((tr) => {
          const best = tr.bestScore === null
            ? '<span class="muted">—（无已结束尝试）</span>'
            : `<b class="${scoreClass(tr.bestScore)}">${tr.bestScore}</b>`;
          const pass = tr.passed === null
            ? '<span class="muted">—</span>'
            : (tr.passed ? '<span class="cov-tag yes">已及格</span>' : '<span class="cov-tag no">未及格</span>');
          const cur = tr.activeAttemptNo !== null
            ? `<span class="status-active">第 ${tr.activeAttemptNo} 次进行中</span>`
            : (tr.attemptsLeft > 0 ? `<span class="muted">可再试 ${tr.attemptsLeft} 次</span>` : '<span class="status-ended">次数已用完</span>');
          const detail = tr.attempts.length
            ? `<details><summary>${tr.attemptsUsed} 次记录</summary>
                <ol class="path-list" style="margin-top:6px">
                  ${tr.attempts.map((a) => `
                    <li>第 ${a.attemptNo} 次 · ${a.status === 'active' ? '<span class="status-active">进行中</span>' : '已结束'}
                      · ${a.stepNo} 步 · 得分 <b class="${scoreClass(a.totalScore)}">${a.totalScore}</b>
                      <span class="pl-sub">开始 ${fmtTime(a.startedAt)} · 最近推进 ${fmtTime(a.updatedAt)} · 会话 <code>${esc(a.sessionCode)}</code></span>
                    </li>`).join('')}
                </ol>
              </details>`
            : '<span class="muted">尚无尝试</span>';
          return `<tr>
            <td><b>${esc(tr.name)}</b></td>
            <td><code style="user-select:all">${esc(tr.token)}</code></td>
            <td>${tr.attemptsUsed}/${t.maxAttempts}</td>
            <td>${cur}</td>
            <td>${best}</td>
            <td>${pass}</td>
            <td>${detail}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

// ====================== 初始化 ======================

loadPublished().catch((e) => toast(e.message, 'err'));
loadSessionList().catch(() => {});
