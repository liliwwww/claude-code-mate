// [需求@2026-06-12 §8.6.5] 仪表盘独立页面 JS
//   - 4 tab(终端实时 / 任务队列 / H 派工时序 / 对话控制)
//   - 10s 自动刷新当前 tab(可关)
//   - 支持 #tab=xxx hash 深链接
//   - 跨 project 视图(独立于主视图的 activeProject)

const STAGE_ORDER = ['discussing', 'designing', 'executing', 'testing', 'verified', 'closed'];
const AUTO_REFRESH_MS = 10000;

const el = (sel) => document.querySelector(sel);

// ---------------- i18n helper ----------------
const t = (key, params) => (window.MateI18n ? window.MateI18n.t(key, params) : key);
function applyDashboardLangBtn() {
  const btn = el('#lang-btn');
  if (!btn || !window.MateI18n) return;
  btn.textContent = window.MateI18n.getLang() === 'zh' ? 'EN' : '中';
}

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
  el('#db-last-refresh').textContent = t('dashboard.lastRefresh', { time: fmtTs(Date.now()) });
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
    listEl.innerHTML = `<div class="term-empty">${escapeHtml(t('dashboard.terminals.loadFailed', { error: e.message }))}</div>`;
  }
}

function renderTerminalsList(instances) {
  const listEl = el('#terminals-list');
  if (!instances.length) {
    listEl.innerHTML = `<div class="term-empty">${escapeHtml(t('dashboard.terminals.empty'))}</div>`;
    return;
  }
  const head = `
    <div class="term-row head">
      <div></div>
      <div>${escapeHtml(t('dashboard.terminals.col.name'))}</div>
      <div>${escapeHtml(t('dashboard.terminals.col.slot'))}</div>
      <div>${escapeHtml(t('dashboard.terminals.col.project'))}</div>
      <div>${escapeHtml(t('dashboard.terminals.col.model'))}</div>
      <div>${escapeHtml(t('dashboard.terminals.col.pid'))}</div>
      <div>${escapeHtml(t('dashboard.terminals.col.activity'))}</div>
      <div>${escapeHtml(t('dashboard.terminals.col.memory'))}</div>
      <div></div>
    </div>
  `;
  const rows = instances.map((i) => {
    const canKill = !['dead', 'disconnected'].includes(i.status);
    const canSkill = !['dead', 'disconnected'].includes(i.status);
    const slotText = i.poolSlot != null ? String(i.poolSlot) : '-';
    const activity = i.latestActivity || t('dashboard.terminals.noActivity');
    // [需求@2026-06-14 B + 2026-06-15] 模型列 — 下拉切模型
    //   优先显 preferredModel(user 设的),否则 currentModel(claude 自报)
    //   disconnected 可以改 — 下次 send 时按 preferredModel spawn
    const modelFull = i.preferredModel || i.currentModel || '';
    const canSwitchModel = !['dead', 'spawning', 'busy'].includes(i.status);
    const memoryText = i.memory && i.memory.fileCount > 0
      ? `${t('dashboard.terminals.memUnit', { n: i.memory.fileCount })}${i.memory.latestMtime ? ' · ' + relTime(i.memory.latestMtime) : ''}`
      : '—';
    // [需求@2026-06-16 A4] context 容量徽章 — turns > 100 或 inputTokens > 100k 提示考虑 reset
    const ss = i.sessionStats || {};
    const ctxLevel = (ss.inputTokens > 150_000 || ss.turns > 200) ? 'danger'
                   : (ss.inputTokens > 80_000  || ss.turns > 100) ? 'warn'
                   : null;
    const ctxBadge = ctxLevel
      ? `<span class="term-ctx-${ctxLevel}" title="${escapeHtml(t('dashboard.terminals.ctxTip', {
            turns: ss.turns || 0,
            inTok: Math.round((ss.inputTokens||0)/1000),
            outTok: Math.round((ss.outputTokens||0)/1000),
            cost: (ss.totalCostUsd||0).toFixed(3),
          }))}">${ctxLevel === 'danger' ? '⚠' : '○'}</span>`
      : '';
    return `
      <div class="term-row">
        <div><span class="term-status ${i.status}">${i.status[0]}</span></div>
        <div title="${escapeHtml(i.id)} · session ${i.sessionId || '-'}">${escapeHtml(i.displayName || i.id)}${ctxBadge}</div>
        <div>${slotText}</div>
        <div>${escapeHtml(i.projectName || '?')}</div>
        <div title="${escapeHtml(modelFull || '(unknown)')}">${makeModelSelectorHtml(i.id, modelFull, canSwitchModel)}</div>
        <div>${i.pid ?? '-'}</div>
        <div title="${escapeHtml(activity)}">${escapeHtml(activity)}</div>
        <div title="${i.memory ? 'latest: ' + (i.memory.latestMtime ? new Date(i.memory.latestMtime).toLocaleString() : '-') : ''}">${escapeHtml(memoryText)}</div>
        <div class="term-actions">${canSkill
          ? `<button class="term-skill" data-id="${escapeHtml(i.id)}" data-name="${escapeHtml(i.displayName || i.id)}" title="${escapeHtml(t('dashboard.terminals.skillTip'))}">skill</button>`
          : ''}${canSkill /* 同条件:idle/busy/disconnected 可,dead/spawning 不可 — 跟 skill 共用 */
          ? `<button class="term-reset" data-id="${escapeHtml(i.id)}" data-name="${escapeHtml(i.displayName || i.id)}" title="${escapeHtml(t('dashboard.terminals.resetTip'))}">${escapeHtml(t('dashboard.terminals.resetBtn'))}</button>`
          : ''}${canKill
          ? `<button class="term-kill" data-id="${escapeHtml(i.id)}">${escapeHtml(t('dashboard.terminals.killTip'))}</button>`
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
      if (!confirm(t('dashboard.terminals.killConfirm', { id }))) return;
      try {
        const r = await fetch(`/api/instances/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!r.ok) throw new Error('kill failed');
        await refreshTerminalsList();
      } catch (err) {
        alert(t('dashboard.terminals.killFailed', { error: err.message }));
      }
    });
  });

  // [需求@2026-06-14 D] skill 指令对话框 — 下拉常用 slash + 自由输入
  listEl.querySelectorAll('.term-skill[data-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openSkillDialog(btn.dataset.id, btn.dataset.name);
    });
  });

  // [需求@2026-06-16] Reset Terminal — 给 instance 清账(kill child + 丢 session)
  listEl.querySelectorAll('.term-reset[data-id]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      if (!confirm(t('dashboard.terminals.resetConfirm', { name }))) return;
      btn.disabled = true;
      try {
        const r = await fetch(`/api/instances/${encodeURIComponent(id)}/reset`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({ error: r.statusText }));
          throw new Error(err.error || r.statusText);
        }
        await refreshTerminalsList();
      } catch (err) {
        alert(t('dashboard.terminals.resetFailed', { error: err.message }));
      } finally {
        btn.disabled = false;
      }
    });
  });

  // [需求@2026-06-15] model 下拉切换 — claude headless 不接 /model slash,
  //   改走 kill+respawn 路径:POST /switch-model → child kill → 下次 send 用新 model 起 session
  listEl.querySelectorAll('.term-model-sel[data-id]').forEach((sel) => {
    sel.addEventListener('change', async (e) => {
      const id = sel.dataset.id;
      const newModel = sel.value;
      const prevModel = sel.dataset.prev || '';
      if (!newModel || newModel === prevModel) return;
      if (!confirm(t('dashboard.terminals.switchModelConfirm', { id, model: newModel }))) {
        sel.value = prevModel;  // 还原
        return;
      }
      sel.disabled = true;
      try {
        const r = await fetch(`/api/instances/${encodeURIComponent(id)}/switch-model`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: newModel }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({ error: r.statusText }));
          throw new Error(err.error || r.statusText);
        }
        sel.dataset.prev = newModel;
        // 等 2 秒重新拉,看 status 翻 disconnected
        setTimeout(() => refreshTerminalsList(), 2000);
      } catch (err) {
        alert(t('dashboard.terminals.switchModelFailed', { error: err.message }));
        sel.value = prevModel;
      } finally {
        sel.disabled = false;
      }
    });
  });
}

