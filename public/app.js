// [需求@2026-06-10] Phase 2A frontend:
//   - 顶栏 project 切换器(选当前 active project,localStorage 持久化)
//   - 所有 /api/instances 调用带 ?projectId=N 参数
//   - 添加 / 导入项目对话框
//
// Layout: 顶栏 [project] + [roles] + actions, 左实例列表 + 右对话流 + 底部输入框

const state = {
  projects: [],
  activeProjectId: null,
  roles: [],
  instances: new Map(),
  focusedId: null,
  streamingAssistants: new Map(),
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
  apSubmit: el('#ap-submit'),
  apError: el('#ap-error'),
  apForm: el('#add-project-form'),
  rolePicker: el('#role-picker'),
  spawnBtn: el('#spawn-btn'),
  instances: el('#instances'),
  convTitle: el('#conv-title'),
  killBtn: el('#kill-btn'),
  stream: el('#stream'),
  msgInput: el('#msg-input'),
  sendForm: el('#send-form'),
};

const LS_KEY = 'mate.activeProjectId';

// ---------------- API helpers ----------------
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
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

  // [需求@2026-06-10] load projects + 决定 active project
  state.projects = await api('/projects');
  const savedId = parseInt(localStorage.getItem(LS_KEY), 10);
  state.activeProjectId = state.projects.some((p) => p.id === savedId) ? savedId : sys.defaultProjectId;
  renderProjectPicker();

  state.roles = await api('/roles');
  renderRolePicker();

  await reloadInstancesForActiveProject();

  connectWs();
  wireInputs();
}

