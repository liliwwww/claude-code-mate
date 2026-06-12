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

// ============================== Tabs + auto-refresh ==============================

async function refreshActiveTab() {
  if (currentTab === 'terminals') await refreshTerminalsList();
  else if (currentTab === 'queue') await refreshQueueList();
  else if (currentTab === 'dispatch') await refreshDispatchHistory();
  // control tab is placeholder; nothing to refresh
  updateLastRefresh();
}

function switchTab(target) {
  if (!['terminals', 'queue', 'dispatch', 'control'].includes(target)) target = 'terminals';
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
  switchTab(tabFromHash());
  startAutoRefresh();
})();