// [需求@2026-06-15] 终端实时 model 下拉 — 当前 model 在列表里就标 selected
const KNOWN_MODELS = [
  { id: 'claude-opus-4-8',   label: 'opus-4-8' },
  { id: 'claude-opus-4-7',   label: 'opus-4-7' },
  { id: 'claude-sonnet-4-6', label: 'sonnet-4-6' },
  { id: 'claude-haiku-4-5',  label: 'haiku-4-5' },
  { id: 'claude-fable-5',    label: 'fable-5' },
];
function makeModelSelectorHtml(instanceId, currentFull, canSwitch) {
  if (!canSwitch) {
    // disconnected/dead 不能切,显短名
    const short = (currentFull || '').replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-\d{4}$/, '') || '—';
    return `<span class="muted">${escapeHtml(short)}</span>`;
  }
  // 找最匹配的(currentFull 可能带 -20251xxx 后缀,匹配前缀)
  const cur = currentFull || '';
  const matchedId = KNOWN_MODELS.find((m) => cur.startsWith(m.id))?.id || '';
  const opts = KNOWN_MODELS.map((m) => {
    const sel = m.id === matchedId ? ' selected' : '';
    return `<option value="${escapeHtml(m.id)}"${sel}>${escapeHtml(m.label)}</option>`;
  }).join('');
  // 如果 currentModel 不在 KNOWN 列表 → 加个 "(其它)" option 占位
  const otherOpt = !matchedId && cur ? `<option value="" selected disabled>${escapeHtml(cur.slice(0, 20))}</option>` : '';
  return `<select class="term-model-sel" data-id="${escapeHtml(instanceId)}" data-prev="${escapeHtml(matchedId)}" title="${escapeHtml(t('dashboard.terminals.modelTip'))}">${otherOpt}${opts}</select>`;
}

// [需求@2026-06-14 D] skill 指令对话框
//   desc 改成 key,渲染时再翻(便于语言切换)
const COMMON_SLASH = [
  { cmd: '/clear',   descKey: 'skill.preset.clear' },
  { cmd: '/resume',  descKey: 'skill.preset.resume' },
  { cmd: '/compact', descKey: 'skill.preset.compact' },
  { cmd: '/memory',  descKey: 'skill.preset.memory' },
  { cmd: '/status',  descKey: 'skill.preset.status' },
  { cmd: '/help',    descKey: 'skill.preset.help' },
  { cmd: '/cost',    descKey: 'skill.preset.cost' },
  { cmd: '/model',   descKey: 'skill.preset.model' },
];

function openSkillDialog(instanceId, displayName) {
  // 已开过的对话框先关
  document.querySelector('#skill-dialog')?.remove();
  const dlg = document.createElement('dialog');
  dlg.id = 'skill-dialog';
  // skill.dialog.title 含 <code>{name}</code> — 用 raw replace 保留 HTML
  const titleHtml = t('skill.dialog.title').replace('{name}', escapeHtml(displayName));
  const hintText = t('skill.dialog.hint', { name: displayName });
  dlg.innerHTML = `
    <form method="dialog" id="skill-form">
      <h3>${titleHtml}</h3>
      <label>${escapeHtml(t('skill.dialog.presetLabel'))}
        <select id="skill-preset">
          <option value="">${escapeHtml(t('skill.dialog.presetEmpty'))}</option>
          ${COMMON_SLASH.map((s) => `<option value="${escapeHtml(s.cmd)}">${escapeHtml(s.cmd)} · ${escapeHtml(t(s.descKey))}</option>`).join('')}
        </select>
      </label>
      <label>${escapeHtml(t('skill.dialog.freeInputLabel'))}
        <textarea id="skill-text" rows="3" placeholder="${escapeHtml(t('skill.dialog.placeholder'))}" autofocus></textarea>
      </label>
      <div class="muted" style="font-size:12px;margin:6px 0">
        ${escapeHtml(hintText)}
      </div>
      <div class="dialog-actions">
        <button type="button" id="skill-cancel">${escapeHtml(t('skill.dialog.cancel'))}</button>
        <button type="submit" id="skill-send">${escapeHtml(t('skill.dialog.send'))}</button>
      </div>
      <div id="skill-error" class="error" style="color:#d44;margin-top:6px"></div>
    </form>
  `;
  document.body.appendChild(dlg);
  dlg.showModal();
  const preset = dlg.querySelector('#skill-preset');
  const text = dlg.querySelector('#skill-text');
  preset.addEventListener('change', () => { if (preset.value) text.value = preset.value; });
  dlg.querySelector('#skill-cancel').addEventListener('click', () => dlg.close());
  dlg.querySelector('#skill-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const cmd = text.value.trim();
    if (!cmd) return;
    const errEl = dlg.querySelector('#skill-error');
    errEl.textContent = '';
    try {
      const r = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/slash`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(e.error || r.statusText);
      }
      dlg.close();
      await refreshTerminalsList();
    } catch (e) {
      errEl.textContent = e.message;
    }
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
    listEl.innerHTML = `<div class="queue-empty">${escapeHtml(t('dashboard.queue.loadFailed', { error: e.message }))}</div>`;
  }
}

function renderQueueList(threads) {
  const listEl = el('#queue-list');
  if (!threads.length) {
    listEl.innerHTML = `<div class="queue-empty">${escapeHtml(t('dashboard.queue.empty'))}</div>`;
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
          <div class="bindings" title="${escapeHtml(bindings)}">${escapeHtml(bindings || window.MateI18n.t('dashboard.queue.noBindings'))}</div>
          <div>${canArchive
            ? `<button class="archive-btn" data-slug="${escapeHtml(t.slug)}" data-pid="${t.projectId}">${escapeHtml(window.MateI18n.t('dashboard.queue.archiveBtn'))}</button>`
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
      if (!confirm(t('dashboard.queue.archiveConfirm', { slug }))) return;
      try {
        const r = await fetch(`/api/threads/${encodeURIComponent(slug)}?projectId=${projectId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage: 'closed' }),
        });
        if (!r.ok) throw new Error('archive failed');
        await refreshQueueList();
      } catch (err) {
        alert(t('dashboard.queue.archiveFailed', { error: err.message }));
      }
    });
  });
}

// ============================== Tab 3: dispatch history ==============================

