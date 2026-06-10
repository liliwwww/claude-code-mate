// [需求@2026-06-10] Phase 2B 前端:线索看板为主视图
//   - 左侧:project 内所有 thread(slug + stage + bound R 状态)
//   - 右侧:焦点 thread 的对话流(按 thread_slug 加载历史,而非 instance_id)
//   - 顶栏:project 切换器 + "+ 新线索" 按钮(无 spawn dropdown)
//   - 发送 = POST /api/threads/<slug>/message → backend 懒 spawn R + bind + 转发

const state = {
  projects: [],
  activeProjectId: null,
  roles: [],
  threads: new Map(),       // slug -> thread snapshot
  instances: new Map(),     // id -> instance snapshot (for tracking bound R status)
  focusedSlug: null,
  streamingAssistants: new Map(), // threadSlug -> streaming msg accumulator
};

const el = (sel) => document.querySelector(sel);
const els = {
  banners: el('#banners'),
  projectPicker: el('#project-picker'),
  addProjectBtn: el('#add-project-btn'),
  addProjectDialog: el('#add-project-dialog'),
  apName: el('#ap-name'),
  apRoot: el('#ap-root'),
  apInspect: el('#ap-inspect'),
  apCancel: el('#ap-cancel'),
  apForm: el('#add-project-form'),
  apError: el('#ap-error'),
  newThreadBtn: el('#new-thread-btn'),
  newThreadDialog: el('#new-thread-dialog'),
  ntSlug: el('#nt-slug'),
  ntTitle: el('#nt-title'),
  ntCancel: el('#nt-cancel'),
  ntForm: el('#new-thread-form'),
  ntError: el('#nt-error'),
  threadsList: el('#threads'),
  threadEmpty: el('#thread-empty'),
  convTitle: el('#conv-title'),
  stagePicker: el('#stage-picker'),
  stream: el('#stream'),
  msgInput: el('#msg-input'),
  sendForm: el('#send-form'),
  sendBtn: el('#send-btn'),
};

const LS_KEY = 'mate.activeProjectId';
const LS_FOCUSED_THREAD = 'mate.focusedThread';

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    method: opts.method || 'GET',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.error || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

// ---------------- Bootstrap ----------------
async function init() {
  const sys = await api('/system');
  renderBanners(sys);

  state.projects = await api('/projects');
  const savedId = parseInt(localStorage.getItem(LS_KEY), 10);
  state.activeProjectId = state.projects.some((p) => p.id === savedId) ? savedId : sys.defaultProjectId;
  renderProjectPicker();

  state.roles = await api('/roles');

  await reloadProjectScopedData();

  connectWs();
  wireInputs();
}

async function reloadProjectScopedData() {
  state.threads.clear();
  state.instances.clear();
  state.focusedSlug = null;
  if (!state.activeProjectId) {
    renderThreads();
    renderConvHeader();
    return;
  }
  const [threads, instances] = await Promise.all([
    api(`/threads?projectId=${state.activeProjectId}`),
    api(`/instances?projectId=${state.activeProjectId}`),
  ]);
  for (const t of threads) state.threads.set(t.slug, t);
  for (const i of instances) state.instances.set(i.id, i);
  renderThreads();

  // restore focus if possible
  const savedSlug = localStorage.getItem(`${LS_FOCUSED_THREAD}.${state.activeProjectId}`);
  if (savedSlug && state.threads.has(savedSlug)) {
    focusThread(savedSlug);
  } else {
    renderConvHeader();
    els.stream.innerHTML = '';
  }
}

function renderBanners(sys) {
  els.banners.innerHTML = '';
  const b = document.createElement('span');
  b.className = 'banner warn';
  b.style.background = '#1f3a1f';
  b.style.color = '#88dd88';
  b.textContent = `proxy: ${sys.httpProxy ? 'OK' : 'unset'}`;
  els.banners.appendChild(b);
  for (const w of sys.warnings || []) {
    const wb = document.createElement('span');
    wb.className = 'banner';
    wb.textContent = w;
    els.banners.appendChild(wb);
  }
}

