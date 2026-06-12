// [需求@2026-06-12 §8.6.5] 仪表盘独立页面 JS
//   - 4 tab(终端实时 / 任务队列 / H 派工时序 / 对话控制)
//   - 10s 自动刷新当前 tab(可关)
//   - 支持 #tab=xxx hash 深链接
//   - 跨 project 视图(独立于主视图的 activeProject)

const STAGE_ORDER = ['discussing', 'designing', 'executing', 'testing', 'verified', 'closed'];
const AUTO_REFRESH_MS = 10000;

const el = (sel) => document.querySelector(sel);

let currentTab = 'terminals';
let refreshTimer = null;

function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function relTime(ts) {
  if (!ts) return '';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function fmtTs(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function updateLastRefresh() {
  el('#db-last-refresh').textContent = `最后刷新: ${fmtTs(Date.now())}`;
}

// ============================== Tab 1: terminals ==============================

async function refreshTerminalsList(preserveScroll = true) {
  const listEl = el('#terminals-list');
  const includeDead = el('#term-include-dead').checked;
  const scrollY = listEl.scrollTop;
  try {
    const params = ['details=1'];
    if (includeDead) params.push('includeDead=1');
    const r = await fetch(`/api/instances/all?${params.join('&')}`);
    if (!r.ok) throw new Error('fetch failed: ' + r.status);
    const instances = await r.json();
    renderTerminalsList(instances);
    if (preserveScroll) listEl.scrollTop = scrollY;
  } catch (e) {
    listEl.innerHTML = `<div class="term-empty">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

function renderTerminalsList(instances) {
  const listEl = el('#terminals-list');
  if (!instances.length) {
    listEl.innerHTML = `<div class="term-empty">当前没有 claude 终端实例</div>`;
    return;
  }
  const head = `
    <div class="term-row head">
      <div></div>
      <div>名字</div>
      <div>Slot</div>
      <div>Project</div>
      <div>PID</div>
      <div>当前活动</div>
      <div>Memory</div>
      <div></div>
    </div>
  `;
  const rows = instances.map((i) => {
    const canKill = !['dead', 'disconnected'].includes(i.status);
    const slotText = i.poolSlot != null ? String(i.poolSlot) : '-';
    const activity = i.latestActivity || '(no data)';
    const memoryText = i.memory && i.memory.fileCount > 0
      ? `${i.memory.fileCount} files${i.memory.latestMtime ? ' · ' + relTime(i.memory.latestMtime) : ''}`
      : '—';
    return `
      <div class="term-row">
        <div><span class="term-status ${i.status}">${i.status[0]}</span></div>
        <div title="${escapeHtml(i.id)} · session ${i.sessionId || '-'}">${escapeHtml(i.displayName || i.id)}</div>
        <div>${slotText}</div>
        <div>${escapeHtml(i.projectName || '?')}</div>
        <div>${i.pid ?? '-'}</div>
        <div title="${escapeHtml(activity)}">${escapeHtml(activity)}</div>
        <div title="${i.memory ? 'latest: ' + (i.memory.latestMtime ? new Date(i.memory.latestMtime).toLocaleString() : '-') : ''}">${escapeHtml(memoryText)}</div>
        <div>${canKill
          ? `<button class="term-kill" data-id="${escapeHtml(i.id)}">kill</button>`
          : `<button class="term-kill" disabled>-</button>`}
        </div>
      </div>
    `;
  }).join('');
  listEl.innerHTML = head + rows;

  listEl.querySelectorAll('.term-kill[data-id]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = btn.dataset.id;
      if (!confirm(`Kill ${id}?`)) return;
      try {
        const r = await fetch(`/api/instances/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!r.ok) throw new Error('kill failed');
        await refreshTerminalsList();
      } catch (err) {
        alert('kill failed: ' + err.message);
      }
    });
  });
}

// ============================== Tab 2: queue ==============================