async function refreshDispatchHistory(preserveScroll = true) {
  const listEl = el('#dispatch-list');
  const scrollY = listEl.scrollTop;
  try {
    // [Phase 2H Phase 4] 同时拉 queue 状态 + 历史 events
    const [r1, r2] = await Promise.all([
      fetch(`/api/dispatches/history?limit=200`),
      fetch(`/api/queue?status=all`),
    ]);
    if (!r1.ok) throw new Error('fetch dispatches failed: ' + r1.status);
    if (!r2.ok) throw new Error('fetch queue failed: ' + r2.status);
    const events = await r1.json();
    const queue = await r2.json();
    const view = (document.querySelector('input[name="dispatch-view"]:checked') || {}).value || 'thread';
    renderDispatchPanel(events, queue, view);
    if (preserveScroll) listEl.scrollTop = scrollY;
  } catch (e) {
    listEl.innerHTML = `<div class="dispatch-empty">${escapeHtml(t('dashboard.dispatch.loadFailed', { error: e.message }))}</div>`;
  }
}

// [Phase 2H Phase 4] 顶部:当前处理 + queue;下面:历史
function renderDispatchPanel(events, queue, view) {
  const listEl = el('#dispatch-list');
  const processing = queue.filter((q) => q.status === 'processing');
  const queued = queue.filter((q) => q.status === 'queued');
  const backlog = queue.filter((q) => q.status === 'backlog');

  const sections = [];

  // 当前处理中(highlight)
  if (processing.length) {
    sections.push(`<div class="ds-section ds-processing">
      <h5>${escapeHtml(t('dashboard.dispatch.nowProcessing'))} (${processing.length})</h5>
      ${processing.map(renderQueueRow).join('')}
    </div>`);
  }

  // 队列中(FIFO)
  if (queued.length) {
    sections.push(`<div class="ds-section ds-queued">
      <h5>${escapeHtml(t('dashboard.dispatch.queue'))} (${queued.length})</h5>
      ${queued.map((q, i) => renderQueueRow(q, i + 1)).join('')}
    </div>`);
  }

  // backlog
  if (backlog.length) {
    sections.push(`<div class="ds-section ds-backlog">
      <h5>${escapeHtml(t('dashboard.dispatch.backlog'))} (${backlog.length})</h5>
      ${backlog.map(renderQueueRow).join('')}
    </div>`);
  }

  // 历史
  if (events.length) {
    sections.push(`<div class="ds-section ds-history">
      <h5>${escapeHtml(t('dashboard.dispatch.history'))} (${events.length})</h5>`);
    if (view === 'global') {
      sections.push(renderDispatchGlobalInner(events));
    } else {
      sections.push(renderDispatchByThreadInner(events));
    }
    sections.push(`</div>`);
  }

  if (!sections.length) {
    listEl.innerHTML = `<div class="dispatch-empty">${escapeHtml(t('dashboard.dispatch.empty'))}</div>`;
    return;
  }
  listEl.innerHTML = sections.join('');
}

const DIR_ICON = {
  new_request:   '📨',  // R → H 新请求
  callback:      '↩',   // B/C → H 回栈
  down_dispatch: '⤴',   // H → B/C 下钻
  bounce_back:   '↻',   // H → R 反弹
};

function renderQueueRow(q, queuePos) {
  const p = q.payload || {};
  const dir = p.direction || 'unknown';
  const icon = DIR_ICON[dir] || '·';
  const from = p.fromDisplayName || q.fromInstanceId || '?';
  const to = p.toDisplayName || q.targetId || '?';
  const ts = q.processedAt || q.enqueuedAt;
  const time = ts ? fmtTs(ts) : '';
  const posTag = queuePos ? `<span class="ds-pos">#${queuePos}</span>` : '';
  const reason = (p.marker?.reason || '').slice(0, 80);
  const dirLabel = t('dashboard.dispatch.dir.' + dir) || dir;
  return `<div class="ds-row ds-status-${escapeHtml(q.status)}">
    ${posTag}
    <span class="ds-icon" title="${escapeHtml(dirLabel)}">${icon}</span>
    <span class="ds-from">${escapeHtml(from)}</span>
    <span class="ds-arrow">→</span>
    <span class="ds-to">${escapeHtml(to)}</span>
    <span class="ds-time">${time}</span>
    <span class="ds-thread" title="${escapeHtml(q.threadSlug || '')}">${escapeHtml((q.threadSlug || '').slice(0, 16))}</span>
    <span class="ds-reason" title="${escapeHtml(reason)}">${escapeHtml(reason)}</span>
  </div>`;
}

function renderDispatchByThreadInner(events) {
  if (!events.length) return '';
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
    html.push(`<h6><span class="slug">${escapeHtml(g.slug)}</span> <span class="proj">${escapeHtml(g.projectName)}</span></h6>`);
    for (const e of g.events) html.push(renderDispatchEvent(e));
    html.push(`</div>`);
  }
  return html.join('');
}

function renderDispatchGlobalInner(events) {
  const html = ['<div class="dispatch-thread">'];
  for (const e of events) {
    html.push(renderDispatchEvent(e, true));
  }
  html.push(`</div>`);
  return html.join('');
}

function renderDispatchEvent(e, includeThreadSlug = false) {
  let arrow = '';
  let kindCls = 'handoff';
  let kindShort = 'h-o';
  const slugPart = includeThreadSlug && e.threadSlug
    ? `<span class="slug" style="color:var(--text-secondary)">${escapeHtml(e.threadSlug.slice(0, 14))}</span>: `
    : '';
  if (e.kind === 'thread.handoff') {
    const from = e.payload.from || '?';
    const target = e.payload.target || e.payload.resolvedRole || '?';
    arrow = `<span class="arrow">${slugPart}${escapeHtml(from)} → ${escapeHtml(target)}</span>`;
    kindCls = 'handoff'; kindShort = 'h-o';
  } else if (e.kind === 'thread.done') {
    arrow = `<span class="arrow">${slugPart}${escapeHtml(t('dashboard.dispatch.done'))}</span>`;
    kindCls = 'done'; kindShort = 'done';
  } else if (e.kind === 'thread.blocked') {
    arrow = `<span class="arrow">${slugPart}${escapeHtml(t('dashboard.dispatch.blocked'))}</span>`;
    kindCls = 'blocked'; kindShort = 'blkd';
  } else if (e.kind === 'dispatch.rejected') {
    const from = e.payload.fromDisplayName || e.payload.fromInstanceId || '?';
    arrow = `<span class="arrow">${slugPart}✗ ${escapeHtml(from)} ${escapeHtml(t('dashboard.dispatch.rejected'))}</span>`;
    kindCls = 'rejected'; kindShort = 'rjct';
  }
  const reason = e.payload.reason || e.payload.summary || e.payload.question || '';
  return `
    <div class="dispatch-event ${kindCls}">
      <div class="ts">${fmtTs(e.ts)}</div>
      <div class="kind-tag">${kindShort}</div>
      ${arrow}
      <div class="reason" title="${escapeHtml(reason)}">${escapeHtml(reason.slice(0, 80))}</div>
    </div>
  `;
}