function renderProjectPicker() {
  els.projectPicker.innerHTML = '';
  for (const p of state.projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === state.activeProjectId) opt.selected = true;
    els.projectPicker.appendChild(opt);
  }
}

// [需求@2026-06-10] 线索看板渲染
function renderThreads() {
  els.threadsList.innerHTML = '';
  const sorted = [...state.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  if (sorted.length === 0) {
    els.threadEmpty.hidden = false;
  } else {
    els.threadEmpty.hidden = true;
  }
  for (const t of sorted) {
    const li = document.createElement('li');
    li.dataset.slug = t.slug;
    if (t.slug === state.focusedSlug) li.classList.add('active');

    // bound R instance status
    const boundRId = t.metadata?.current_role_instances?.requirements;
    const boundR = boundRId ? state.instances.get(boundRId) : null;
    const instState = boundR ? boundR.status : 'no instance';

    li.innerHTML = `
      <div class="slug">${escapeHtml(t.slug)}</div>
      <div class="title">${escapeHtml(t.title || '')}</div>
      <div class="stage-row">
        <span class="stage ${t.stage}">${t.stage}</span>
        <span class="inst-state">R: ${instState}</span>
      </div>
    `;
    li.addEventListener('click', () => focusThread(t.slug));
    els.threadsList.appendChild(li);
  }
}

function renderConvHeader() {
  const t = state.focusedSlug ? state.threads.get(state.focusedSlug) : null;
  if (!t) {
    els.convTitle.textContent = '选一条线索开始';
    els.stagePicker.hidden = true;
    els.sendBtn.disabled = true;
    return;
  }
  els.convTitle.textContent = `${t.slug} · ${t.title || ''}`.trim();
  els.stagePicker.hidden = false;
  els.stagePicker.value = t.stage;
  els.sendBtn.disabled = false;
}

async function focusThread(slug) {
  state.focusedSlug = slug;
  localStorage.setItem(`${LS_FOCUSED_THREAD}.${state.activeProjectId}`, slug);
  renderThreads();
  renderConvHeader();
  els.stream.innerHTML = '';
  state.streamingAssistants.delete(slug);
  await loadThreadHistory(slug);
}

async function loadThreadHistory(slug) {
  try {
    const msgs = await api(`/threads/${encodeURIComponent(slug)}/history?projectId=${state.activeProjectId}&limit=500`);
    for (const m of msgs) renderEventInStream(m.eventType, m.payload, false);
    els.stream.scrollTop = els.stream.scrollHeight;
  } catch (e) {
    console.error('history load failed:', e);
  }
}

function makeMsg(cls, role, text) {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.innerHTML = `<div class="role">${role}</div><div class="body"></div>`;
  div.querySelector('.body').textContent = text;
  return div;
}

function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderEventInStream(eventType, raw, autoscroll = true) {
  let node = null;
  if (eventType === 'system/init') {
    node = makeMsg('system', 'system / init', `session: ${raw.session_id} · model: ${raw.model}`);
  } else if (eventType === 'system/api_retry') {
    node = makeMsg('system', 'system / api_retry', JSON.stringify(raw).slice(0, 300));
  } else if (eventType === 'rate_limit_event') {
    node = makeMsg('system', 'rate_limit', JSON.stringify(raw.rate_limit_info || raw).slice(0, 300));
  } else if (eventType === 'user') {
    const txt = userEventToText(raw);
    if (txt) node = makeMsg('user', 'user', txt);
  } else if (eventType === 'assistant') {
    const text = (raw.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const tools = (raw.message?.content || []).filter((c) => c.type === 'tool_use');
    if (text) {
      const existing = state.streamingAssistants.get(state.focusedSlug);
      if (existing && existing.el && existing.el.isConnected) {
        existing.el.querySelector('.body').textContent = text;
        existing.el.classList.remove('streaming');
        state.streamingAssistants.delete(state.focusedSlug);
        node = null;
      } else {
        node = makeMsg('assistant', 'assistant', text);
      }
    }
    for (const t of tools) {
      const tnode = makeMsg('tool_use', `tool_use: ${t.name}`, JSON.stringify(t.input || {}, null, 2));
      els.stream.appendChild(tnode);
    }
  } else if (eventType === 'stream_event') {
    const sub = raw.event;
    if (sub?.type === 'content_block_delta' && sub.delta?.type === 'text_delta') {
      let s = state.streamingAssistants.get(state.focusedSlug);
      if (!s) {
        const elNode = makeMsg('assistant streaming', 'assistant…', '');
        els.stream.appendChild(elNode);
        s = { text: '', el: elNode };
        state.streamingAssistants.set(state.focusedSlug, s);
      }
      s.text += sub.delta.text;
      s.el.querySelector('.body').textContent = s.text;
    }
  } else if (eventType === 'result') {
    const ok = raw.is_error !== true;
    node = makeMsg(ok ? 'result_ok' : 'error',
      ok ? 'result · success' : 'result · ERROR',
      ok
        ? `cost $${raw.total_cost_usd?.toFixed?.(4) ?? '?'} · ${raw.duration_ms ?? '?'}ms · turns ${raw.num_turns}`
        : `api_error_status=${raw.api_error_status} · ${raw.result || ''}`);
    state.streamingAssistants.delete(state.focusedSlug);
  }
  if (node) els.stream.appendChild(node);
  if (autoscroll) els.stream.scrollTop = els.stream.scrollHeight;
}

function userEventToText(raw) {
  const content = raw.message?.content;
  if (Array.isArray(content)) {
    const txt = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    if (txt) return txt;
    const trs = content.filter((c) => c.type === 'tool_result');
    if (trs.length) {
      return trs.map((tr) => {
        const t = typeof tr.content === 'string' ? tr.content
                : Array.isArray(tr.content) ? tr.content.map((x) => x.text || '').join('')
                : JSON.stringify(tr.content);
        return `[tool_result${tr.is_error ? ' ERROR' : ''}] ${t}`;
      }).join('\n');
    }
  } else if (typeof content === 'string') {
    return content;
  }
  return null;
}

// ---------------- WebSocket ----------------
function connectWs() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleWsMsg(msg);
  };
  ws.onclose = () => setTimeout(connectWs, 1000);
  ws.onerror = (e) => console.warn('ws error:', e);
}

