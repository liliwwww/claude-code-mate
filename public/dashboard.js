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
      <div>Model</div>
      <div>PID</div>
      <div>当前活动</div>
      <div>Memory</div>
      <div></div>
    </div>
  `;
  const rows = instances.map((i) => {
    const canKill = !['dead', 'disconnected'].includes(i.status);
    const canSkill = !['dead', 'disconnected'].includes(i.status);
    const slotText = i.poolSlot != null ? String(i.poolSlot) : '-';
    const activity = i.latestActivity || '(no data)';
    // [需求@2026-06-14 B] 模型列 — currentModel 后端已有,extract short name
    const modelFull = i.currentModel || '';
    const modelShort = modelFull
      ? modelFull.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-\d{4}$/, '')
      : '—';
    const memoryText = i.memory && i.memory.fileCount > 0
      ? `${i.memory.fileCount} files${i.memory.latestMtime ? ' · ' + relTime(i.memory.latestMtime) : ''}`
      : '—';
    return `
      <div class="term-row">
        <div><span class="term-status ${i.status}">${i.status[0]}</span></div>
        <div title="${escapeHtml(i.id)} · session ${i.sessionId || '-'}">${escapeHtml(i.displayName || i.id)}</div>
        <div>${slotText}</div>
        <div>${escapeHtml(i.projectName || '?')}</div>
        <div title="${escapeHtml(modelFull || '(unknown)')}">${escapeHtml(modelShort)}</div>
        <div>${i.pid ?? '-'}</div>
        <div title="${escapeHtml(activity)}">${escapeHtml(activity)}</div>
        <div title="${i.memory ? 'latest: ' + (i.memory.latestMtime ? new Date(i.memory.latestMtime).toLocaleString() : '-') : ''}">${escapeHtml(memoryText)}</div>
        <div class="term-actions">${canSkill
          ? `<button class="term-skill" data-id="${escapeHtml(i.id)}" data-name="${escapeHtml(i.displayName || i.id)}" title="发 slash 指令(/clear, /help, etc.)">skill</button>`
          : ''}${canKill
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

  // [需求@2026-06-14 D] skill 指令对话框 — 下拉常用 slash + 自由输入
  listEl.querySelectorAll('.term-skill[data-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openSkillDialog(btn.dataset.id, btn.dataset.name);
    });
  });
}

// [需求@2026-06-14 D] skill 指令对话框
const COMMON_SLASH = [
  { cmd: '/clear',   desc: '清空当前 session 上下文' },
  { cmd: '/resume',  desc: '恢复上次 session' },
  { cmd: '/compact', desc: '让 claude 压缩当前对话' },
  { cmd: '/memory',  desc: '查看/编辑 claude memory' },
  { cmd: '/status',  desc: '看当前 session 状态' },
  { cmd: '/help',    desc: '看所有 slash 命令' },
  { cmd: '/cost',    desc: '查看当前 token 消耗' },
  { cmd: '/model',   desc: '查看/切换当前 model' },
];