// [Phase 2H Phase 4] dispatch tab WS 实时刷新 — 任何 dispatch.* / queue.* 事件触发 refresh
let dispatchRefreshDebounce = null;
function setupDispatchWS() {
  if (!window.MateWS) return;
  const topics = [
    'dispatch.scheduled', 'dispatch.started', 'dispatch.completed', 'dispatch.rejected',
    'dispatch.chain_updated',
    'queue.added', 'queue.claimed', 'queue.cancelled',
    'backlog.added', 'backlog.dispatched', 'backlog.cancelled',
    'thread.handoff', 'thread.done', 'thread.blocked',
  ];
  for (const top of topics) {
    window.MateWS.subscribe(top, () => {
      if (currentTab !== 'dispatch') return;
      if (dispatchRefreshDebounce) clearTimeout(dispatchRefreshDebounce);
      dispatchRefreshDebounce = setTimeout(() => refreshDispatchHistory(true), 250);
    });
  }
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
    el('#mt-hint').textContent = t('dashboard.control.loadInstFailed', { error: e.message });
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
  }).join('') || `<option value="">${escapeHtml(t('dashboard.control.noInstances'))}</option>`;
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
    sel.innerHTML = active.map((th) => `<option value="${escapeHtml(th.slug)}">${escapeHtml(th.title || th.slug)} (${escapeHtml(th.stage)})</option>`).join('')
      || `<option value="">${escapeHtml(t('dashboard.control.noThreads'))}</option>`;
    if (MT_STATE.selectedThreadSlug && active.some((th) => th.slug === MT_STATE.selectedThreadSlug)) {
      sel.value = MT_STATE.selectedThreadSlug;
    } else {
      MT_STATE.selectedThreadSlug = sel.value || null;
    }
  } catch (e) {
    el('#mt-hint').textContent = t('dashboard.control.loadThreadFailed', { error: e.message });
  }
}

function updateMatetermHint() {
  const inst = MT_STATE.instances.find((i) => i.id === MT_STATE.selectedInstanceId);
  if (!inst) {
    el('#mt-hint').textContent = t('dashboard.control.pickHint');
    return;
  }
  const name = escapeHtml(inst.displayName || inst.id);
  if (MT_STATE.selectedMode === 'direct') {
    // hintDirect 含 <b>{name}</b> — 保留 HTML
    const html = t('dashboard.control.hintDirect').replace('{name}', name);
    el('#mt-hint').innerHTML = `<span class="hint-direct">${html}</span>`;
  } else {
    const tInfo = MT_STATE.selectedThreadSlug
      ? t('dashboard.control.hintInterventionTInfo').replace('{slug}', escapeHtml(MT_STATE.selectedThreadSlug))
      : '';
    const html = t('dashboard.control.hintIntervention')
      .replace('{name}', name)
      .replace('{tInfo}', tInfo);
    el('#mt-hint').innerHTML = `<span class="hint-interv">${html}</span>`;
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
        <div class="mt-msg-head"><span class="who">${escapeHtml(window.MateI18n.t('dashboard.control.userWho'))}</span><span class="ts">${ts}</span></div>
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
      ? `<div class="mt-marker-hint">${escapeHtml(window.MateI18n.t('dashboard.control.markerHint', { n: markerHints.length, kinds: markerHints.map((h) => h.kind).join(', ') }))}</div>`
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
    return `<div class="mt-msg system">${escapeHtml(window.MateI18n.t('dashboard.control.turnEnded', { ts }))}</div>`;
  }
  return '';
}

async function reloadMatetermHistory() {
  const streamEl = el('#mt-stream');
  if (!MT_STATE.selectedInstanceId) {
    streamEl.innerHTML = `<div class="mt-empty">${escapeHtml(t('dashboard.control.pickHintEmpty'))}</div>`;
    return;
  }
  streamEl.innerHTML = `<div class="mt-empty">${escapeHtml(t('dashboard.control.history.loading'))}</div>`;
  try {
    let rows = [];
    if (MT_STATE.selectedMode === 'direct') {
      const r = await fetch(`/api/instances/${encodeURIComponent(MT_STATE.selectedInstanceId)}/direct-history?limit=200`);
      if (!r.ok) throw new Error('fetch failed: ' + r.status);
      rows = await r.json();
    } else if (MT_STATE.selectedMode === 'intervention' && MT_STATE.selectedThreadSlug) {
      const inst = MT_STATE.instances.find((i) => i.id === MT_STATE.selectedInstanceId);
      if (!inst) throw new Error(t('dashboard.control.instMissing'));
      const r = await fetch(`/api/threads/${encodeURIComponent(MT_STATE.selectedThreadSlug)}/history?projectId=${inst.projectId}&limit=200`);
      if (!r.ok) throw new Error('fetch failed: ' + r.status);
      rows = await r.json();
    }
    if (!rows.length) {
      streamEl.innerHTML = `<div class="mt-empty">${escapeHtml(t('dashboard.control.history.empty'))}</div>`;
      return;
    }
    streamEl.innerHTML = rows.map(renderMatetermMessage).filter(Boolean).join('');
    streamEl.scrollTop = streamEl.scrollHeight;
  } catch (e) {
    streamEl.innerHTML = `<div class="mt-empty">${escapeHtml(t('dashboard.control.history.loadFailed', { error: e.message }))}</div>`;
  }
}