function handleWsMsg({ type, payload }) {
  // Filter by project
  if (type === 'instance.spawned' || type === 'instance.status_change') {
    const inst = payload.instance || payload;
    if (inst.projectId !== state.activeProjectId) return;
    state.instances.set(inst.id, inst);
    // Re-render threads so bound R status updates
    renderThreads();
  } else if (type === 'instance.exited') {
    const inst = payload.instance;
    if (inst.projectId !== state.activeProjectId) return;
    state.instances.set(inst.id, inst);
    renderThreads();
  } else if (type === 'instance.event') {
    if (payload.projectId !== state.activeProjectId) return;
    if (payload.threadSlug === state.focusedSlug) {
      renderEventInStream(payload.eventType, payload.raw, true);
    }
  }
}

// ---------------- Input wiring ----------------
function wireInputs() {
  els.projectPicker.addEventListener('change', async () => {
    const newId = parseInt(els.projectPicker.value, 10);
    if (newId === state.activeProjectId) return;
    state.activeProjectId = newId;
    localStorage.setItem(LS_KEY, String(newId));
    await reloadProjectScopedData();
  });

  // Add project dialog
  els.addProjectBtn.addEventListener('click', () => {
    els.apName.value = '';
    els.apRoot.value = '';
    els.apInspect.textContent = '';
    els.apError.textContent = '';
    els.addProjectDialog.showModal();
    els.apName.focus();
  });
  els.apCancel.addEventListener('click', () => els.addProjectDialog.close());
  els.apRoot.addEventListener('blur', async () => {
    const v = els.apRoot.value.trim();
    if (!v) { els.apInspect.textContent = ''; return; }
    try {
      const info = await api(`/projects/inspect?path=${encodeURIComponent(v)}`);
      if (!info.exists) els.apInspect.textContent = '目录不存在';
      else if (!info.isDirectory) els.apInspect.textContent = '路径不是目录';
      else {
        const tags = [];
        if (info.hasClaude) tags.push('.claude/');
        if (info.hasGit) tags.push('git');
        if (info.hasPackageJson) tags.push('package.json');
        if (info.hasClaudeMd) tags.push('CLAUDE.md');
        els.apInspect.textContent = tags.length ? `识别到: ${tags.join(', ')}` : '(空目录或无 .claude/.git 等标志)';
      }
    } catch (e) {
      els.apInspect.textContent = `inspect 失败: ${e.message}`;
    }
  });
  els.apForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    els.apError.textContent = '';
    try {
      const proj = await api('/projects', {
        method: 'POST',
        body: { name: els.apName.value.trim(), rootDir: els.apRoot.value.trim() },
      });
      state.projects.push(proj);
      state.activeProjectId = proj.id;
      localStorage.setItem(LS_KEY, String(proj.id));
      renderProjectPicker();
      await reloadProjectScopedData();
      els.addProjectDialog.close();
    } catch (e) {
      els.apError.textContent = e.message;
    }
  });

  // [需求@2026-06-10] 新线索对话框
  els.newThreadBtn.addEventListener('click', () => {
    if (!state.activeProjectId) { alert('先选个 project'); return; }
    els.ntSlug.value = '';
    els.ntTitle.value = '';
    els.ntError.textContent = '';
    els.newThreadDialog.showModal();
    els.ntSlug.focus();
  });
  els.ntCancel.addEventListener('click', () => els.newThreadDialog.close());
  els.ntForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    els.ntError.textContent = '';
    const slug = els.ntSlug.value.trim();
    const title = els.ntTitle.value.trim();
    if (!slug) { els.ntError.textContent = 'slug 必填'; return; }
    try {
      const t = await api(`/threads?projectId=${state.activeProjectId}`, {
        method: 'POST', body: { slug, title: title || undefined },
      });
      state.threads.set(t.slug, t);
      renderThreads();
      els.newThreadDialog.close();
      focusThread(t.slug);
      els.msgInput.focus();
    } catch (e) {
      els.ntError.textContent = e.message;
    }
  });

  // Stage picker (focused thread)
  els.stagePicker.addEventListener('change', async () => {
    if (!state.focusedSlug) return;
    const newStage = els.stagePicker.value;
    try {
      const updated = await api(`/threads/${encodeURIComponent(state.focusedSlug)}?projectId=${state.activeProjectId}`, {
        method: 'PATCH', body: { stage: newStage },
      });
      state.threads.set(updated.slug, updated);
      renderThreads();
      renderConvHeader();
    } catch (e) {
      alert('stage 切换失败: ' + e.message);
    }
  });

  // Send: thread-centric route
  els.sendForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!state.focusedSlug) return;
    const text = els.msgInput.value.trim();
    if (!text) return;
    try {
      await api(`/threads/${encodeURIComponent(state.focusedSlug)}/message?projectId=${state.activeProjectId}`, {
        method: 'POST', body: { text },
      });
      els.msgInput.value = '';
      // Refresh thread snapshot to pick up new binding if just lazy-spawned
      const t = await api(`/threads/${encodeURIComponent(state.focusedSlug)}?projectId=${state.activeProjectId}`);
      state.threads.set(t.slug, t);
      renderThreads();
    } catch (e) {
      alert(`发送失败: ${e.message}`);
    }
  });

  els.msgInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      els.sendForm.requestSubmit();
    }
  });
}

init().catch((e) => {
  console.error('init failed:', e);
  document.body.innerHTML = `<div style="padding:40px;color:#f88">init failed: ${e.message}</div>`;
});