function openSkillDialog(instanceId, displayName) {
  // 已开过的对话框先关
  document.querySelector('#skill-dialog')?.remove();
  const dlg = document.createElement('dialog');
  dlg.id = 'skill-dialog';
  dlg.innerHTML = `
    <form method="dialog" id="skill-form">
      <h3>对 <code>${escapeHtml(displayName)}</code> 发指令</h3>
      <label>常用 slash:
        <select id="skill-preset">
          <option value="">— 选一个 —</option>
          ${COMMON_SLASH.map((s) => `<option value="${escapeHtml(s.cmd)}">${escapeHtml(s.cmd)} · ${escapeHtml(s.desc)}</option>`).join('')}
        </select>
      </label>
      <label>或自由输入(slash / 自然语言都可):
        <textarea id="skill-text" rows="3" placeholder="/clear\n或: 把当前 todos 全标 done" autofocus></textarea>
      </label>
      <div class="muted" style="font-size:12px;margin:6px 0">
        指令会作为 user 消息写入 ${escapeHtml(displayName)} 的 stdin。注意:slash 命令是否生效取决于 claude headless 的支持。
      </div>
      <div class="dialog-actions">
        <button type="button" id="skill-cancel">取消</button>
        <button type="submit" id="skill-send">发送</button>
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
    <div class="mt-msg-head"><span class="who">you</span><span class="ts">…</span></div>
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
  if (!MT_STATE.selectedInstanceId) return alert('请先选一个终端');
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
      if (!MT_STATE.selectedThreadSlug) throw new Error('请先选一条 thread');
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
    bubble.title = `发送失败: ${e.message} · 点击重填`;
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
      b.textContent = `⚠ 实例数 ${msg.payload.alive}/${msg.payload.cap} — 软上限,清理空闲`;
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
  updateLastRefresh();
}

function switchTab(target) {
  if (!['terminals', 'queue', 'dispatch', 'control', 'logs'].includes(target)) target = 'terminals';
  const isEnteringControl = currentTab !== 'control' && target === 'control';
  const isEnteringLogs = currentTab !== 'logs' && target === 'logs';
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
    sel.innerHTML = '<option value="">所有实例</option>' + insts
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
    sel.innerHTML = '<option value="">所有线索</option>' + threads
      .map((t) => `<option value="${escapeHtml(t.slug)}">${escapeHtml(t.title || t.slug)} · ${escapeHtml(t.projectName || '?')}</option>`)
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
    el('#logs-list').innerHTML = `<div class="logs-empty">加载失败: ${escapeHtml(e.message)}</div>`;
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
  el('#logs-count').textContent = `${rows.length} 条${search ? ' (搜索后)' : ''} · ${LOG_STATE.rows.length} 总缓存`;
  if (!rows.length) {
    listEl.innerHTML = `<div class="logs-empty">无匹配事件</div>`;
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
  const preview = payloadStr.length > 8000 ? payloadStr.slice(0, 8000) + `\n... (+${payloadStr.length - 8000} 字符)` : payloadStr;
  return `
    <details class="logs-row logs-et-${escapeHtml(etCls)}">
      <summary>
        <span class="logs-ts">${tsStr}</span>
        <span class="logs-inst" title="${escapeHtml(m.instanceId || '')}">${escapeHtml((m.instanceId || '').replace(/^mate-/, ''))}</span>
        <span class="logs-et">${escapeHtml(m.eventType || '')}</span>
        <span class="logs-thread">${escapeHtml(m.threadSlug || (m.directTarget ? '→direct' : '-'))}</span>
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
    return '(empty assistant)';
  }
  if (m.eventType === 'user') {
    const content = p.message?.content || [];
    const trs = Array.isArray(content) ? content.filter((c) => c.type === 'tool_result') : [];
    if (trs.length) return `↩ tool_result × ${trs.length}${trs.some((tr) => tr.is_error) ? ' (含 ERROR)' : ''}`;
    const t = Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join(' ') : (typeof content === 'string' ? content : '');
    return t.length > 100 ? t.slice(0, 100) + '…' : (t || '(empty user)');
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
    el('#logs-count').textContent = `${LOG_STATE.rows.length} 条 · 实时`;
    if (wasAtTop) listEl.scrollTop = 0;
  });
}

// ============================== Bootstrap ==============================

(function init() {
  wireUI();
  wireMatetermUI();
  switchTab(tabFromHash());
  startAutoRefresh();
  setupMatetermWS();
  // [需求@2026-06-12 Phase 2E §14] dashboard 顶栏挂 chip — 全局视图(projectId=null)
  if (window.RuntimeChip) window.RuntimeChip.init({ projectId: null });
  // 首次 tab=control 时也要初始化下拉
  if (currentTab === 'control') refreshControl();
  // 首次 tab=logs 时也要初始化
  if (currentTab === 'logs') initLogStreamTab();
})();