function makeMtClientId() {
  return `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function appendMtOptimisticBubble(text, clientMessageId) {
  const streamEl = el('#mt-stream');
  if (streamEl.querySelector('.mt-empty')) streamEl.innerHTML = '';
  const node = document.createElement('div');
  node.className = 'mt-msg user mt-msg-sending';
  node.dataset.clientId = clientMessageId;
  node.innerHTML = `
    <div class="mt-msg-head"><span class="who">${escapeHtml(t('dashboard.control.userWho'))}</span><span class="ts">…</span></div>
    <div class="mt-msg-body"></div>
    <span class="mt-msg-status">· sending</span>
  `;
  node.querySelector('.mt-msg-body').textContent = text;
  streamEl.appendChild(node);
  streamEl.scrollTop = streamEl.scrollHeight;
  return node;
}

async function sendMatetermMessage() {
  const text = el('#mt-input').value.trim();
  if (!text) return;
  if (!MT_STATE.selectedInstanceId) return alert(t('dashboard.control.needTerm'));
  const sendBtn = el('#mt-send');
  sendBtn.disabled = true;
  // [需求@2026-06-12 Phase 2E §12] 乐观 UI:立即 bubble + clientMessageId dedup
  const clientMessageId = makeMtClientId();
  const bubble = appendMtOptimisticBubble(text, clientMessageId);
  el('#mt-input').value = '';
  try {
    if (MT_STATE.selectedMode === 'direct') {
      const r = await fetch(`/api/instances/${encodeURIComponent(MT_STATE.selectedInstanceId)}/direct-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
    } else {
      if (!MT_STATE.selectedThreadSlug) throw new Error(t('dashboard.control.needThread'));
      const inst = MT_STATE.instances.find((i) => i.id === MT_STATE.selectedInstanceId);
      const r = await fetch(`/api/threads/${encodeURIComponent(MT_STATE.selectedThreadSlug)}/message?projectId=${inst.projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, targetInstance: MT_STATE.selectedInstanceId, projectId: inst.projectId, clientMessageId }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
    }
    bubble.classList.remove('mt-msg-sending');
    bubble.classList.add('mt-msg-sent');
  } catch (e) {
    bubble.classList.remove('mt-msg-sending');
    bubble.classList.add('mt-msg-failed');
    bubble.title = t('dashboard.control.sendFailedTip', { error: e.message });
    bubble.addEventListener('click', () => {
      el('#mt-input').value = text;
      el('#mt-input').focus();
      bubble.remove();
    }, { once: true });
  } finally {
    sendBtn.disabled = false;
  }
}

// [arch §9 ✅] 通过 MateWS 单例订阅;不再自建 WebSocket
//   关心两类 topic:system.cap_warn(显红条)和 instance.event(渲染 mateTerm)
function setupMatetermWS() {
  if (!window.MateWS) {
    console.warn('[dashboard] MateWS not loaded — check script order in dashboard.html');
    return;
  }
  window.MateWS.subscribe('system.cap_warn', (msg) => {
    const b = el('#db-cap-banner');
    if (b) {
      b.hidden = false;
      b.textContent = t('dashboard.control.capBanner', { alive: msg.payload.alive, cap: msg.payload.cap });
      b.onclick = () => { b.hidden = true; };
    }
  });
  window.MateWS.subscribe('instance.event', (msg) => {
    const p = msg.payload;
    if (!p || p.instanceId !== MT_STATE.selectedInstanceId) return;
    // 模式过滤:direct 模式只看 directTarget 非 null;intervention 只看挂 thread 的
    if (MT_STATE.selectedMode === 'direct' && !p.directTarget) return;
    if (MT_STATE.selectedMode === 'intervention') {
      if (p.directTarget) return;
      if (MT_STATE.selectedThreadSlug && p.threadSlug && p.threadSlug !== MT_STATE.selectedThreadSlug) return;
    }
    if (p.eventType === 'stream_event') return;  // 跳过高频 partial
    const streamEl = el('#mt-stream');
    // [需求@2026-06-12 Phase 2E §12] user echo dedup
    if (p.eventType === 'user' && p.clientMessageId) {
      const existing = streamEl.querySelector(`.mt-msg.user[data-client-id="${CSS.escape(p.clientMessageId)}"]`);
      if (existing) {
        existing.dataset.serverId = p.serverMessageId || '';
        return;
      }
    }
    const m = {
      direction: p.eventType === 'user' ? 'user_to_role' : p.eventType === 'assistant' ? 'role_to_user' : 'system',
      eventType: p.eventType,
      payload: p.raw,
      ts: p.ts,
      roleName: p.roleName,
    };
    const html = renderMatetermMessage(m);
    if (!html) return;
    const wasAtBottom = streamEl.scrollTop + streamEl.clientHeight >= streamEl.scrollHeight - 50;
    if (streamEl.querySelector('.mt-empty')) streamEl.innerHTML = '';
    streamEl.insertAdjacentHTML('beforeend', html);
    if (wasAtBottom) streamEl.scrollTop = streamEl.scrollHeight;
  });
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
  else if (currentTab === 'logs') await refreshLogStream();
  else if (currentTab === 'graph') await refreshGraph();
  updateLastRefresh();
}

function switchTab(target) {
  if (!['terminals', 'queue', 'dispatch', 'control', 'logs', 'graph'].includes(target)) target = 'terminals';
  const isEnteringControl = currentTab !== 'control' && target === 'control';
  const isEnteringLogs = currentTab !== 'logs' && target === 'logs';
  const isEnteringGraph = currentTab !== 'graph' && target === 'graph';
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
  // 进入 logs tab → 拉一次 + 装好下拉
  if (isEnteringLogs) {
    initLogStreamTab();
    updateLastRefresh();
    return;
  }
  // 进入 graph tab → 初始化 + 拉一次
  if (isEnteringGraph) {
    initGraphTab();
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

  // i18n 语言切换
  if (window.MateI18n) {
    applyDashboardLangBtn();
    const langBtn = el('#lang-btn');
    if (langBtn) {
      langBtn.addEventListener('click', () => {
        const cur = window.MateI18n.getLang();
        window.MateI18n.setLang(cur === 'zh' ? 'en' : 'zh');
      });
    }
    window.MateI18n.onChange(() => {
      applyDashboardLangBtn();
      // 触发当前 tab 重渲(因 cell text 都来自 t())
      refreshActiveTab();
    });
  }
}

// ============================== Tab 5: log-stream ==============================
// [需求@2026-06-14] 全局日志流 — 所有 claude 终端 stream 事件聚合
//   数据源:GET /api/log-stream 历史快照 + WS instance.event 实时追加
//   过滤:实例 / 线索 / 类型 / 时间窗 / 文本搜索
//   每行:ts · instance · eventType · summary(短)→ 点击 <details> 展开 raw

const LOG_STATE = {
  inited: false,
  rows: [],          // 当前显示的事件(已被 filter 过的)
  maxRows: 1000,     // 内存里最多保留多少行
  filters: { instanceId: '', threadSlug: '', eventType: 'all', window: '86400000', search: '', live: true },
};

async function initLogStreamTab() {
  if (!LOG_STATE.inited) {
    LOG_STATE.inited = true;
    wireLogStreamUI();
    setupLogStreamWS();
  }
  await populateLogStreamDropdowns();
  await refreshLogStream();
}

async function populateLogStreamDropdowns() {
  // 实例下拉:从 /api/instances/all?includeDead=1 拉
  try {
    const r = await fetch('/api/instances/all?includeDead=1');
    const insts = await r.json();
    const sel = el('#logs-instance');
    const cur = LOG_STATE.filters.instanceId;
    sel.innerHTML = `<option value="">${escapeHtml(t('dashboard.logs.allInstances'))}</option>` + insts
      .sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id))
      .map((i) => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.displayName || i.id)} (${escapeHtml(i.projectName || '?')})</option>`)
      .join('');
    sel.value = cur;
  } catch (e) {
    console.warn('[logs] populate instances failed', e);
  }
  // 线索下拉
  try {
    const r = await fetch('/api/threads/all?includeClosed=1');
    const threads = await r.json();
    const sel = el('#logs-thread');
    const cur = LOG_STATE.filters.threadSlug;
    sel.innerHTML = `<option value="">${escapeHtml(t('dashboard.logs.allThreads'))}</option>` + threads
      .map((th) => `<option value="${escapeHtml(th.slug)}">${escapeHtml(th.title || th.slug)} · ${escapeHtml(th.projectName || '?')}</option>`)
      .join('');
    sel.value = cur;
  } catch (e) {
    console.warn('[logs] populate threads failed', e);
  }
}

function readLogFilters() {
  LOG_STATE.filters.instanceId = el('#logs-instance').value || '';
  LOG_STATE.filters.threadSlug = el('#logs-thread').value || '';
  LOG_STATE.filters.eventType = el('#logs-eventtype').value || 'all';
  LOG_STATE.filters.window = el('#logs-window').value || '86400000';
  LOG_STATE.filters.search = el('#logs-search').value || '';
  LOG_STATE.filters.live = el('#logs-live').checked;
}

async function refreshLogStream() {
  readLogFilters();
  const params = ['limit=500'];
  if (LOG_STATE.filters.instanceId) params.push('instanceId=' + encodeURIComponent(LOG_STATE.filters.instanceId));
  if (LOG_STATE.filters.threadSlug) params.push('threadSlug=' + encodeURIComponent(LOG_STATE.filters.threadSlug));
  if (LOG_STATE.filters.eventType !== 'all') params.push('eventType=' + encodeURIComponent(LOG_STATE.filters.eventType));
  if (LOG_STATE.filters.window !== '0') params.push('since=' + (Date.now() - parseInt(LOG_STATE.filters.window, 10)));
  try {
    const r = await fetch('/api/log-stream?' + params.join('&'));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rows = await r.json();
    LOG_STATE.rows = rows;
    renderLogStream();
  } catch (e) {
    el('#logs-list').innerHTML = `<div class="logs-empty">${escapeHtml(t('dashboard.logs.loadFailed', { error: e.message }))}</div>`;
  }
}