function formatBindings(cri) {
  if (!cri) return '';
  const out = [];
  if (cri.requirements) out.push('R');
  if (cri.orchestrator) out.push('H');
  if (cri.executor) out.push('B');
  if (cri.validator) out.push('C');
  if (cri.advisor) out.push('mateBot');
  return out.join(', ');
}

async function refreshQueueList(preserveScroll = true) {
  const listEl = el('#queue-list');
  const includeClosedEl = el('#queue-include-closed');
  const scrollY = listEl.scrollTop;
  try {
    const includeClosed = includeClosedEl?.checked ? '1' : '0';
    const r = await fetch(`/api/threads/all?includeClosed=${includeClosed}`);
    if (!r.ok) throw new Error('fetch failed: ' + r.status);
    const threads = await r.json();
    renderQueueList(threads);
    if (preserveScroll) listEl.scrollTop = scrollY;
  } catch (e) {
    listEl.innerHTML = `<div class="queue-empty">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

function renderQueueList(threads) {
  const listEl = el('#queue-list');
  if (!threads.length) {
    listEl.innerHTML = `<div class="queue-empty">当前没有活跃线索</div>`;
    return;
  }
  const groups = new Map(STAGE_ORDER.map((s) => [s, []]));
  for (const t of threads) {
    if (!groups.has(t.stage)) groups.set(t.stage, []);
    groups.get(t.stage).push(t);
  }
  const html = [];
  for (const stage of STAGE_ORDER) {
    const list = groups.get(stage) || [];
    if (list.length === 0) continue;
    html.push(`<div class="queue-group">`);
    html.push(`<h4><span class="stage ${stage}">${stage}</span> <span class="count">(${list.length})</span></h4>`);
    for (const t of list) {
      const bindings = formatBindings(t.metadata?.current_role_instances);
      const canArchive = stage !== 'closed';
      html.push(`
        <div class="queue-row">
          <div class="slug" title="${escapeHtml(t.slug)}">${escapeHtml(t.title || t.slug)}</div>
          <div class="project">${escapeHtml(t.projectName || '?')}</div>
          <div class="title" title="${escapeHtml(t.slug)}">${escapeHtml(t.slug)}</div>
          <div class="bindings" title="${escapeHtml(bindings)}">${escapeHtml(bindings || '(no bindings)')}</div>
          <div>${canArchive
            ? `<button class="archive-btn" data-slug="${escapeHtml(t.slug)}" data-pid="${t.projectId}">archive</button>`
            : ''}</div>
        </div>
      `);
    }
    html.push(`</div>`);
  }
  listEl.innerHTML = html.join('');

  listEl.querySelectorAll('.archive-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const slug = btn.dataset.slug;
      const projectId = btn.dataset.pid;
      if (!confirm(`Archive thread "${slug}"?`)) return;
      try {
        const r = await fetch(`/api/threads/${encodeURIComponent(slug)}?projectId=${projectId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage: 'closed' }),
        });
        if (!r.ok) throw new Error('archive failed');
        await refreshQueueList();
      } catch (err) {
        alert('archive failed: ' + err.message);
      }
    });
  });
}

// ============================== Tab 3: dispatch history ==============================

