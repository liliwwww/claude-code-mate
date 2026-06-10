// [需求@2026-06-10] Phase 2C 前端
//   - §1.5 Markdown 渲染 (marked + highlight.js + KaTeX,assistant 输出)
//   - §1.3 亮/暗主题切换(默认 prefers-color-scheme,手动 override 后 localStorage 锁定)
//   - §1.1 环境检测按钮(手动触发,失败不阻塞)
//   - §1.4 新线索 dialog 砍掉 slug 字段
//
// Phase 2B 沿用:
//   - 线索看板为主视图
//   - 懒 spawn(后端 sendToThread)
//   - 焦点线索 localStorage 持久化

const state = {
  projects: [],
  activeProjectId: null,
  roles: [],
  threads: new Map(),
  instances: new Map(),
  focusedSlug: null,
  streamingAssistants: new Map(),
  theme: 'dark',  // 'dark' | 'light',  initialized in initTheme()
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
  themeBtn: el('#theme-btn'),
  healthcheckBtn: el('#healthcheck-btn'),
  hcDialog: el('#healthcheck-dialog'),
  hcResults: el('#hc-results'),
  hcRun: el('#hc-run'),
  newThreadBtn: el('#new-thread-btn'),
  newThreadDialog: el('#new-thread-dialog'),
  ntTitle: el('#nt-title'),
  ntCancel: el('#nt-cancel'),
  ntForm: el('#new-thread-form'),
  ntError: el('#nt-error'),
  hljsThemeLink: el('#hljs-theme-link'),
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
const LS_THEME = 'mate.theme';  // 'dark' | 'light' | null (null = follow system)

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

// ---------------- Theme management (§1.3) ----------------
function initTheme() {
  const saved = localStorage.getItem(LS_THEME);
  if (saved === 'dark' || saved === 'light') {
    state.theme = saved;
  } else {
    // [需求@2026-06-10 §1.3] 默认跟随系统
    state.theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  applyTheme();
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  els.themeBtn.textContent = state.theme === 'dark' ? '🌙' : '☀️';
  // [需求@2026-06-10 §1.5] 同步 highlight.js 主题
  if (els.hljsThemeLink) {
    els.hljsThemeLink.href = state.theme === 'dark'
      ? 'https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/styles/github-dark.min.css'
      : 'https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/styles/github.min.css';
  }
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  // [需求@2026-06-10 §1.3] 手动 override 后 localStorage 锁定
  localStorage.setItem(LS_THEME, state.theme);
  applyTheme();
}

// ---------------- Markdown rendering (§1.5) ----------------
function configureMarked() {
  if (typeof marked === 'undefined') return;

  // Custom renderer for code blocks with copy button + highlight.js + KaTeX
  const renderer = new marked.Renderer();
  const origCode = renderer.code.bind(renderer);
  renderer.code = function (code, lang) {
    let body;
    if (lang && window.hljs && hljs.getLanguage(lang)) {
      try {
        body = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        body = origCode(code, lang);
      }
    } else if (window.hljs) {
      try { body = hljs.highlightAuto(code).value; } catch { body = escapeHtml(code); }
    } else {
      body = escapeHtml(code);
    }
    const langTag = lang ? ` class="language-${lang} hljs"` : ' class="hljs"';
    return `<pre><code${langTag}>${body}</code><button class="copy-btn" data-code="${escapeAttr(code)}">copy</button></pre>`;
  };

  marked.setOptions({
    renderer,
    breaks: true,
    gfm: true,
  });
}

function renderMarkdown(text) {
  if (typeof marked === 'undefined') return escapeHtml(text);
  let html = marked.parse(text || '');
  // [需求@2026-06-10 §1.5] KaTeX inline ($...$) + block ($$...$$)
  if (window.katex) {
    html = html.replace(/\$\$([^\$]+?)\$\$/g, (_, expr) => {
      try {
        return katex.renderToString(expr.trim(), { displayMode: true, throwOnError: false });
      } catch { return _; }
    });
    html = html.replace(/\$([^\$\n]+?)\$/g, (_, expr) => {
      try {
        return katex.renderToString(expr.trim(), { displayMode: false, throwOnError: false });
      } catch { return _; }
    });
  }
  return html;
}

function attachCopyHandlers(scope) {
  scope.querySelectorAll('.copy-btn').forEach((btn) => {
    if (btn._wired) return;
    btn._wired = true;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const code = (btn.dataset.code || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      navigator.clipboard.writeText(code).then(() => {
        const orig = btn.textContent;
        btn.textContent = '✓ copied';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = orig;
          btn.classList.remove('copied');
        }, 1200);
      });
    });
  });
}