async function reloadInstancesForActiveProject() {
  state.instances.clear();
  state.focusedId = null;
  if (!state.activeProjectId) {
    renderInstances();
    return;
  }
  const instances = await api(`/instances?projectId=${state.activeProjectId}`);
  for (const inst of instances) state.instances.set(inst.id, inst);
  renderInstances();
  els.convTitle.textContent = 'Select an instance';
  els.killBtn.hidden = true;
  els.stream.innerHTML = '';
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

function renderBanners(sys) {
  els.banners.innerHTML = '';
  for (const w of sys.warnings || []) {
    const b = document.createElement('span');
    b.className = 'banner';
    b.textContent = w;
    els.banners.appendChild(b);
  }
  if (!sys.warnings?.length) {
    const b = document.createElement('span');
    b.className = 'banner warn';
    b.style.background = '#1f3a1f'; b.style.color = '#88dd88';
    b.textContent = `proxy: ${sys.httpProxy ? 'OK' : 'unset'}`;
    els.banners.appendChild(b);
  }
}

function renderRolePicker() {
  els.rolePicker.innerHTML = '';
  for (const r of state.roles) {
    const opt = document.createElement('option');
    opt.value = r.name;
    opt.textContent = `${r.name} (${r.type})`;
    if (r.isCentral) opt.textContent += ' ★';
    els.rolePicker.appendChild(opt);
  }
}

function renderInstances() {
  els.instances.innerHTML = '';
  const sorted = [...state.instances.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const inst of sorted) {
    const li = document.createElement('li');
    li.dataset.id = inst.id;
    if (inst.id === state.focusedId) li.classList.add('active');
    if (inst.status === 'disconnected') li.classList.add('disconnected');
    const color = inst.displayColor || '#888';
    const metaExtras = inst.status === 'disconnected'
      ? `<span title="${new Date(inst.lastActiveAt).toLocaleString()}">last seen ${relTime(inst.lastActiveAt)}</span>`
      : `<span>pid ${inst.pid ?? '?'}</span>`;
    li.innerHTML = `
      <div class="iid" style="color:${color}">${inst.id}</div>
      <div class="meta">
        <span class="status ${inst.status}">${inst.status}</span>
        ${metaExtras}
      </div>
    `;
    li.addEventListener('click', () => focusInstance(inst.id));
    els.instances.appendChild(li);
  }
}

function relTime(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function focusInstance(id) {
  state.focusedId = id;
  renderInstances();
  const inst = state.instances.get(id);
  els.convTitle.textContent = inst
    ? `${inst.id} · ${inst.roleName} · ${inst.status}`
    : 'Select an instance';
  els.killBtn.hidden = !inst || inst.status === 'dead';
  els.stream.innerHTML = '';
  if (inst) loadHistory(id);
}

async function loadHistory(id) {
  try {
    const msgs = await api(`/instances/${encodeURIComponent(id)}/history?limit=200`);
    for (const m of msgs) renderEventInStream(m.eventType, m.payload, false);
    els.stream.scrollTop = els.stream.scrollHeight;
  } catch (e) {
    console.error('history load failed:', e);
  }
}

// ---------------- Stream rendering ----------------
function makeMsg(cls, role, text) {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.innerHTML = `<div class="role">${role}</div><div class="body"></div>`;
  div.querySelector('.body').textContent = text;
  return div;
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
    const inst = raw.session_id;
    const text = (raw.message?.content || [])
      .filter((c) => c.type === 'text').map((c) => c.text).join('');
    const tools = (raw.message?.content || []).filter((c) => c.type === 'tool_use');
    if (text) {
      // If a streaming partial was built, replace it
      const existing = state.streamingAssistants.get(state.focusedId);
      if (existing && existing.el && existing.el.isConnected) {
        existing.el.querySelector('.body').textContent = text;
        existing.el.classList.remove('streaming');
        state.streamingAssistants.delete(state.focusedId);
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
      // Aggregate into the current streaming assistant message
      let s = state.streamingAssistants.get(state.focusedId);
      if (!s) {
        const elNode = makeMsg('assistant streaming', 'assistant…', '');
        els.stream.appendChild(elNode);
        s = { text: '', el: elNode };
        state.streamingAssistants.set(state.focusedId, s);
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
    state.streamingAssistants.delete(state.focusedId);
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
  // [需求@2026-06-10] 只处理当前 active project 的事件,其它 project 的事件忽略
  if (type === 'instance.spawned' || type === 'instance.status_change') {
    const inst = payload.instance || payload;
    if (inst.projectId !== state.activeProjectId) return;
    state.instances.set(inst.id, inst);
    renderInstances();
    if (inst.id === state.focusedId) {
      els.convTitle.textContent = `${inst.id} · ${inst.roleName} · ${inst.status}`;
      els.killBtn.hidden = inst.status === 'dead';
    }
  } else if (type === 'instance.exited') {
    const inst = payload.instance;
    if (inst.projectId !== state.activeProjectId) return;
    state.instances.set(inst.id, inst);
    renderInstances();
    if (inst.id === state.focusedId) {
      els.killBtn.hidden = true;
      const node = makeMsg('system', 'exited', `code=${payload.code} signal=${payload.signal} error=${payload.error}`);
      els.stream.appendChild(node);
    }
  } else if (type === 'instance.event') {
    if (payload.projectId !== state.activeProjectId) return;
    if (payload.instanceId === state.focusedId) {
      renderEventInStream(payload.eventType, payload.raw, true);
    }
  } else if (type === 'instance.stderr') {
    if (payload.instanceId === state.focusedId) {
      els.stream.appendChild(makeMsg('error', 'stderr', payload.text));
    }
  }
}

// ---------------- Input wiring ----------------
function wireInputs() {
  // [需求@2026-06-10] project 切换
  els.projectPicker.addEventListener('change', async () => {
    const newId = parseInt(els.projectPicker.value, 10);
    if (newId === state.activeProjectId) return;
    state.activeProjectId = newId;
    localStorage.setItem(LS_KEY, String(newId));
    await reloadInstancesForActiveProject();
  });

  // [需求@2026-06-10] 添加项目对话框
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
      if (!info.exists) els.apInspect.textContent = 'directory does not exist';
      else if (!info.isDirectory) els.apInspect.textContent = 'path is not a directory';
      else {
        const tags = [];
        if (info.hasClaude) tags.push('.claude/');
        if (info.hasGit) tags.push('git');
        if (info.hasPackageJson) tags.push('package.json');
        if (info.hasClaudeMd) tags.push('CLAUDE.md');
        els.apInspect.textContent = tags.length ? `found: ${tags.join(', ')}` : '(empty dir or none of: .claude .git package.json CLAUDE.md)';
      }
    } catch (e) {
      els.apInspect.textContent = `inspect failed: ${e.message}`;
    }
  });
  els.apForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    els.apError.textContent = '';
    try {
      const proj = await api('/projects', {
        method: 'POST',
        body: JSON.stringify({ name: els.apName.value.trim(), rootDir: els.apRoot.value.trim() }),
      });
      state.projects.push(proj);
      state.activeProjectId = proj.id;
      localStorage.setItem(LS_KEY, String(proj.id));
      renderProjectPicker();
      await reloadInstancesForActiveProject();
      els.addProjectDialog.close();
    } catch (e) {
      els.apError.textContent = e.message;
    }
  });

  els.spawnBtn.addEventListener('click', async () => {
    const roleName = els.rolePicker.value;
    if (!roleName || !state.activeProjectId) return;
    try {
      await api(`/instances?projectId=${state.activeProjectId}`, {
        method: 'POST', body: JSON.stringify({ roleName }),
      });
    } catch (e) {
      alert(`spawn failed: ${e.message}`);
    }
  });

  els.killBtn.addEventListener('click', async () => {
    if (!state.focusedId) return;
    if (!confirm(`Kill instance ${state.focusedId}?`)) return;
    try {
      await api(`/instances/${encodeURIComponent(state.focusedId)}`, { method: 'DELETE' });
    } catch (e) {
      alert(`kill failed: ${e.message}`);
    }
  });

  els.sendForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = els.msgInput.value.trim();
    if (!text || !state.focusedId) return;
    try {
      await api(`/instances/${encodeURIComponent(state.focusedId)}/message`, {
        method: 'POST', body: JSON.stringify({ text }),
      });
      els.msgInput.value = '';
    } catch (e) {
      alert(`send failed: ${e.message}`);
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