async function refreshDispatchHistory(preserveScroll = true) {
  const listEl = el('#dispatch-list');
  const scrollY = listEl.scrollTop;
  try {
    const r = await fetch(`/api/dispatches/history?limit=200`);
    if (!r.ok) throw new Error('fetch failed: ' + r.status);
    const events = await r.json();
    const view = (document.querySelector('input[name="dispatch-view"]:checked') || {}).value || 'thread';
    if (view === 'global') renderDispatchGlobal(events);
    else renderDispatchByThread(events);
    if (preserveScroll) listEl.scrollTop = scrollY;
  } catch (e) {
    listEl.innerHTML = `<div class="dispatch-empty">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

function renderDispatchEvent(e) {
  let arrow = '';
  if (e.kind === 'thread.handoff') {
    const from = e.payload.from || '?';
    const target = e.payload.target || e.payload.resolvedRole || '?';
    arrow = `<span class="arrow">${escapeHtml(from)} → ${escapeHtml(target)}</span>`;
  } else if (e.kind === 'thread.done') {
    arrow = `<span class="arrow">✓ done</span>`;
  } else if (e.kind === 'thread.blocked') {
    arrow = `<span class="arrow">⚠ blocked</span>`;
  }
  const reason = e.payload.reason || e.payload.summary || e.payload.question || '';
  const kindShort = e.kind === 'thread.handoff' ? 'h-o' : e.kind === 'thread.done' ? 'done' : 'blkd';
  const kindCls = e.kind === 'thread.handoff' ? 'handoff' : e.kind === 'thread.done' ? 'done' : 'blocked';
  return `
    <div class="dispatch-event ${kindCls}">
      <div class="ts">${fmtTs(e.ts)}</div>
      <div class="kind-tag">${kindShort}</div>
      ${arrow}
      <div class="reason" title="${escapeHtml(reason)}">${escapeHtml(reason.slice(0, 80))}</div>
    </div>
  `;
}

function renderDispatchByThread(events) {
  const listEl = el('#dispatch-list');
  if (!events.length) {
    listEl.innerHTML = `<div class="dispatch-empty">还没有派工记录</div>`;
    return;
  }
  const groups = new Map();
  for (const e of events) {
    const key = `${e.projectId}::${e.threadSlug}`;
    if (!groups.has(key)) groups.set(key, { projectName: e.projectName, slug: e.threadSlug, events: [] });
    groups.get(key).events.push(e);
  }
  const groupList = [...groups.values()];
  for (const g of groupList) g.events.sort((a, b) => a.ts - b.ts);
  groupList.sort((a, b) => b.events[b.events.length - 1].ts - a.events[a.events.length - 1].ts);

  const html = [];
  for (const g of groupList) {
    html.push(`<div class="dispatch-thread">`);
    html.push(`<h5><span class="slug">${escapeHtml(g.slug)}</span> <span class="proj">${escapeHtml(g.projectName)}</span></h5>`);
    for (const e of g.events) html.push(renderDispatchEvent(e));
    html.push(`</div>`);
  }
  listEl.innerHTML = html.join('');
}

function renderDispatchGlobal(events) {
  const listEl = el('#dispatch-list');
  if (!events.length) {
    listEl.innerHTML = `<div class="dispatch-empty">还没有派工记录</div>`;
    return;
  }
  const html = ['<div class="dispatch-thread">'];
  for (const e of events) {
    const kindCls = e.kind === 'thread.handoff' ? 'handoff' : e.kind === 'thread.done' ? 'done' : 'blocked';
    const kindShort = e.kind === 'thread.handoff' ? 'h-o' : e.kind === 'thread.done' ? 'done' : 'blkd';
    html.push(`<div class="dispatch-event ${kindCls}">`);
    html.push(`<div class="ts">${fmtTs(e.ts)}</div>`);
    html.push(`<div class="kind-tag">${kindShort}</div>`);
    const slugPart = `<span class="slug" style="color:var(--text-secondary)">${escapeHtml(e.threadSlug)}</span>`;
    if (e.kind === 'thread.handoff') {
      const from = e.payload.from || '?';
      const target = e.payload.target || e.payload.resolvedRole || '?';
      html.push(`<div class="arrow">${slugPart}: ${escapeHtml(from)} → ${escapeHtml(target)}</div>`);
    } else {
      html.push(`<div class="arrow">${slugPart}: ${e.kind.replace('thread.', '')}</div>`);
    }
    const reason = e.payload.reason || e.payload.summary || e.payload.question || '';
    html.push(`<div class="reason" title="${escapeHtml(reason)}">${escapeHtml(reason.slice(0, 80))}</div>`);
    html.push(`</div>`);
  }
  html.push(`</div>`);
  listEl.innerHTML = html.join('');
}

// ============================== Tab 4: mateTerm (direct chat to a terminal) ==============================
// [需求@2026-06-12 §9] 选 instance + 模式(直连/干预),发消息,流式回显。
// - 直连:POST /api/instances/:id/direct-message; 历史按 direct_target 拉
// - 干预:POST /api/threads/:slug/message  body.targetInstance=<id>;历史按 thread 拉
// - WS 监听 instance.event 流式追加;按当前选中 instance 过滤

const MT_STATE = {
  instances: [],            // 完整 /api/instances/all?details=1 结果
  threadsByProject: {},     // projectId → threads[]  (lazy filled)
  selectedInstanceId: null,
  selectedMode: 'direct',   // 'direct' | 'intervention'
  selectedThreadSlug: null, // intervention 模式下选中的 thread
};

const MARKER_PATTERNS = [
  { kind: 'handoff', re: /<mate:handoff\b[^>]*>/gi },
  { kind: 'done', re: /<mate:done\b[^>]*\/?\s*>/gi },
  { kind: 'blocked', re: /<mate:blocked\b[^>]*>/gi },
];

async function refreshMatetermInstances() {
  try {
    const r = await fetch('/api/instances/all?details=1');
    if (!r.ok) throw new Error('fetch failed: ' + r.status);
    MT_STATE.instances = await r.json();
  } catch (e) {
    el('#mt-hint').textContent = '加载实例失败: ' + e.message;
    return;
  }
  renderMatetermInstanceOptions();
  updateMatetermHint();
}

function renderMatetermInstanceOptions() {
  const sel = el('#mt-instance');
  const mode = MT_STATE.selectedMode;
  // 干预模式 R 隐藏(主视图重复);直连模式全展示
  const list = MT_STATE.instances.filter((i) => {
    if (i.status === 'dead') return false;
    // [需求@2026-06-12 §9.3] 干预模式隐藏 R(主视图已覆盖);直连模式 R 仍可选
    if (mode === 'intervention' && i.roleType === 'requirements') return false;
    return true;
  });
  // Sort: by role name then slot
  list.sort((a, b) => {
    const rn = (a.roleName || '').localeCompare(b.roleName || '');
    if (rn !== 0) return rn;
    return (a.poolSlot || 0) - (b.poolSlot || 0);
  });
  const prev = MT_STATE.selectedInstanceId;
  sel.innerHTML = list.map((i) => {
    const name = i.displayName || i.id;
    const proj = i.projectName || '?';
    return `<option value="${escapeHtml(i.id)}">${escapeHtml(name)} · ${escapeHtml(proj)} · ${escapeHtml(i.status)}</option>`;
  }).join('') || '<option value="">(无可用实例)</option>';
  // Restore selection if still present
  if (prev && list.some((i) => i.id === prev)) {
    sel.value = prev;
  } else {
    MT_STATE.selectedInstanceId = sel.value || null;
  }
}

async function refreshMatetermThreads() {
  if (MT_STATE.selectedMode !== 'intervention' || !MT_STATE.selectedInstanceId) {
    el('#mt-thread-row').hidden = true;
    return;
  }
  el('#mt-thread-row').hidden = false;
  const inst = MT_STATE.instances.find((i) => i.id === MT_STATE.selectedInstanceId);
  if (!inst) return;
  const projectId = inst.projectId;
  try {
    const r = await fetch(`/api/threads?projectId=${projectId}`);
    if (!r.ok) throw new Error('fetch failed: ' + r.status);
    const threads = await r.json();
    MT_STATE.threadsByProject[projectId] = threads;
    const active = threads.filter((t) => t.stage !== 'closed');
    const sel = el('#mt-thread');
    sel.innerHTML = active.map((t) => `<option value="${escapeHtml(t.slug)}">${escapeHtml(t.title || t.slug)} (${escapeHtml(t.stage)})</option>`).join('')
      || '<option value="">(该 project 暂无活跃线索)</option>';
    if (MT_STATE.selectedThreadSlug && active.some((t) => t.slug === MT_STATE.selectedThreadSlug)) {
      sel.value = MT_STATE.selectedThreadSlug;
    } else {
      MT_STATE.selectedThreadSlug = sel.value || null;
    }
  } catch (e) {
    el('#mt-hint').textContent = '加载 thread 失败: ' + e.message;
  }
}

function updateMatetermHint() {
  const inst = MT_STATE.instances.find((i) => i.id === MT_STATE.selectedInstanceId);
  if (!inst) {
    el('#mt-hint').textContent = '选一个终端开始对话';
    return;
  }
  if (MT_STATE.selectedMode === 'direct') {
    el('#mt-hint').innerHTML = `<span class="hint-direct">📡 直连 <b>${escapeHtml(inst.displayName || inst.id)}</b> — 不挂 thread,marker 不触发派工(仅灰色展示)。</span>`;
  } else {
    const tInfo = MT_STATE.selectedThreadSlug ? ` · 干预 thread <b>${escapeHtml(MT_STATE.selectedThreadSlug)}</b>` : '';
    el('#mt-hint').innerHTML = `<span class="hint-interv">⚡ 干预模式 ${escapeHtml(inst.displayName || inst.id)}${tInfo} — 走正常派工链路,marker 会真生效。</span>`;
  }
}

function extractAssistantText(payload) {
  if (!payload) return '';
  if (payload.result) return payload.result;
  const content = payload.message?.content;
  if (Array.isArray(content)) {
    return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  }
  if (typeof content === 'string') return content;
  return '';
}

function extractUserText(payload) {
  if (!payload) return '';
  const content = payload.message?.content;
  if (Array.isArray(content)) {
    return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  }
  if (typeof content === 'string') return content;
  return '';
}

function renderMatetermMessage(m) {
  const ts = fmtTs(m.ts);
  if (m.direction === 'user_to_role' && (m.eventType === 'user' || !m.eventType)) {
    const text = extractUserText(m.payload);
    if (!text) return '';
    return `
      <div class="mt-msg user">
        <div class="mt-msg-head"><span class="who">you</span><span class="ts">${ts}</span></div>
        <div class="mt-msg-body">${escapeHtml(text)}</div>
      </div>
    `;
  }
  if (m.eventType === 'assistant') {
    const text = extractAssistantText(m.payload);
    if (!text) return '';
    const markerHints = [];
    for (const mp of MARKER_PATTERNS) {
      const matches = text.match(mp.re);
      if (matches) {
        for (const mm of matches) markerHints.push({ kind: mp.kind, raw: mm });
      }
    }
    const cleaned = escapeHtml(text);
    // direct mode: show gray "marker won't fire" hint
    const hintHtml = (MT_STATE.selectedMode === 'direct' && markerHints.length)
      ? `<div class="mt-marker-hint">⚠ 检测到 ${markerHints.length} 个 marker(${markerHints.map((h) => h.kind).join(', ')})— 直连模式不触发派工 / 状态机。</div>`
      : '';
    return `
      <div class="mt-msg assistant">
        <div class="mt-msg-head"><span class="who">${escapeHtml(m.roleName || 'assistant')}</span><span class="ts">${ts}</span></div>
        <div class="mt-msg-body">${cleaned}</div>
        ${hintHtml}
      </div>
    `;
  }
  if (m.eventType?.startsWith('result')) {
    return `<div class="mt-msg system">— 一轮结束 · ${ts} —</div>`;
  }
  return '';
}

async function reloadMatetermHistory() {
  const streamEl = el('#mt-stream');
  if (!MT_STATE.selectedInstanceId) {
    streamEl.innerHTML = '<div class="mt-empty">选一个终端开始</div>';
    return;
  }
  streamEl.innerHTML = '<div class="mt-empty">加载历史 ...</div>';
  try {
    let rows = [];
    if (MT_STATE.selectedMode === 'direct') {
      const r = await fetch(`/api/instances/${encodeURIComponent(MT_STATE.selectedInstanceId)}/direct-history?limit=200`);
      if (!r.ok) throw new Error('fetch failed: ' + r.status);
      rows = await r.json();
    } else if (MT_STATE.selectedMode === 'intervention' && MT_STATE.selectedThreadSlug) {
      const inst = MT_STATE.instances.find((i) => i.id === MT_STATE.selectedInstanceId);
      if (!inst) throw new Error('实例不存在');
      const r = await fetch(`/api/threads/${encodeURIComponent(MT_STATE.selectedThreadSlug)}/history?projectId=${inst.projectId}&limit=200`);
      if (!r.ok) throw new Error('fetch failed: ' + r.status);
      rows = await r.json();
    }
    if (!rows.length) {
      streamEl.innerHTML = '<div class="mt-empty">(无历史)</div>';
      return;
    }
    streamEl.innerHTML = rows.map(renderMatetermMessage).filter(Boolean).join('');
    streamEl.scrollTop = streamEl.scrollHeight;
  } catch (e) {
    streamEl.innerHTML = `<div class="mt-empty">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

async function sendMatetermMessage() {
  const text = el('#mt-input').value.trim();
  if (!text) return;
  if (!MT_STATE.selectedInstanceId) return alert('请先选一个终端');
  const sendBtn = el('#mt-send');
  sendBtn.disabled = true;
  try {
    if (MT_STATE.selectedMode === 'direct') {
      const r = await fetch(`/api/instances/${encodeURIComponent(MT_STATE.selectedInstanceId)}/direct-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
    } else {
      if (!MT_STATE.selectedThreadSlug) throw new Error('请先选一条 thread');
      const inst = MT_STATE.instances.find((i) => i.id === MT_STATE.selectedInstanceId);
      const r = await fetch(`/api/threads/${encodeURIComponent(MT_STATE.selectedThreadSlug)}/message?projectId=${inst.projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, targetInstance: MT_STATE.selectedInstanceId, projectId: inst.projectId }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
    }
    el('#mt-input').value = '';
    // 不强制重载;WS 会推 user_to_role + assistant 增量。但首次 user 消息有时 ws 滞后,做一次 history 回拉。
    setTimeout(reloadMatetermHistory, 300);
  } catch (e) {
    alert('发送失败: ' + e.message);
  } finally {
    sendBtn.disabled = false;
  }
}

// WebSocket: 监听 instance.event,过滤当前选中 instance + 当前模式匹配
function setupMatetermWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener('message', (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { return; }
    // [需求@2026-06-12 §8.10] 全局 cap warn 顶栏红条
    if (msg.type === 'system.cap_warn') {
      const b = el('#db-cap-banner');
      if (b) {
        b.hidden = false;
        b.textContent = `⚠ 实例数 ${msg.payload.alive}/${msg.payload.cap} — 软上限,清理空闲`;
        b.onclick = () => { b.hidden = true; };
      }
      return;
    }
    if (msg.type !== 'instance.event') return;
    const p = msg.payload;
    if (!p || p.instanceId !== MT_STATE.selectedInstanceId) return;
    // 模式过滤:direct 模式只看 directTarget 非 null 的事件;intervention 模式只看挂 thread 的
    if (MT_STATE.selectedMode === 'direct' && !p.directTarget) return;
    if (MT_STATE.selectedMode === 'intervention') {
      if (p.directTarget) return;
      if (MT_STATE.selectedThreadSlug && p.threadSlug && p.threadSlug !== MT_STATE.selectedThreadSlug) return;
    }
    // 跳过高频 partial
    if (p.eventType === 'stream_event') return;
    // 渲染单条
    const m = {
      direction: p.eventType === 'user' ? 'user_to_role' : p.eventType === 'assistant' ? 'role_to_user' : 'system',
      eventType: p.eventType,
      payload: p.raw,
      ts: p.ts,
      roleName: p.roleName,
    };
    const html = renderMatetermMessage(m);
    if (!html) return;
    const streamEl = el('#mt-stream');
    const wasAtBottom = streamEl.scrollTop + streamEl.clientHeight >= streamEl.scrollHeight - 50;
    if (streamEl.querySelector('.mt-empty')) streamEl.innerHTML = '';
    streamEl.insertAdjacentHTML('beforeend', html);
    if (wasAtBottom) streamEl.scrollTop = streamEl.scrollHeight;
  });
  ws.addEventListener('close', () => setTimeout(setupMatetermWS, 2000));
}

function wireMatetermUI() {
  el('#mt-instance').addEventListener('change', (e) => {
    MT_STATE.selectedInstanceId = e.target.value || null;
    updateMatetermHint();
    refreshMatetermThreads();
    reloadMatetermHistory();
  });
  document.querySelectorAll('input[name="mt-mode"]').forEach((r) => {
    r.addEventListener('change', () => {
      MT_STATE.selectedMode = document.querySelector('input[name="mt-mode"]:checked').value;
      renderMatetermInstanceOptions();
      updateMatetermHint();
      refreshMatetermThreads();
      reloadMatetermHistory();
    });
  });
  el('#mt-thread').addEventListener('change', (e) => {
    MT_STATE.selectedThreadSlug = e.target.value || null;
    updateMatetermHint();
    reloadMatetermHistory();
  });
  el('#mt-refresh').addEventListener('click', () => {
    refreshMatetermInstances().then(refreshMatetermThreads);
  });
  el('#mt-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sendMatetermMessage();
  });
  el('#mt-input').addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      sendMatetermMessage();
    }
  });
}