function renderLogStream() {
  const listEl = el('#logs-list');
  const search = LOG_STATE.filters.search.toLowerCase().trim();
  let rows = LOG_STATE.rows;
  if (search) {
    rows = rows.filter((m) => {
      const json = JSON.stringify(m.payload || {}).toLowerCase();
      return json.includes(search) || (m.instanceId || '').toLowerCase().includes(search) || (m.eventType || '').toLowerCase().includes(search);
    });
  }
  el('#logs-count').textContent = t('dashboard.logs.count', { n: rows.length, suffix: search ? t('dashboard.logs.countAfterSearch') : '', total: LOG_STATE.rows.length });
  if (!rows.length) {
    listEl.innerHTML = `<div class="logs-empty">${escapeHtml(t('dashboard.logs.empty'))}</div>`;
    return;
  }
  listEl.innerHTML = rows.map(makeLogRowHtml).join('');
}

function makeLogRowHtml(m) {
  const ts = new Date(m.ts);
  const tsStr = `${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}:${String(ts.getSeconds()).padStart(2,'0')}.${String(ts.getMilliseconds()).padStart(3,'0')}`;
  const summary = logRowSummary(m);
  const etCls = (m.eventType || '').replace(/[\/.]/g, '_');
  const payloadStr = JSON.stringify(m.payload, null, 2);
  // 不全部把 payload 渲到 DOM(太大),只显前 8KB,details 展开时按 data-* 取
  const preview = payloadStr.length > 8000 ? payloadStr.slice(0, 8000) + t('dashboard.logs.truncated', { n: payloadStr.length - 8000 }) : payloadStr;
  return `
    <details class="logs-row logs-et-${escapeHtml(etCls)}">
      <summary>
        <span class="logs-ts">${tsStr}</span>
        <span class="logs-inst" title="${escapeHtml(m.instanceId || '')}">${escapeHtml((m.instanceId || '').replace(/^mate-/, ''))}</span>
        <span class="logs-et">${escapeHtml(m.eventType || '')}</span>
        <span class="logs-thread">${escapeHtml(m.threadSlug || (m.directTarget ? t('dashboard.logs.directTarget') : '-'))}</span>
        <span class="logs-sum">${escapeHtml(summary)}</span>
      </summary>
      <pre class="logs-raw">${escapeHtml(preview)}</pre>
    </details>
  `;
}

function logRowSummary(m) {
  const p = m.payload || {};
  if (m.eventType === 'system/init') return `session ${(p.session_id || '?').slice(0, 8)}… model ${p.model || '?'}`;
  if (m.eventType === 'assistant') {
    const content = p.message?.content || [];
    const tools = content.filter((c) => c.type === 'tool_use');
    const texts = content.filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim();
    if (tools.length) return `🔧 ${tools.map((t) => t.name).join(', ')}`;
    if (texts) return texts.length > 100 ? texts.slice(0, 100) + '…' : texts;
    return t('dashboard.logs.emptyAssistant');
  }
  if (m.eventType === 'user') {
    const content = p.message?.content || [];
    const trs = Array.isArray(content) ? content.filter((c) => c.type === 'tool_result') : [];
    if (trs.length) return t('dashboard.logs.toolResultHas', { n: trs.length, err: trs.some((tr) => tr.is_error) ? t('dashboard.logs.toolResultErr') : '' });
    const txt = Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join(' ') : (typeof content === 'string' ? content : '');
    return txt.length > 100 ? txt.slice(0, 100) + '…' : (txt || t('dashboard.logs.emptyUser'));
  }
  if (m.eventType?.startsWith('result')) {
    const ok = p.is_error !== true;
    return ok ? `✓ cost $${(p.total_cost_usd || 0).toFixed(4)} · ${p.duration_ms || 0}ms · ${p.num_turns || 0} turns` : `✗ ${p.api_error_status || ''} ${(p.result || '').slice(0, 60)}`;
  }
  if (m.eventType === 'stream_event') {
    const sub = p.event?.type || '?';
    if (sub === 'content_block_delta') {
      const dt = p.event?.delta?.text;
      if (dt) return `Δ ${dt.length > 80 ? dt.slice(0, 80) + '…' : dt}`;
    }
    return sub;
  }
  if (m.eventType === 'rate_limit_event') return `rate: ${JSON.stringify(p).slice(0, 120)}`;
  return JSON.stringify(p).slice(0, 120);
}

function wireLogStreamUI() {
  // filter changes → reload from server(因服务器端过滤);search 走客户端
  ['#logs-instance', '#logs-thread', '#logs-eventtype', '#logs-window'].forEach((sel) => {
    el(sel).addEventListener('change', () => refreshLogStream());
  });
  el('#logs-search').addEventListener('input', () => { readLogFilters(); renderLogStream(); });
  el('#logs-live').addEventListener('change', () => readLogFilters());
  el('#logs-refresh').addEventListener('click', () => refreshLogStream());
}

function setupLogStreamWS() {
  if (!window.MateWS) return;
  window.MateWS.subscribe('instance.event', (msg) => {
    if (currentTab !== 'logs') return;
    if (!LOG_STATE.filters.live) return;
    const p = msg.payload;
    if (!p) return;
    // 应用服务端等价的过滤(client 侧也滤一次,因为 WS 推送是全量)
    if (LOG_STATE.filters.instanceId && p.instanceId !== LOG_STATE.filters.instanceId) return;
    if (LOG_STATE.filters.threadSlug && p.threadSlug !== LOG_STATE.filters.threadSlug) return;
    if (LOG_STATE.filters.eventType !== 'all') {
      const et = LOG_STATE.filters.eventType;
      if (et === 'result' || et === 'system') {
        if (!p.eventType?.startsWith(et)) return;
      } else if (p.eventType !== et) return;
    }
    // 添加到内存数组的开头,溢出截断
    const m = {
      id: p.serverMessageId || ('ws-' + Date.now()),
      instanceId: p.instanceId,
      roleName: p.roleName,
      direction: null,
      claudeSessionId: null,
      ts: p.ts || Date.now(),
      eventType: p.eventType,
      threadSlug: p.threadSlug,
      directTarget: p.directTarget,
      payload: p.raw,
    };
    LOG_STATE.rows.unshift(m);
    if (LOG_STATE.rows.length > LOG_STATE.maxRows) LOG_STATE.rows.length = LOG_STATE.maxRows;
    // 只渲染新行,prepend(避免全量重画)
    const listEl = el('#logs-list');
    if (listEl.querySelector('.logs-empty')) listEl.innerHTML = '';
    // 应用搜索 filter
    const search = LOG_STATE.filters.search.toLowerCase().trim();
    if (search) {
      const json = JSON.stringify(m.payload || {}).toLowerCase();
      if (!json.includes(search) && !(m.instanceId || '').toLowerCase().includes(search) && !(m.eventType || '').toLowerCase().includes(search)) return;
    }
    const wasAtTop = listEl.scrollTop < 30;
    listEl.insertAdjacentHTML('afterbegin', makeLogRowHtml(m));
    el('#logs-count').textContent = t('dashboard.logs.countLive', { n: LOG_STATE.rows.length });
    if (wasAtTop) listEl.scrollTop = 0;
  });
}