function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- Bootstrap ----------------
async function init() {
  initTheme();
  configureMarked();

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

// [需求@2026-06-10 §3] 计算线索看板的状态灯
function computeStateLight(thread) {
  const meta = thread.metadata || {};
  if (meta.blocked) return 'yellow-blink';

  const roleTypes = ['requirements', 'orchestrator', 'executor', 'validator'];
  const bound = roleTypes
    .map((rt) => meta.current_role_instances?.[rt])
    .filter(Boolean);
  const instances = bound.map((id) => state.instances.get(id)).filter(Boolean);
  if (!instances.length) return 'gray';
  if (instances.some((i) => i.status === 'dead')) return 'red';
  if (instances.some((i) => i.status === 'busy' || i.status === 'spawning')) return 'green';
  return 'gray';
}

function renderThreads() {
  els.threadsList.innerHTML = '';
  const sorted = [...state.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  els.threadEmpty.hidden = sorted.length > 0;
  for (const t of sorted) {
    const li = document.createElement('li');
    li.dataset.slug = t.slug;
    if (t.slug === state.focusedSlug) li.classList.add('active');
    if (t.metadata?.blocked) li.classList.add('blocked-thread');

    const light = computeStateLight(t);
    const blockedText = t.metadata?.blocked?.question
      ? ` · 等待: ${escapeHtml(String(t.metadata.blocked.question).slice(0, 60))}`
      : '';

    li.innerHTML = `
      <div class="slug">
        <span class="light ${light}"></span>
        ${escapeHtml(t.title || t.slug)}
      </div>
      <div class="title">${escapeHtml(t.slug)}${blockedText}</div>
      <div class="stage-row">
        <span class="stage ${t.stage}">${t.stage}</span>
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
  els.convTitle.textContent = `${t.title || t.slug}`;
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

function makeMsg(cls, role, text, asMarkdown = false) {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.innerHTML = `<div class="role">${role}</div><div class="body"></div>`;
  const body = div.querySelector('.body');
  if (asMarkdown) {
    body.innerHTML = renderMarkdown(text);
    attachCopyHandlers(body);
  } else {
    body.textContent = text;
  }
  return div;
}

function renderEventInStream(eventType, raw, autoscroll = true) {
  let node = null;
  if (eventType === 'system/init') {
    node = makeMsg('system', 'system / init', `session: ${raw.session_id} · model: ${raw.model}`);
  } else if (eventType === 'system/api_retry') {
    node = makeMsg('system', 'system / api_retry', JSON.stringify(raw).slice(0, 300));
  } else if (eventType === 'rate_limit_event') {
    // skip — noise
    return;
  } else if (eventType === 'user') {
    const txt = userEventToText(raw);
    if (txt) node = makeMsg('user', 'user', txt);
  } else if (eventType === 'assistant') {
    const text = (raw.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const tools = (raw.message?.content || []).filter((c) => c.type === 'tool_use');
    if (text) {
      const existing = state.streamingAssistants.get(state.focusedSlug);
      if (existing && existing.el && existing.el.isConnected) {
        // [需求@2026-06-10 §1.5] 流式完成后用 markdown 渲染替换
        const body = existing.el.querySelector('.body');
        body.innerHTML = renderMarkdown(text);
        attachCopyHandlers(body);
        existing.el.classList.remove('streaming');
        state.streamingAssistants.delete(state.focusedSlug);
        node = null;
      } else {
        node = makeMsg('assistant', 'assistant', text, /* asMarkdown */ true);
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
      // [需求@2026-06-10 §1.5] 流式期间用纯文本(快速渲染),完成后才 markdown
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

// ---------------- Environment check (§1.1) ----------------
async function runHealthcheck() {
  els.hcRun.disabled = true;
  els.hcResults.innerHTML = '<div class="muted">检测中,请稍候...</div>';
  try {
    const result = await api('/system/healthcheck', { method: 'POST' });
    renderHealthcheck(result);
  } catch (e) {
    els.hcResults.innerHTML = `<div class="error">检测调用失败: ${escapeHtml(e.message)}</div>`;
  } finally {
    els.hcRun.disabled = false;
  }
}

function renderHealthcheck(result) {
  const rows = [
    `<div class="muted" style="margin-bottom: 8px;">${escapeHtml(result.summary)} · 共 ${result.checks.length} 项</div>`,
  ];
  for (const c of result.checks) {
    const cls = c.ok ? 'ok' : 'fail';
    const ico = c.ok ? '✓' : '✗';
    const detail = c.ok ? (c.detail || 'OK') : (c.error || 'failed');
    rows.push(`
      <div class="hc-row ${cls}">
        <div class="ico">${ico}</div>
        <div class="name">${escapeHtml(c.name)}</div>
        <div class="detail">${escapeHtml(String(detail))} <small>(${c.durationMs}ms)</small></div>
      </div>
    `);
  }
  els.hcResults.innerHTML = rows.join('');
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
  if (type === 'instance.spawned' || type === 'instance.status_change') {
    const inst = payload.instance || payload;
    if (inst.projectId !== state.activeProjectId) return;
    state.instances.set(inst.id, inst);
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
  } else if (type === 'thread.title_updated') {
    // [需求@2026-06-10 §1.4] SystemAgent 自动摘要的标题回灌
    if (payload.projectId !== state.activeProjectId) return;
    state.threads.set(payload.threadSlug, payload.thread);
    renderThreads();
    if (payload.threadSlug === state.focusedSlug) renderConvHeader();
  } else if (type === 'thread.suggested_reply') {
    // [需求@2026-06-10 §1.6] SystemAgent 生成的回答模板,预填输入框(空才填)
    if (payload.projectId !== state.activeProjectId) return;
    if (payload.threadSlug !== state.focusedSlug) return;
    if (els.msgInput.value.trim()) return;
    els.msgInput.value = payload.template;
    els.msgInput.placeholder = '系统建议的回答模板(可改可删,Ctrl+Enter 发送)';
  } else if (type === 'thread.handoff') {
    // [需求@2026-06-10 §6.4] 角色切换:对话流加一条隐式分割条(small system msg)
    if (payload.projectId !== state.activeProjectId) return;
    if (payload.threadSlug === state.focusedSlug) {
      const node = makeMsg('system handoff-card', `→ ${payload.target}`,
        `${payload.reason || ''}`);
      els.stream.appendChild(node);
      els.stream.scrollTop = els.stream.scrollHeight;
    }
    // Refresh thread snapshot to get new stage
    api(`/threads/${encodeURIComponent(payload.threadSlug)}?projectId=${state.activeProjectId}`)
      .then((t) => { state.threads.set(t.slug, t); renderThreads(); if (t.slug === state.focusedSlug) renderConvHeader(); })
      .catch(() => {});
  } else if (type === 'thread.done') {
    // [需求@2026-06-10 §6] 自验完成 = verified = IDLE,user 视角:线索后台干完了
    if (payload.projectId !== state.activeProjectId) return;
    if (payload.threadSlug === state.focusedSlug) {
      const node = makeMsg('system done-card', '✓ 线索完成', payload.summary || '后台自验通过');
      els.stream.appendChild(node);
      els.stream.scrollTop = els.stream.scrollHeight;
    }
    state.threads.set(payload.threadSlug, payload.thread);
    renderThreads();
  } else if (type === 'thread.blocked') {
    // [需求@2026-06-10 §6.2] BLOCKED → 线索看板黄灯闪烁 + 对话流卡片
    if (payload.projectId !== state.activeProjectId) return;
    if (payload.threadSlug === state.focusedSlug) {
      const node = makeMsg('blocked-card', `⚠️ 需要你拍板 (${payload.raisedBy})`,
        payload.question);
      els.stream.appendChild(node);
      els.stream.scrollTop = els.stream.scrollHeight;
    }
    state.threads.set(payload.threadSlug, payload.thread);
    renderThreads();
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
        els.apInspect.textContent = tags.length ? `识别到: ${tags.join(', ')}` : '(空目录)';
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

  // [需求@2026-06-10 §1.3] Theme toggle
  els.themeBtn.addEventListener('click', toggleTheme);

  // [需求@2026-06-10 §1.1] Healthcheck
  els.healthcheckBtn.addEventListener('click', () => {
    els.hcResults.innerHTML = '<div class="muted">点击下方"开始检测"...</div>';
    els.hcDialog.showModal();
  });
  els.hcRun.addEventListener('click', runHealthcheck);

  // [需求@2026-06-10 §1.4] 新线索 dialog(slug 由 backend 自动生成)
  els.newThreadBtn.addEventListener('click', () => {
    if (!state.activeProjectId) { alert('先选个 project'); return; }
    els.ntTitle.value = '';
    els.ntError.textContent = '';
    els.newThreadDialog.showModal();
    els.ntTitle.focus();
  });
  els.ntCancel.addEventListener('click', () => els.newThreadDialog.close());
  els.ntForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    els.ntError.textContent = '';
    const title = els.ntTitle.value.trim();
    try {
      const t = await api(`/threads?projectId=${state.activeProjectId}`, {
        method: 'POST', body: { title: title || undefined },
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