async function refreshControl() {
  await refreshMatetermInstances();
  await refreshMatetermThreads();
  await reloadMatetermHistory();
}

// ============================== Tabs + auto-refresh ==============================

async function refreshActiveTab() {
  if (currentTab === 'terminals') await refreshTerminalsList();
  else if (currentTab === 'queue') await refreshQueueList();
  else if (currentTab === 'dispatch') await refreshDispatchHistory();
  else if (currentTab === 'control') await refreshMatetermInstances();  // 只刷实例下拉,不重拉历史(避免打断对话)
  updateLastRefresh();
}

function switchTab(target) {
  if (!['terminals', 'queue', 'dispatch', 'control'].includes(target)) target = 'terminals';
  const isEnteringControl = currentTab !== 'control' && target === 'control';
  currentTab = target;
  document.querySelectorAll('#dashboard-tabs .tab-btn').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === target);
  });
  document.querySelectorAll('.tab-content').forEach((c) => {
    c.hidden = c.dataset.tab !== target;
  });
  if (location.hash !== `#tab=${target}`) {
    history.replaceState(null, '', `#tab=${target}`);
  }
  // 进入 control tab → full init(实例 + thread + 历史)
  if (isEnteringControl) {
    refreshControl();
    updateLastRefresh();
    return;
  }
  refreshActiveTab();
}