// ============================== Tab 6: state graph ==============================
// [需求@2026-06-15 Phase 2G M2] 状态图 — SVG 4 层节点-边图(R / H / B / C)
//   节点:实例(idle/busy/spawning/disconnected)
//   边:派工关系
//     实线 + 绿色 = 正在处理(active)
//     虚线 + 黄色 = 排队中(queued)
//     点线 + 蓝色 = backlog(等用户决策)
//   数据源:GET /api/runtime/snapshot + GET /api/queue?status=all
//   增量更新:WS instance.status_change / queue.* / backlog.* / dispatch.* → 防抖 refresh

const GRAPH_STATE = {
  inited: false,
  scope: 'global',         // 'global' | <projectId number>
  showDisc: false,
  defaultProjectId: 1,
  projects: [],
  snapshot: null,
  queue: [],
};

const LAYER_DEFS = [
  { type: 'requirements', key: 'R', labelKey: 'dashboard.graph.layerR', color: '#88ccff' },
  { type: 'orchestrator', key: 'H', labelKey: 'dashboard.graph.layerH', color: '#ffcc66' },
  { type: 'executor',     key: 'B', labelKey: 'dashboard.graph.layerB', color: '#aaffaa' },
  { type: 'validator',    key: 'C', labelKey: 'dashboard.graph.layerC', color: '#ffaaff' },
];

const NODE_W = 130;
const NODE_H = 52;
const LAYER_HEIGHT = 130;
const LAYER_LABEL_W = 60;
const NODE_GAP_X = 18;

async function initGraphTab() {
  if (!GRAPH_STATE.inited) {
    GRAPH_STATE.inited = true;
    wireGraphUI();
    setupGraphWS();
  }
  // 每次进 tab 都重拉 projects(防新增 project 没出现在下拉)
  try {
    const [sys, projects] = await Promise.all([
      fetch('/api/system').then((r) => r.json()),
      fetch('/api/projects').then((r) => r.json()),
    ]);
    GRAPH_STATE.defaultProjectId = sys.defaultProjectId || 1;
    GRAPH_STATE.projects = Array.isArray(projects) ? projects : [];
    populateGraphScopeSelect();
  } catch (e) {
    console.warn('[graph] init failed:', e.message);
  }
  await refreshGraph();
}

function populateGraphScopeSelect() {
  const sel = el('#graph-scope');
  if (!sel) return;
  const cur = String(GRAPH_STATE.scope);
  const opts = [`<option value="global">${escapeHtml(t('dashboard.graph.scopeAll'))}</option>`];
  for (const p of GRAPH_STATE.projects) {
    const label = p.id === GRAPH_STATE.defaultProjectId ? `${p.name} (default)` : p.name;
    opts.push(`<option value="${p.id}">${escapeHtml(label)}</option>`);
  }
  sel.innerHTML = opts.join('');
  // 恢复选择
  if ([...sel.options].some((o) => o.value === cur)) {
    sel.value = cur;
  } else {
    sel.value = 'global';
    GRAPH_STATE.scope = 'global';
  }
}

function wireGraphUI() {
  el('#graph-scope').addEventListener('change', (e) => {
    const v = e.target.value;
    GRAPH_STATE.scope = v === 'global' ? 'global' : parseInt(v, 10);
    refreshGraph();
  });
  el('#graph-show-disc').addEventListener('change', (e) => {
    GRAPH_STATE.showDisc = e.target.checked;
    renderGraph();
  });
  el('#graph-refresh').addEventListener('click', () => refreshGraph());
}

let graphRefreshDebounce = null;
function setupGraphWS() {
  if (!window.MateWS) return;
  const topics = [
    'instance.spawned', 'instance.status_change', 'instance.exited',
    'dispatch.busy_prompt',
    'queue.added', 'queue.claimed', 'queue.cancelled',
    'backlog.added', 'backlog.dispatched', 'backlog.cancelled',
    'dispatch.chain_updated',
  ];
  for (const top of topics) {
    window.MateWS.subscribe(top, () => {
      if (currentTab !== 'graph') return;
      if (graphRefreshDebounce) clearTimeout(graphRefreshDebounce);
      graphRefreshDebounce = setTimeout(() => refreshGraph(), 250);
    });
  }
}

async function refreshGraph() {
  // scope: 'global' → 不传 projectId; number → 传该 project
  const proj = (GRAPH_STATE.scope === 'global') ? null : GRAPH_STATE.scope;
  try {
    const snapUrl = proj ? `/api/runtime/snapshot?projectId=${proj}` : '/api/runtime/snapshot';
    const queueUrl = `/api/queue?status=all${proj ? '&projectId=' + proj : ''}`;
    const [snap, queue] = await Promise.all([
      fetch(snapUrl).then((r) => r.json()),
      fetch(queueUrl).then((r) => r.json()),
    ]);
    GRAPH_STATE.snapshot = snap;
    GRAPH_STATE.queue = Array.isArray(queue) ? queue : [];
    renderGraph();
  } catch (e) {
    console.warn('[graph] refresh failed', e);
  }
}

function renderGraph() {
  const svg = el('#graph-svg');
  if (!svg) return;
  const snap = GRAPH_STATE.snapshot;
  if (!snap) { svg.innerHTML = `<text x="20" y="40" fill="#888">${escapeHtml(t('dashboard.graph.empty'))}</text>`; return; }

  // 收集所有实例 → 按 roleType 分层
  const groups = { requirements: [], orchestrator: [], executor: [], validator: [] };
  const allInsts = [
    ...(snap.instances?.idle || []),
    ...(snap.instances?.busy || []),
    ...(snap.instances?.spawning || []),
  ];
  if (GRAPH_STATE.showDisc) allInsts.push(...(snap.instances?.disconnected || []));
  for (const i of allInsts) {
    const g = groups[i.roleType];
    if (g) g.push(i);
  }
  // R 按 displayName 排,池化角色按 poolSlot
  for (const t2 of Object.keys(groups)) {
    if (t2 === 'requirements') {
      groups[t2].sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id));
    } else {
      groups[t2].sort((a, b) => (a.poolSlot || 99) - (b.poolSlot || 99));
    }
  }

  // 计算总宽 / 行宽
  const maxCount = Math.max(1, ...LAYER_DEFS.map((l) => groups[l.type].length));
  const wrapW = el('#graph-canvas-wrap').clientWidth || 800;
  const innerW = wrapW - LAYER_LABEL_W - 40;  // padding
  const totalH = LAYER_DEFS.length * LAYER_HEIGHT + 40;

  // 索引 instance.id → 坐标
  const nodePos = new Map();
  // SVG defs — 3 种颜色箭头
  let html = `<defs>
    <marker id="arr-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#88dd88"/>
    </marker>
    <marker id="arr-queued" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#ffcc66"/>
    </marker>
    <marker id="arr-backlog" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#88ccff"/>
    </marker>
  </defs>`;
  html += `<g id="g-layers">`;
  LAYER_DEFS.forEach((layer, layerIdx) => {
    const y = 30 + layerIdx * LAYER_HEIGHT;
    // 层 label
    html += `<text x="10" y="${y + NODE_H / 2 + 5}" fill="#888" font-size="11" font-family="ui-monospace,Consolas,monospace">${escapeHtml(t(layer.labelKey))}</text>`;
    // 横分隔线
    html += `<line x1="${LAYER_LABEL_W}" y1="${y + NODE_H + 20}" x2="${wrapW - 20}" y2="${y + NODE_H + 20}" stroke="#333" stroke-dasharray="2,4" />`;
    // 节点
    const items = groups[layer.type] || [];
    if (!items.length) {
      html += `<text x="${LAYER_LABEL_W + 20}" y="${y + NODE_H / 2 + 4}" fill="#555" font-size="11" font-style="italic">(empty)</text>`;
    } else {
      const totalNodesW = items.length * NODE_W + (items.length - 1) * NODE_GAP_X;
      const startX = LAYER_LABEL_W + Math.max(20, (innerW - totalNodesW) / 2);
      items.forEach((i, idx) => {
        const x = startX + idx * (NODE_W + NODE_GAP_X);
        nodePos.set(i.id, { x: x + NODE_W / 2, yTop: y, yBot: y + NODE_H, cx: x + NODE_W / 2, cy: y + NODE_H / 2 });
        html += renderNode(i, x, y, layer.color);
      });
    }
  });
  html += `</g>`;

  // ----- 边:active dispatch(基于 thread.metadata.dispatch_chain)+ queued/backlog(基于 queue)
  // active 边:遍历所有线索的最近 chain segment(实线绿)
  html += `<g id="g-edges">`;
  html += renderActiveEdges(snap, nodePos);
  html += renderQueueEdges(GRAPH_STATE.queue, nodePos);
  html += `</g>`;

  svg.setAttribute('width', wrapW);
  svg.setAttribute('height', totalH);
  svg.innerHTML = html;

  // 状态信息
  const qCount = GRAPH_STATE.queue.filter((r) => r.status === 'queued').length;
  const bCount = GRAPH_STATE.queue.filter((r) => r.status === 'backlog').length;
  el('#graph-info').textContent = t('dashboard.graph.info', { n: allInsts.length, q: qCount, b: bCount });
}

