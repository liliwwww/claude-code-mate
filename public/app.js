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
  // [需求@2026-06-11 §2] 终端管理 modal
  terminalsBtn: el('#terminals-btn'),
  terminalsCount: el('#terminals-count'),
  terminalsDialog: el('#terminals-dialog'),
  terminalsList: el('#terminals-list'),
  termIncludeDead: el('#term-include-dead'),
  termRefresh: el('#term-refresh'),
  // [需求@2026-06-11 §3] 顶栏下方事件流
  tickerEvents: el('#ticker-events'),
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

// [需求@2026-06-11 §3] 事件流配置
const TICKER_MAX = 5;            // 顶栏最多保留 5 条事件
const TICKER_FRESH_MS = 4000;    // 4 秒内的事件高亮

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

  // [需求@2026-06-11 §2] 初始化终端计数
  updateTerminalsCount();

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

// [需求@2026-06-10 §3 + 2026-06-11 §4] 计算线索看板的状态灯
//   2026-06-11 修复:任何 has_pending_question(SystemAgent 识别)都该黄灯闪,
//   不只是 <mate:blocked /> marker。user 看到 R 普通追问也要看到等待信号。
function computeStateLight(thread) {
  const meta = thread.metadata || {};
  if (meta.blocked || meta.has_pending_question) return 'yellow-blink';

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
    // [需求@2026-06-11 §3] 事件流 — spawn 推一条
    if (type === 'instance.spawned') {
      pushTickerEvent('spawn', `+ ${inst.id}  @ ${shortProj(inst.projectId)}`);
      updateTerminalsCount();
    }
    if (inst.projectId !== state.activeProjectId) return;
    state.instances.set(inst.id, inst);
    renderThreads();
  } else if (type === 'instance.exited') {
    const inst = payload.instance;
    // [需求@2026-06-11 §3] 事件流 — kill/exit 推一条
    pushTickerEvent('kill', `× ${inst.id}  (${payload.code !== null ? 'rc=' + payload.code : payload.signal || 'killed'})`);
    updateTerminalsCount();
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
    // [需求@2026-06-11 §1] 列出 SystemAgent 识别的所有问题,留答案空白
    //   格式: Q1: <问题>\n答:\n\nQ2: <问题>\n答:\n
    //   空才填,有 user 输入不覆盖
    if (payload.projectId !== state.activeProjectId) return;
    if (payload.threadSlug !== state.focusedSlug) return;
    if (els.msgInput.value.trim()) return;
    const questions = payload.questions || [];
    if (!questions.length) return;
    const text = questions
      .map((q, i) => `Q${i + 1}: ${q}\n答:`)
      .join('\n\n') + '\n';
    els.msgInput.value = text;
    els.msgInput.placeholder = `${questions.length} 个待回答问题 — 在每个"答:"后填写,Ctrl+Enter 发送`;
    // Focus the input box (so user can start typing immediately)
    els.msgInput.focus();
  } else if (type === 'thread.metadata_updated') {
    // [需求@2026-06-11 §4] 线索 metadata 变化(pending_question 翻转)→ 重算黄灯
    if (payload.projectId !== state.activeProjectId) return;
    state.threads.set(payload.threadSlug, payload.thread);
    renderThreads();
  } else if (type === 'thread.handoff') {
    // [需求@2026-06-10 §6.4] 角色切换:对话流加一条隐式分割条(small system msg)
    pushTickerEvent('handoff', `${payload.from} → ${payload.target}  ${payload.reason ? '· ' + payload.reason.slice(0, 30) : ''}`);
    if (payload.projectId !== state.activeProjectId) return;
    if (payload.threadSlug === state.focusedSlug) {
      const node = makeMsg('system handoff-card', `→ ${payload.target}`,
        `${payload.reason || ''}`);
      els.stream.appendChild(node);
      els.stream.scrollTop = els.stream.scrollHeight;
    }
    api(`/threads/${encodeURIComponent(payload.threadSlug)}?projectId=${state.activeProjectId}`)
      .then((t) => { state.threads.set(t.slug, t); renderThreads(); if (t.slug === state.focusedSlug) renderConvHeader(); })
      .catch(() => {});
  } else if (type === 'thread.done') {
    pushTickerEvent('done', `✓ ${payload.threadSlug} verified`);
    if (payload.projectId !== state.activeProjectId) return;
    if (payload.threadSlug === state.focusedSlug) {
      const node = makeMsg('system done-card', '✓ 线索完成', payload.summary || '后台自验通过');
      els.stream.appendChild(node);
      els.stream.scrollTop = els.stream.scrollHeight;
    }
    state.threads.set(payload.threadSlug, payload.thread);
    renderThreads();
  } else if (type === 'thread.blocked') {
    pushTickerEvent('blocked', `⚠ ${payload.threadSlug}: ${String(payload.question).slice(0, 40)}`);
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

// [需求@2026-06-11 §3] 顶栏事件流
function pushTickerEvent(kind, text) {
  const node = document.createElement('div');
  node.className = `ticker-event kind-${kind} fresh`;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  node.innerHTML = `<span class="ts">${hh}:${mm}:${ss}</span> ${escapeHtml(text)}`;
  els.tickerEvents.insertBefore(node, els.tickerEvents.firstChild);
  // Cap length
  while (els.tickerEvents.children.length > TICKER_MAX) {
    els.tickerEvents.lastChild.remove();
  }
  // Defresh after TICKER_FRESH_MS
  setTimeout(() => node.classList.remove('fresh'), TICKER_FRESH_MS);
}

function shortProj(projectId) {
  const p = state.projects.find((x) => x.id === projectId);
  return p ? p.name : '#' + projectId;
}

// [需求@2026-06-11 §2 + 2026-06-12 §8.6] 仪表盘 tab 1 — 终端实时(含 memory + 活动)
async function refreshTerminalsList() {
  try {
    const includeDead = els.termIncludeDead.checked;
    const params = ['details=1'];
    if (includeDead) params.push('includeDead=1');
    const r = await fetch(`/api/instances/all?${params.join('&')}`);
    if (!r.ok) throw new Error('fetch failed: ' + r.status);
    const instances = await r.json();
    renderTerminalsList(instances);
  } catch (e) {
    els.terminalsList.innerHTML = `<div class="term-empty">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

function renderTerminalsList(instances) {
  if (!instances.length) {
    els.terminalsList.innerHTML = `<div class="term-empty">当前没有 claude 终端实例</div>`;
    return;
  }
  // [需求@2026-06-12 §8.6] 列加 displayName/slot/活动/memory
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
    const fullId = i.id;
    return `
      <div class="term-row">
        <div><span class="term-status ${i.status}">${i.status[0]}</span></div>
        <div title="${escapeHtml(fullId)} · session ${i.sessionId || '-'}">${escapeHtml(i.displayName || fullId)}</div>
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
  els.terminalsList.innerHTML = head + rows;

  els.terminalsList.querySelectorAll('.term-kill[data-id]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = btn.dataset.id;
      if (!confirm(`Kill ${id}?`)) return;
      try {
        await api(`/instances/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await refreshTerminalsList();
      } catch (err) {
        alert('kill failed: ' + err.message);
      }
    });
  });
}

// [需求@2026-06-12 §8.6] tab 切换 + 各 tab 加载触发
function wireDashboardTabs() {
  const tabs = document.querySelectorAll('#dashboard-tabs .tab-btn');
  const contents = document.querySelectorAll('#terminals-dialog .tab-content');
  tabs.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.tab;
      tabs.forEach((t) => t.classList.toggle('active', t === btn));
      contents.forEach((c) => { c.hidden = c.dataset.tab !== target; });
      // [需求@2026-06-12 §8.7] 切到任务队列 tab 自动刷新
      if (target === 'queue') await refreshQueueList();
      // [需求@2026-06-12 §8.8] 切到派工时序 tab 自动刷新
      if (target === 'dispatch') await refreshDispatchHistory();
    });
  });
}

// [需求@2026-06-12 §8.7] tab 2 — 任务队列
async function refreshQueueList() {
  const listEl = el('#queue-list');
  const includeClosedEl = el('#queue-include-closed');
  try {
    const includeClosed = includeClosedEl?.checked ? '1' : '0';
    const r = await fetch(`/api/threads/all?includeClosed=${includeClosed}`);
    if (!r.ok) throw new Error('fetch failed: ' + r.status);
    const threads = await r.json();
    renderQueueList(threads);
  } catch (e) {
    listEl.innerHTML = `<div class="queue-empty">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

const STAGE_ORDER = ['discussing', 'designing', 'executing', 'testing', 'verified', 'closed'];

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
        <div class="queue-row" data-slug="${escapeHtml(t.slug)}" data-pid="${t.projectId}">
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
        await api(`/threads/${encodeURIComponent(slug)}?projectId=${projectId}`, {
          method: 'PATCH', body: { stage: 'closed' },
        });
        await refreshQueueList();
        // also refresh main left-side thread board if relevant
        if (parseInt(projectId, 10) === state.activeProjectId) {
          await reloadProjectScopedData();
        }
      } catch (err) {
        alert('archive failed: ' + err.message);
      }
    });
  });
}

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