function tabFromHash() {
  const m = location.hash.match(/^#tab=(\w+)/);
  return m ? m[1] : 'terminals';
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(refreshActiveTab, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function wireUI() {
  document.querySelectorAll('#dashboard-tabs .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Tab 1 toolbar
  el('#term-include-dead').addEventListener('change', () => refreshTerminalsList(false));

  // Tab 2 toolbar
  el('#queue-include-closed').addEventListener('change', () => refreshQueueList(false));

  // Tab 3 toolbar
  document.querySelectorAll('input[name="dispatch-view"]').forEach((r) => {
    r.addEventListener('change', () => refreshDispatchHistory(false));
  });

  // Global refresh + auto-refresh toggle
  el('#db-refresh-btn').addEventListener('click', refreshActiveTab);
  el('#db-autorefresh').addEventListener('change', (e) => {
    if (e.target.checked) startAutoRefresh();
    else stopAutoRefresh();
  });

  // Hash-driven tab
  window.addEventListener('hashchange', () => switchTab(tabFromHash()));

  // Pause auto-refresh when page hidden, resume on visible (save API calls when in background tab)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAutoRefresh();
    else if (el('#db-autorefresh').checked) startAutoRefresh();
  });
}

// ============================== Bootstrap ==============================

(function init() {
  wireUI();
  wireMatetermUI();
  switchTab(tabFromHash());
  startAutoRefresh();
  setupMatetermWS();
  // 首次 tab=control 时也要初始化下拉
  if (currentTab === 'control') refreshControl();
})();