function renderNode(inst, x, y, color) {
  const bgByStatus = {
    idle: '#1f2a1f',
    busy: '#3a2c1f',
    spawning: '#1f2a3a',
    disconnected: '#222',
    dead: '#3a1f1f',
  };
  const stroke = inst.status === 'busy' ? color : '#444';
  const strokeW = inst.status === 'busy' ? 2.5 : 1;
  const bg = bgByStatus[inst.status] || '#222';
  const taskSlug = inst.currentTaskSlug || inst.threadSlug || '';
  const taskShort = taskSlug ? taskSlug.slice(0, 14) + (taskSlug.length > 14 ? '…' : '') : '';
  const act = inst.currentActivity ? inst.currentActivity.slice(0, 16) : '';
  return `<g class="gn gn-${inst.status}">
    <rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="4" fill="${bg}" stroke="${stroke}" stroke-width="${strokeW}"/>
    <text x="${x + 8}" y="${y + 16}" fill="${color}" font-size="12" font-family="ui-monospace,Consolas,monospace" font-weight="600">${escapeHtml(inst.displayName || inst.id)}</text>
    <text x="${x + 8}" y="${y + 32}" fill="#aaa" font-size="10">${escapeHtml(inst.status)}${taskShort ? ' · ' + escapeHtml(taskShort) : ''}</text>
    <text x="${x + 8}" y="${y + 46}" fill="#777" font-size="10">${escapeHtml(act)}</text>
    <title>${escapeHtml(inst.id)} · ${escapeHtml(inst.status)}${taskSlug ? '\nthread: ' + taskSlug : ''}${act ? '\nact: ' + inst.currentActivity : ''}</title>
  </g>`;
}

// active 边:从所有 thread 的 dispatch_chain 最后一段提取 from→to,画实线
function renderActiveEdges(snap, nodePos) {
  // 我们没有从 snapshot 直接拿 thread 列表 — 借 instance.threadSlug 反推
  //   每个 busy 实例的 threadSlug 是它当前在跑的线索 → 画从绑定的来源到此节点的边
  //   简化:只画 R → 池化实例(根据 thread 的 metadata 应该有,但 snapshot 不带)
  //   兜底:直接基于 instance 的 currentTaskSlug 配对找 R(同 thread 的 R)
  let edges = '';
  const allInsts = [
    ...(snap.instances?.busy || []),
    ...(snap.instances?.idle || []),
  ];
  // 找每个 thread 上的 R / H / B / C 配对
  const threadGroups = new Map();
  for (const i of allInsts) {
    const ts = i.currentTaskSlug || i.threadSlug;
    if (!ts) continue;
    if (!threadGroups.has(ts)) threadGroups.set(ts, {});
    threadGroups.get(ts)[i.roleType] = i;
  }
  // R → H → B/C 各层连边(只画相邻层)
  for (const [, g] of threadGroups) {
    if (g.requirements && g.orchestrator) {
      edges += drawEdge(g.requirements.id, g.orchestrator.id, nodePos, 'active');
    }
    if (g.orchestrator && g.executor) {
      edges += drawEdge(g.orchestrator.id, g.executor.id, nodePos, 'active');
    }
    if (g.orchestrator && g.validator) {
      edges += drawEdge(g.orchestrator.id, g.validator.id, nodePos, 'active');
    }
  }
  return edges;
}

function renderQueueEdges(queue, nodePos) {
  let edges = '';
  for (const q of queue) {
    if (!['queued', 'backlog'].includes(q.status)) continue;
    if (!q.fromInstanceId || !q.targetId) continue;
    const cls = q.status === 'queued' ? 'queued' : 'backlog';
    edges += drawEdge(q.fromInstanceId, q.targetId, nodePos, cls);
  }
  return edges;
}

function drawEdge(fromId, toId, nodePos, cls) {
  const a = nodePos.get(fromId);
  const b = nodePos.get(toId);
  if (!a || !b) return '';
  // 从 from 底中 → to 顶中,曲线
  const x1 = a.cx;
  const y1 = a.yBot;
  const x2 = b.cx;
  const y2 = b.yTop;
  const midY = (y1 + y2) / 2;
  const path = `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`;
  const styleMap = {
    active:  { stroke: '#88dd88', strokeW: 2,   dash: '',      marker: 'url(#arr-active)' },
    queued:  { stroke: '#ffcc66', strokeW: 1.5, dash: '4,3',   marker: 'url(#arr-queued)' },
    backlog: { stroke: '#88ccff', strokeW: 1.5, dash: '2,4',   marker: 'url(#arr-backlog)' },
  };
  const s = styleMap[cls] || styleMap.active;
  return `<path d="${path}" fill="none" stroke="${s.stroke}" stroke-width="${s.strokeW}" stroke-dasharray="${s.dash}" marker-end="${s.marker}" class="ge ge-${cls}"/>`;
}

// ============================== Bootstrap ==============================

(function init() {
  wireUI();
  wireMatetermUI();
  switchTab(tabFromHash());
  startAutoRefresh();
  setupMatetermWS();
  setupDispatchWS();
  // [需求@2026-06-12 Phase 2E §14] dashboard 顶栏挂 chip — 全局视图(projectId=null)
  if (window.RuntimeChip) window.RuntimeChip.init({ projectId: null });
  // 首次 tab=control 时也要初始化下拉
  if (currentTab === 'control') refreshControl();
  // 首次 tab=logs 时也要初始化
  if (currentTab === 'logs') initLogStreamTab();
  // 首次 tab=graph 时也要初始化
  if (currentTab === 'graph') initGraphTab();
})();