// [需求@2026-06-12 §8.8] tab 3 — H 派工时序
async function refreshDispatchHistory() {
  const listEl = el('#dispatch-list');
  try {
    const r = await fetch(`/api/dispatches/history?limit=200`);
    if (!r.ok) throw new Error('fetch failed: ' + r.status);
    const events = await r.json();
    const view = (document.querySelector('input[name="dispatch-view"]:checked') || {}).value || 'thread';
    if (view === 'global') {
      renderDispatchGlobal(events);
    } else {
      renderDispatchByThread(events);
    }
  } catch (e) {
    listEl.innerHTML = `<div class="dispatch-empty">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

function fmtDispatchTs(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
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
      <div class="ts">${fmtDispatchTs(e.ts)}</div>
      <div class="kind-tag">${kindShort}</div>
      ${arrow}
      <div class="reason" title="${escapeHtml(reason)}">${escapeHtml(reason.slice(0, 60))}</div>
    </div>
  `;
}

function renderDispatchByThread(events) {
  const listEl = el('#dispatch-list');
  if (!events.length) {
    listEl.innerHTML = `<div class="dispatch-empty">还没有派工记录</div>`;
    return;
  }
  // Group by thread_slug, keep project too for header
  const groups = new Map(); // slug → { projectName, events[] }
  for (const e of events) {
    const key = `${e.projectId}::${e.threadSlug}`;
    if (!groups.has(key)) groups.set(key, { projectName: e.projectName, slug: e.threadSlug, events: [] });
    groups.get(key).events.push(e);
  }
  // For each group, sort events ASC (oldest first) for timeline reading
  const groupList = [...groups.values()];
  for (const g of groupList) g.events.sort((a, b) => a.ts - b.ts);
  // Group order: by most recent event DESC (most active thread on top)
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
  // events already DESC from API
  const html = ['<div class="dispatch-thread">'];
  for (const e of events) {
    html.push(`<div class="dispatch-event ${e.kind === 'thread.handoff' ? 'handoff' : e.kind === 'thread.done' ? 'done' : 'blocked'}">`);
    html.push(`<div class="ts">${fmtDispatchTs(e.ts)}</div>`);
    const kindShort = e.kind === 'thread.handoff' ? 'h-o' : e.kind === 'thread.done' ? 'done' : 'blkd';
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
    html.push(`<div class="reason" title="${escapeHtml(reason)}">${escapeHtml(reason.slice(0, 60))}</div>`);
    html.push(`</div>`);
  }
  html.push(`</div>`);
  listEl.innerHTML = html.join('');
}

async function updateTerminalsCount() {
  try {
    const r = await fetch('/api/instances/all');
    if (!r.ok) return;
    const list = await r.json();
    const alive = list.filter((i) => ['spawning', 'idle', 'busy', 'awaiting_verify', 'blocked'].includes(i.status)).length;
    els.terminalsCount.textContent = String(alive);
  } catch {}
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

  // [需求@2026-06-11 §2 + 2026-06-12 §8.6] 仪表盘 modal + tab 切换
  els.terminalsBtn.addEventListener('click', async () => {
    await refreshTerminalsList();
    els.terminalsDialog.showModal();
  });
  els.termRefresh.addEventListener('click', refreshTerminalsList);
  els.termIncludeDead.addEventListener('change', refreshTerminalsList);
  wireDashboardTabs();

  // [需求@2026-06-12 §8.7] tab 2 toolbar
  const queueRefreshBtn = document.getElementById('queue-refresh');
  const queueIncludeClosed = document.getElementById('queue-include-closed');
  if (queueRefreshBtn) queueRefreshBtn.addEventListener('click', refreshQueueList);
  if (queueIncludeClosed) queueIncludeClosed.addEventListener('change', refreshQueueList);

  // [需求@2026-06-12 §8.8] tab 3 toolbar
  const dispatchRefresh = document.getElementById('dispatch-refresh');
  if (dispatchRefresh) dispatchRefresh.addEventListener('click', refreshDispatchHistory);
  document.querySelectorAll('input[name="dispatch-view"]').forEach((el) => {
    el.addEventListener('change', refreshDispatchHistory);
  });

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
