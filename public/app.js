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
  // [需求@2026-06-13 §17] 流式渲染开关 — off 时不渲染 stream_event 增量(降低 noise + 减负担)
  streamingEnabled: localStorage.getItem('mate.streaming') !== 'off',
  // [需求@2026-06-13 §19] LLM 等待 indicator(每个对话流末尾一个)
  waitIndicator: null,  // { el, startedAt, intervalId } 或 null
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
  langBtn: el('#lang-btn'),
  healthcheckBtn: el('#healthcheck-btn'),
  hcDialog: el('#healthcheck-dialog'),
  hcResults: el('#hc-results'),
  hcRun: el('#hc-run'),
  // [需求@2026-06-12 §8.6.5] 顶栏 "系统 (N)" 按钮 — 跳 /dashboard.html(新 tab)
  terminalsBtn: el('#terminals-btn'),
  terminalsCount: el('#terminals-count'),
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
  // [需求@2026-06-13 §17] 流式渲染开关
  streamingToggle: el('#streaming-toggle-input'),
  // [需求@2026-06-16 B3] 全文检索
  searchInput: el('#search-input'),
  searchResults: el('#search-results'),
};

// ---------------- i18n helper ----------------
const t = (key, params) => (window.MateI18n ? window.MateI18n.t(key, params) : key);
function applyLangBtnLabel() {
  if (!els.langBtn || !window.MateI18n) return;
  // Button shows the OTHER language for the user to click into
  els.langBtn.textContent = window.MateI18n.getLang() === 'zh' ? 'EN' : '中';
}

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
  renderer.code = function (codeOrToken, langArg) {
    // [bug@2026-06-12 §9] marked v14 把 renderer.code 改成接 Token 对象({text, lang, raw}),
    //   老签名是 (codeString, lang)。同时支持两种,避免 code 实际为空时 pre 框空白。
    let code, lang;
    if (codeOrToken && typeof codeOrToken === 'object' && 'text' in codeOrToken) {
      code = codeOrToken.text || '';
      lang = codeOrToken.lang || langArg || '';
    } else {
      code = String(codeOrToken ?? '');
      lang = langArg || '';
    }

    let body;
    if (lang && window.hljs && hljs.getLanguage(lang)) {
      try {
        body = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        body = escapeHtml(code);
      }
    } else if (window.hljs && code) {
      try { body = hljs.highlightAuto(code).value; } catch { body = escapeHtml(code); }
    } else {
      body = escapeHtml(code);
    }
    // [bug@2026-06-12 §9] 兜底:无论上面哪条分支,body 空 = fallback 到 escapeHtml,
    //   防止 highlight.js 在边界 case 吞 content
    if (!body) body = escapeHtml(code);

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
        btn.textContent = t('stream.copyBtnCopied');
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

  // [需求@2026-06-12 Phase 2E §14] 实时运行态 chip(顶栏右上角)
  if (window.RuntimeChip) {
    window.RuntimeChip.init({ projectId: state.activeProjectId });
  }

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
  b.textContent = t('banner.proxy', { state: sys.httpProxy ? 'OK' : 'unset' });
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
      ? window.MateI18n.t('board.waiting', { q: escapeHtml(String(t.metadata.blocked.question).slice(0, 60)) })
      : '';

    li.innerHTML = `
      <div class="slug">
        <span class="light ${light}"></span>
        ${escapeHtml(t.title || t.slug)}
      </div>
      <div class="title">
        <span class="slug-text">${escapeHtml(t.slug)}</span>
        <button class="copy-slug-btn" data-slug="${escapeHtml(t.slug)}" title="${escapeHtml(window.MateI18n.t('board.copySlugTip'))}">📋</button>
        ${blockedText}
      </div>
      <div class="stage-row">
        <span class="stage ${t.stage}">${t.stage}</span>
      </div>
    `;
    li.addEventListener('click', (ev) => {
      // [需求@2026-06-15] 点 copy 不触发 focusThread
      if (ev.target.closest('.copy-slug-btn')) return;
      focusThread(t.slug);
    });
    // [需求@2026-06-15] copy slug 按钮
    const copyBtn = li.querySelector('.copy-slug-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        copySlugToClipboard(t.slug, copyBtn);
      });
    }
    els.threadsList.appendChild(li);
  }
}

// [需求@2026-06-15] 复制线索 slug 到剪贴板,带视觉反馈
function copySlugToClipboard(slug, btn) {
  navigator.clipboard.writeText(slug).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✓';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove('copied');
    }, 1200);
  }).catch((e) => {
    alert(t('board.copyFailed', { error: e.message }));
  });
}

function renderConvHeader() {
  const th = state.focusedSlug ? state.threads.get(state.focusedSlug) : null;
  if (!th) {
    els.convTitle.textContent = t('convHeader.empty');
    els.stagePicker.hidden = true;
    els.sendBtn.disabled = true;
    // 清掉可能残留的 slug + copy
    const ex = els.convTitle.parentNode.querySelector('.conv-slug');
    if (ex) ex.remove();
    return;
  }
  els.convTitle.textContent = `${th.title || th.slug}`;
  els.stagePicker.hidden = false;
  els.stagePicker.value = th.stage;
  els.sendBtn.disabled = false;
  applyBusyUiState();
  // [需求@2026-06-15 Phase 2G M1.4] 面包屑 + 队列/backlog 面板
  renderBreadcrumb();
  renderQueueAndBacklog();
  // [需求@2026-06-15] conv-header 加 slug + copy 按钮(title 跟 slug 不一样时才显)
  let slugEl = els.convTitle.parentNode.querySelector('.conv-slug');
  if (!slugEl) {
    slugEl = document.createElement('span');
    slugEl.className = 'conv-slug';
    els.convTitle.parentNode.insertBefore(slugEl, els.stagePicker);
  }
  slugEl.innerHTML = `<span class="conv-slug-text">${escapeHtml(th.slug)}</span>
                      <button class="copy-slug-btn" title="${escapeHtml(t('board.copySlugTip'))}">📋</button>`;
  const btn = slugEl.querySelector('.copy-slug-btn');
  btn.addEventListener('click', () => copySlugToClipboard(th.slug, btn));
}

// [需求@2026-06-13 §18] 焦点 thread 是否 busy(任一绑定实例处于 busy/spawning)
function isFocusedThreadBusy() {
  if (!state.focusedSlug) return false;
  const t = state.threads.get(state.focusedSlug);
  if (!t) return false;
  const bound = t.metadata?.current_role_instances || {};
  for (const id of Object.values(bound)) {
    if (!id) continue;
    const inst = state.instances.get(id);
    if (inst && (inst.status === 'busy' || inst.status === 'spawning')) return true;
  }
  return false;
}

// [需求@2026-06-13 §18] 输入框 + 发送按钮根据 thread busy 状态切换形态
//   - busy:输入框 disable + 提示走 "+新线索";发送按钮变红 "■ 停止"(点击 = stop)
//   - idle:正常 "发送" 按钮
//   sendBtn 在 busy 下不 disable — 形态切到 stop,form submit 时按 busy 分支
function applyBusyUiState() {
  const busy = isFocusedThreadBusy();
  if (!state.focusedSlug) {
    els.msgInput.disabled = true;
    els.sendBtn.classList.remove('stop-mode');
    els.sendBtn.textContent = t('send.btn');
    return;
  }
  els.msgInput.disabled = busy;
  els.msgInput.placeholder = busy
    ? t('send.placeholderBusy')
    : t('send.placeholder');
  els.sendBtn.classList.toggle('stop-mode', busy);
  els.sendBtn.textContent = busy ? t('send.stopBtn') : t('send.btn');
  // sendBtn 始终 enabled — busy 时点击 = stop;idle 时点击 = submit
  els.sendBtn.disabled = false;
}

async function focusThread(slug) {
  state.focusedSlug = slug;
  localStorage.setItem(`${LS_FOCUSED_THREAD}.${state.activeProjectId}`, slug);
  // [需求@2026-06-13 §19] 切线索清干净 indicator(防泄漏到新流)
  stopWaitIndicator();
  renderThreads();
  renderConvHeader();
  els.stream.innerHTML = '';
  state.streamingAssistants.delete(slug);
  await loadThreadHistory(slug);
  // [需求@2026-06-15 Phase 2G M1.4] 拉队列/backlog
  refreshQueueForFocusedThread();
}

// [需求@2026-06-16 B1] "看更早" 按钮 — 长跑线索一次 5000 events 还不够,加分页
function renderLoadMoreButton() {
  let btn = document.querySelector('#load-more-history');
  if (state.fullHistoryLoaded || !state.earliestLoadedTs) {
    if (btn) btn.remove();
    return;
  }
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'load-more-history';
    btn.className = 'load-more-btn';
    btn.addEventListener('click', loadEarlierHistory);
    els.stream.insertBefore(btn, els.stream.firstChild);
  }
  btn.textContent = t('history.loadMore');
}

async function loadEarlierHistory() {
  const btn = document.querySelector('#load-more-history');
  if (!btn || !state.earliestLoadedTs) return;
  btn.disabled = true;
  btn.textContent = t('history.loading');
  try {
    const msgs = await api(`/threads/${encodeURIComponent(state.focusedSlug)}/history?projectId=${state.activeProjectId}&limit=5000&before=${state.earliestLoadedTs}`);
    if (!msgs.length) {
      state.fullHistoryLoaded = true;
      btn.remove();
      return;
    }
    // 保留滚动位置(从 anchor 测量)
    const anchorTop = els.stream.scrollHeight - els.stream.scrollTop;
    // 插到 button 后面(顺序倒插法:msgs 已升序,从最后一条往前 insert)
    const anchor = btn.nextSibling;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const tmp = document.createElement('div');
      tmp.dataset.tmp = '1';
      els.stream.insertBefore(tmp, anchor);
      // 复用 renderEventInStream:先 append 到尾,再移到 tmp 位置
      const startCount = els.stream.children.length;
      renderEventInStream(msgs[i].eventType, msgs[i].payload, false);
      // 找新增的 children(最后几个),移到 tmp 之前
      while (els.stream.children.length > startCount) {
        const node = els.stream.lastChild;
        els.stream.insertBefore(node, tmp);
      }
      tmp.remove();
    }
    state.earliestLoadedTs = msgs[0].ts;
    state.fullHistoryLoaded = msgs.length < 5000;
    els.stream.scrollTop = els.stream.scrollHeight - anchorTop;
  } catch (e) {
    console.error('load earlier history failed:', e);
    btn.textContent = t('history.loadMore');
    btn.disabled = false;
  } finally {
    renderLoadMoreButton();
  }
}

async function loadThreadHistory(slug) {
  try {
    // [需求@2026-06-16 B1] 默认 5000 events(长跑线索 + reset 周期保留所有)
    const msgs = await api(`/threads/${encodeURIComponent(slug)}/history?projectId=${state.activeProjectId}&limit=5000`);
    for (const m of msgs) renderEventInStream(m.eventType, m.payload, false);
    // 记最早 ts 给"看更早"按钮用
    state.earliestLoadedTs = msgs.length ? msgs[0].ts : null;
    state.fullHistoryLoaded = msgs.length < 5000;
    renderLoadMoreButton();
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
  // [需求@2026-06-13 §19] 系统 noise 静音 — hook_started/hook_response/status 等不进主流
  //   只保留 system/init(有 session 信息)、system/api_retry(可观察 API 重试压力)
  if (typeof eventType === 'string' && eventType.startsWith('system/')
      && eventType !== 'system/init' && eventType !== 'system/api_retry') {
    return;
  }
  if (eventType === 'system/init') {
    node = makeMsg('system', 'system / init', `session: ${raw.session_id} · model: ${raw.model}`);
  } else if (eventType === 'system/api_retry') {
    node = makeMsg('system', 'system / api_retry', JSON.stringify(raw).slice(0, 300));
  } else if (eventType === 'rate_limit_event') {
    // skip — noise
    return;
  } else if (eventType === 'user') {
    // [arch §13 user 反馈 2026-06-13] 区分:真 user 文字 vs tool_result(工具返回)
    //   原行为:两种都渲染成蓝色 user bubble,"大段蓝色"实际是 grep/Read/Bash 等工具返回
    //   现在:tool_result 渲染成可折叠的琥珀色 tool-block,真 user 文字仍蓝色
    const content = raw.message?.content || [];
    const toolResults = Array.isArray(content) ? content.filter((c) => c.type === 'tool_result') : [];
    if (toolResults.length) {
      for (const tr of toolResults) {
        const trnode = makeToolResultBlock(tr);
        els.stream.appendChild(trnode);
      }
      // [需求@2026-06-13 §19] tool_result 一进来,LLM 又开始下一轮 API 调用 → 显示等待
      if (autoscroll) startWaitIndicator('tool_result');
    } else {
      const txt = userEventToText(raw);
      if (txt) node = makeMsg('user', 'user', txt);
      // user 发文字 → 等 LLM 响应
      if (autoscroll && txt) startWaitIndicator('user');
    }
  } else if (eventType === 'assistant') {
    // [需求@2026-06-13 §19] 收到 assistant final → LLM 已响应,清等待
    stopWaitIndicator();
    const text = (raw.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const tools = (raw.message?.content || []).filter((c) => c.type === 'tool_use');
    if (text) {
      const existing = state.streamingAssistants.get(state.focusedSlug);
      if (existing && existing.el && existing.el.isConnected) {
        // [需求@2026-06-10 §1.5] 流式完成后用 markdown 渲染替换
        // [需求@2026-06-13 §16] 终态 = 拆掉 <details>,直接展示完整 markdown(默认可见)
        existing.el.className = 'msg assistant';
        existing.el.innerHTML = '<div class="role">assistant</div><div class="body"></div>';
        const body = existing.el.querySelector('.body');
        body.innerHTML = renderMarkdown(text);
        attachCopyHandlers(body);
        state.streamingAssistants.delete(state.focusedSlug);
        node = null;
      } else {
        node = makeMsg('assistant', 'assistant', text, /* asMarkdown */ true);
      }
    }
    for (const t of tools) {
      // [需求@2026-06-12 Phase 2E §1] tool block 默认折叠成一行摘要
      const tnode = makeToolBlock(t);
      els.stream.appendChild(tnode);
    }
  } else if (eventType === 'stream_event') {
    // [需求@2026-06-13 §17] 流式关 → 不渲染 partial(等 final assistant 一次性显示)
    if (!state.streamingEnabled) return;
    const sub = raw.event;
    if (sub?.type === 'content_block_delta' && sub.delta?.type === 'text_delta') {
      // [需求@2026-06-13 §19] 第一个 token 进来 → LLM 已开始生成,清等待
      stopWaitIndicator();
      let s = state.streamingAssistants.get(state.focusedSlug);
      if (!s) {
        // [需求@2026-06-13 §16] 流式气泡默认折叠 — 用 <details> 包裹,只露 "streaming…N 字" 摘要
        const elNode = document.createElement('div');
        elNode.className = 'msg assistant streaming';
        elNode.innerHTML = `
          <details class="streaming-details">
            <summary class="streaming-summary">
              <span class="role">assistant…</span>
              <span class="streaming-meta">${escapeHtml(t('stream.streamingMeta'))} · <span class="streaming-chars">0</span> ${escapeHtml(t('stream.streamingChars'))}</span>
            </summary>
            <div class="body streaming-body"></div>
          </details>
        `;
        els.stream.appendChild(elNode);
        s = { text: '', el: elNode };
        state.streamingAssistants.set(state.focusedSlug, s);
      }
      s.text += sub.delta.text;
      // 流式期间纯文本(快渲染),完成后 markdown
      const body = s.el.querySelector('.streaming-body');
      if (body) body.textContent = s.text;
      const chars = s.el.querySelector('.streaming-chars');
      if (chars) chars.textContent = String(s.text.length);
    }
  } else if (typeof eventType === 'string' && eventType.startsWith('result')) {
    // [bug@2026-06-13] streamParser 把 type+subtype 拼成 'result/success' / 'result/error',
    //   原 `=== 'result'` 不匹配 → result bubble 不渲染 + waitIndicator 漏清。
    //   用 startsWith('result') 匹配所有 result 子类型(同 streamParser.isResult 谓词逻辑)。
    stopWaitIndicator();
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

// [需求@2026-06-13 §19] LLM 等待 indicator — 解决"为什么半天没反应"的感知问题
//   触发:user 发文字、tool_result 返回(下一轮 API 已发出)
//   清除:assistant final 到达、第一个 stream_event 增量、result/* 到达、focus 切换、stop
//   只一个全局 indicator(focused thread 的 stream 末尾);切 thread 自动清。
function startWaitIndicator(source) {
  if (state.waitIndicator) return;  // 已有,别叠
  // [需求@2026-06-15 Phase 2G] 移到 stream 底部独立位置(send-form 上方,跟面包屑同区),
  //   不再追加到 #stream 内,跟消息流分开
  document.querySelectorAll('.waiting-indicator').forEach((n) => n.remove());  // 防泄漏(全文搜)
  const div = document.createElement('div');
  div.className = 'waiting-indicator';
  div.dataset.source = source || '';
  div.innerHTML = `<span class="wi-icon">⌛</span> ${escapeHtml(t('stream.waitingLLM'))} <span class="wi-timer">0s</span>`;
  // 插到 send-form 前面;若无 send-form 兜底 stream 末尾
  const sendForm = document.querySelector('#send-form');
  if (sendForm && sendForm.parentNode) {
    sendForm.parentNode.insertBefore(div, sendForm);
  } else {
    els.stream.appendChild(div);
  }
  const startedAt = Date.now();
  const intervalId = setInterval(() => {
    if (!div.isConnected) { clearInterval(intervalId); return; }
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    const t = div.querySelector('.wi-timer');
    if (t) t.textContent = sec + 's';
  }, 500);
  state.waitIndicator = { el: div, startedAt, intervalId };
}

function stopWaitIndicator() {
  if (!state.waitIndicator) {
    // 兜底:DOM 上若还有泄漏的(focus 切换前残留)也清
    els.stream.querySelectorAll('.waiting-indicator').forEach((n) => n.remove());
    return;
  }
  clearInterval(state.waitIndicator.intervalId);
  if (state.waitIndicator.el.parentNode) state.waitIndicator.el.remove();
  state.waitIndicator = null;
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

// [需求@2026-06-12 Phase 2E §1] tool_use 折叠展示
//   默认折叠成一行 `🔧 Grep "pattern" · 展开▾`
//   TodoWrite / TaskCreate 默认展开(结构化任务,user 要看)
const TOOL_DEFAULT_OPEN = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);
function makeToolBlock(toolUse) {
  const div = document.createElement('div');
  div.className = 'msg tool_use tool-block';
  const open = TOOL_DEFAULT_OPEN.has(toolUse.name);
  div.innerHTML = `
    <details ${open ? 'open' : ''}>
      <summary class="tool-summary">
        <span class="tool-icon">🔧</span>
        <span class="tool-name">${escapeHtml(toolUse.name || 'tool')}</span>
        <span class="tool-hint">${escapeHtml(toolHintFor(toolUse))}</span>
      </summary>
      <pre class="tool-detail">${escapeHtml(JSON.stringify(toolUse.input || {}, null, 2))}</pre>
    </details>
  `;
  return div;
}
// [arch §13 user 反馈 2026-06-13] tool_result 折叠块
//   原本 claude 的 tool_result 走 user direction event,被渲染成大段蓝色 user bubble。
//   现在改成琥珀色可折叠 "🔧 tool 返回" — 跟 makeToolBlock 配色一致。
function makeToolResultBlock(toolResult) {
  const div = document.createElement('div');
  div.className = 'msg tool_use tool-block tool-result-block';
  // 提取 text
  let text = '';
  if (typeof toolResult.content === 'string') {
    text = toolResult.content;
  } else if (Array.isArray(toolResult.content)) {
    text = toolResult.content.map((x) => x.text || (typeof x === 'string' ? x : '')).join('');
  } else if (toolResult.content) {
    text = JSON.stringify(toolResult.content);
  }
  const lineCount = text.split('\n').length;
  const isErr = toolResult.is_error;
  // hint:首行预览 + 大小
  const firstLine = text.split('\n').find((l) => l.trim()) || '';
  const trimmedFirst = (firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine);
  const hint = t('stream.toolReturnHint', { firstLine: trimmedFirst, lines: lineCount, chars: text.length });
  div.innerHTML = `
    <details>
      <summary class="tool-summary">
        <span class="tool-icon">${isErr ? '❌' : '↩'}</span>
        <span class="tool-name">${escapeHtml(isErr ? t('stream.toolReturnError') : t('stream.toolReturn'))}</span>
        <span class="tool-hint">${escapeHtml(hint)}</span>
      </summary>
      <pre class="tool-detail">${escapeHtml(text)}</pre>
    </details>
  `;
  return div;
}

function toolHintFor(t) {
  const inp = t.input || {};
  if (t.name === 'Read' || t.name === 'Write') return inp.file_path || '';
  if (t.name === 'Edit') return inp.file_path || '';
  if (t.name === 'Glob') return inp.pattern || '';
  if (t.name === 'Grep') return `"${inp.pattern || ''}"${inp.path ? ' in ' + inp.path : ''}`;
  if (t.name === 'Bash') return (inp.command || '').slice(0, 80);
  if (t.name === 'WebFetch') return inp.url || '';
  if (t.name === 'TodoWrite' && Array.isArray(inp.todos)) return window.MateI18n.t('stream.todoItems', { n: inp.todos.length });
  return '';
}

// ---------------- Environment check (§1.1) ----------------
async function runHealthcheck() {
  els.hcRun.disabled = true;
  els.hcResults.innerHTML = `<div class="muted">${escapeHtml(t('dialog.healthcheck.running'))}</div>`;
  try {
    const result = await api('/system/healthcheck', { method: 'POST' });
    renderHealthcheck(result);
  } catch (e) {
    els.hcResults.innerHTML = `<div class="error">${escapeHtml(t('dialog.healthcheck.invokeFailed', { error: e.message }))}</div>`;
  } finally {
    els.hcRun.disabled = false;
  }
}

function renderHealthcheck(result) {
  const rows = [
    `<div class="muted" style="margin-bottom: 8px;">${escapeHtml(t('dialog.healthcheck.summary', { summary: result.summary, n: result.checks.length }))}</div>`,
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
// [arch §9 ✅] 走 MateWS 单例,不再自建 WebSocket
function connectWs() {
  if (!window.MateWS) {
    console.warn('[app] MateWS not loaded — check script order in index.html');
    return;
  }
  window.MateWS.subscribeAll(handleWsMsg);
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
    // [bug@2026-06-15] claude 完 turn → result → _setStatus('idle') → status_change
    //   走这条路径(非 exited),需要重算 busy UI 才能把 ■停止 翻 发送
    applyBusyUiState();
  } else if (type === 'instance.exited') {
    const inst = payload.instance;
    // [需求@2026-06-11 §3] 事件流 — kill/exit 推一条
    pushTickerEvent('kill', `× ${inst.id}  (${payload.code !== null ? 'rc=' + payload.code : payload.signal || 'killed'})`);
    updateTerminalsCount();
    if (inst.projectId !== state.activeProjectId) return;
    state.instances.set(inst.id, inst);
    renderThreads();
    // [需求@2026-06-13 §18] 实例状态变化 → 重算焦点 thread 是否 busy
    applyBusyUiState();
  } else if (type === 'instance.event') {
    if (payload.projectId !== state.activeProjectId) return;
    if (payload.threadSlug === state.focusedSlug) {
      // [需求@2026-06-12 Phase 2E §12] 乐观 UI dedup:user echo back 时,如果存在临时 bubble 匹配 clientMessageId → 不重复渲染
      if (payload.eventType === 'user' && payload.clientMessageId) {
        const existing = els.stream.querySelector(`.msg.user[data-client-id="${CSS.escape(payload.clientMessageId)}"]`);
        if (existing) {
          existing.dataset.serverId = payload.serverMessageId || '';
          return;  // 已有 bubble,跳过 echo 渲染
        }
      }
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
    els.msgInput.placeholder = window.MateI18n.t('send.placeholderQuestions', { n: questions.length });
    // Focus the input box (so user can start typing immediately)
    els.msgInput.focus();
  } else if (type === 'thread.metadata_updated') {
    // [需求@2026-06-11 §4] 线索 metadata 变化(pending_question 翻转)→ 重算黄灯
    if (payload.projectId !== state.activeProjectId) return;
    state.threads.set(payload.threadSlug, payload.thread);
    renderThreads();
  } else if (type === 'thread.handoff') {
    // [需求@2026-06-10 §6.4 + 2026-06-12 §10] 派工进度状态机入口(pending 态)
    pushTickerEvent('handoff', `${payload.from} → ${payload.target}  ${payload.reason ? '· ' + payload.reason.slice(0, 30) : ''}`);
    if (payload.projectId !== state.activeProjectId) return;
    if (payload.threadSlug === state.focusedSlug) {
      renderHandoffCard(payload, 'pending');
    }
    api(`/threads/${encodeURIComponent(payload.threadSlug)}?projectId=${state.activeProjectId}`)
      .then((t) => { state.threads.set(t.slug, t); renderThreads(); if (t.slug === state.focusedSlug) renderConvHeader(); })
      .catch(() => {});
  } else if (type === 'thread.handoff.spawning') {
    if (payload.projectId !== state.activeProjectId) return;
    if (payload.threadSlug === state.focusedSlug) {
      renderHandoffCard(payload, 'spawning');
    }
  } else if (type === 'thread.handoff.ready') {
    if (payload.projectId !== state.activeProjectId) return;
    if (payload.threadSlug === state.focusedSlug) {
      renderHandoffCard(payload, 'ready');
    }
  } else if (type === 'thread.handoff.failed') {
    pushTickerEvent('blocked', t('ticker.handoffFailed', { target: payload.target, error: payload.error || '' }).slice(0, 80));
    if (payload.projectId !== state.activeProjectId) return;
    if (payload.threadSlug === state.focusedSlug) {
      renderHandoffCard(payload, 'failed');
    }
  } else if (type === 'thread.done') {
    pushTickerEvent('done', t('ticker.doneVerified', { slug: payload.threadSlug }));
    if (payload.projectId !== state.activeProjectId) return;
    if (payload.threadSlug === state.focusedSlug) {
      const node = makeMsg('system done-card', t('stream.threadDoneTitle'), payload.summary || t('stream.threadDoneFallback'));
      els.stream.appendChild(node);
      els.stream.scrollTop = els.stream.scrollHeight;
    }
    state.threads.set(payload.threadSlug, payload.thread);
    renderThreads();
  } else if (type === 'thread.blocked') {
    pushTickerEvent('blocked', t('ticker.blocked', { slug: payload.threadSlug, q: String(payload.question).slice(0, 40) }));
    if (payload.projectId !== state.activeProjectId) return;
    if (payload.threadSlug === state.focusedSlug) {
      const node = makeMsg('blocked-card', t('stream.blockedTitle', { raisedBy: payload.raisedBy }),
        payload.question);
      els.stream.appendChild(node);
      els.stream.scrollTop = els.stream.scrollHeight;
    }
    state.threads.set(payload.threadSlug, payload.thread);
    renderThreads();
  } else if (type === 'system.cap_warn') {
    // [需求@2026-06-12 §8.10] 全局软上限超出 — 顶栏红条 banner
    showSystemBanner('cap_warn', t('banner.capWarn', { alive: payload.alive, cap: payload.cap }));
    pushTickerEvent('blocked', t('ticker.capWarn', { alive: payload.alive, cap: payload.cap }));
  } else if (type === 'instance.ttl_soon') {
    // [需求@2026-06-12 §8.10] 黄色提示:即将到期
    pushTickerEvent('handoff', t('ticker.ttlSoon', { name: payload.displayName, minutes: payload.minutesUntilExpiry }));
  } else if (type === 'instance.ttl_expired') {
    // [需求@2026-06-12 §8.10] 已过期:下次 user send 会自动开新 session
    pushTickerEvent('blocked', t('ticker.ttlExpired', { name: payload.displayName, idleH: payload.idleHours, ttlH: payload.ttlHours }));
  } else if (type === 'instance.unstuck') {
    // [需求@2026-06-12 Phase 2E §4] 自动解卡:status=busy 但长时间无活动 → 翻 idle
    pushTickerEvent('handoff', t('ticker.unstuck', { name: payload.displayName, minutes: payload.stuckMinutes }));
    if (payload.projectId === state.activeProjectId && state.focusedSlug) {
      const focused = state.threads.get(state.focusedSlug);
      const boundIds = focused?.metadata?.current_role_instances || {};
      const matches = Object.values(boundIds).includes(payload.instanceId);
      if (matches) {
        const node = makeMsg('system', t('stream.unstuckTitle'),
          t('stream.unstuckBody', { name: payload.displayName, minutes: payload.stuckMinutes }));
        els.stream.appendChild(node);
        els.stream.scrollTop = els.stream.scrollHeight;
      }
    }
  } else if (type === 'instance.aged_out') {
    // [需求@2026-06-12 Phase 2E §13] disconnected 老化:超过保留数 → 标 dead
    pushTickerEvent('kill', t('ticker.agedOut', { name: payload.displayName, days: payload.ageDays }));
    updateTerminalsCount();
  } else if (type === 'dispatch.busy_prompt') {
    // [需求@2026-06-15 Phase 2G M1.4] H/B/C busy 时,marker 派工先问 user:等 / backlog / 取消
    if (payload.projectId !== state.activeProjectId) return;
    handleBusyPrompt(payload);
  } else if (type === 'queue.added') {
    if (payload.projectId !== state.activeProjectId) return;
    pushTickerEvent('handoff', `⏸ queued → ${payload.toInstanceId}`);
    refreshQueueForThread(payload.threadSlug);
  } else if (type === 'queue.claimed') {
    if (payload.projectId !== state.activeProjectId) return;
    pushTickerEvent('handoff', `▶ flushed → ${payload.toInstanceId}`);
    refreshQueueForThread(payload.threadSlug);
  } else if (type === 'queue.cancelled' || type === 'backlog.cancelled') {
    if (payload.projectId !== state.activeProjectId) return;
    pushTickerEvent('kill', `✕ ${type === 'backlog.cancelled' ? 'backlog' : 'queue'} cancelled`);
    refreshQueueForThread(payload.threadSlug);
  } else if (type === 'backlog.added') {
    if (payload.projectId !== state.activeProjectId) return;
    pushTickerEvent('handoff', `📥 backlog → ${payload.toInstanceId}`);
    refreshQueueForThread(payload.threadSlug);
  } else if (type === 'backlog.dispatched') {
    if (payload.projectId !== state.activeProjectId) return;
    pushTickerEvent('handoff', `📤 backlog → queue`);
    refreshQueueForThread(payload.threadSlug);
  } else if (type === 'dispatch.chain_updated') {
    if (payload.projectId !== state.activeProjectId) return;
    // 更新内存中的 thread metadata.dispatch_chain
    const th = state.threads.get(payload.threadSlug);
    if (th) {
      th.metadata = th.metadata || {};
      th.metadata.dispatch_chain = payload.chain || [];
      state.threads.set(payload.threadSlug, th);
    }
    if (payload.threadSlug === state.focusedSlug) {
      renderBreadcrumb();
    }
  }
}

// ============ Phase 2G M1.4 队列 + 面包屑 + busy_prompt modal ============

// 内存:每个 thread 当前的 queue/backlog 项
const queueByThread = new Map();  // threadSlug → array of pending rows

async function refreshQueueForThread(threadSlug) {
  if (!threadSlug || !state.activeProjectId) return;
  try {
    const items = await api(`/queue?projectId=${state.activeProjectId}&threadSlug=${encodeURIComponent(threadSlug)}`);
    queueByThread.set(threadSlug, items);
    if (threadSlug === state.focusedSlug) renderQueueAndBacklog();
  } catch (e) {
    console.warn('[queue] refresh failed', e.message);
  }
}

// 全局 refresh — 用在 focusThread / 初始化
async function refreshQueueForFocusedThread() {
  if (state.focusedSlug) await refreshQueueForThread(state.focusedSlug);
}

// dispatch.busy_prompt → modal
function handleBusyPrompt(payload) {
  // 一次只显一个 modal
  document.querySelector('#busy-prompt-dialog')?.remove();
  const dlg = document.createElement('dialog');
  dlg.id = 'busy-prompt-dialog';
  const fromName = payload.fromDisplayName || payload.fromInstanceId;
  const toName = payload.toDisplayName || payload.toInstanceId;
  const reason = payload.reason ? `<div class="bp-reason"><strong>${t('busyPrompt.reason')}:</strong> ${escapeHtml(payload.reason)}</div>` : '';
  dlg.innerHTML = `
    <form method="dialog">
      <h3>${t('busyPrompt.title')}</h3>
      <p>${t('busyPrompt.body', { from: escapeHtml(fromName), to: escapeHtml(toName), thread: escapeHtml(payload.threadSlug || '?') })}</p>
      ${reason}
      <div class="dialog-actions">
        <button type="button" id="bp-wait"   class="primary">${t('busyPrompt.wait')}</button>
        <button type="button" id="bp-backlog">${t('busyPrompt.backlog')}</button>
        <button type="button" id="bp-cancel">${t('busyPrompt.cancel')}</button>
      </div>
      <div id="bp-error" class="error" style="color:#d44;margin-top:6px"></div>
    </form>
  `;
  document.body.appendChild(dlg);
  dlg.showModal();
  const errEl = dlg.querySelector('#bp-error');
  const submit = async (choice) => {
    errEl.textContent = '';
    try {
      await api(`/dispatch/${payload.pendingSendId}/choose`, {
        method: 'POST', body: { choice },
      });
      dlg.close();
      dlg.remove();
    } catch (e) {
      errEl.textContent = e.message;
    }
  };
  dlg.querySelector('#bp-wait').addEventListener('click', () => submit('wait'));
  dlg.querySelector('#bp-backlog').addEventListener('click', () => submit('backlog'));
  dlg.querySelector('#bp-cancel').addEventListener('click', () => submit('cancel'));
}

// 面包屑渲染 — 从 thread.metadata.dispatch_chain 读
function renderBreadcrumb() {
  const t2 = state.focusedSlug ? state.threads.get(state.focusedSlug) : null;
  let host = document.querySelector('#dispatch-breadcrumb');
  if (!host) {
    host = document.createElement('div');
    host.id = 'dispatch-breadcrumb';
    // [需求@2026-06-15 Phase 2G] 移到 stream 底部 — send-form 上面,跟等待 indicator 同区
    //   user 反馈:派工链贴底显示更直观,注意力跟着当前活动跑
    const sendForm = document.querySelector('#send-form');
    if (sendForm && sendForm.parentNode) {
      sendForm.parentNode.insertBefore(host, sendForm);
    }
  }
  const chain = t2?.metadata?.dispatch_chain || [];
  if (!chain.length) { host.innerHTML = ''; host.hidden = true; return; }
  // 折叠相邻同 instanceId
  const collapsed = [];
  for (const seg of chain) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.instanceId && last.instanceId === (seg.toInstanceId || seg.fromInstanceId)) {
      last.repeat = (last.repeat || 1) + 1;
      continue;
    }
    if (seg.kind === 'handoff') {
      collapsed.push({
        kind: 'handoff',
        label: seg.toDisplayName || seg.toInstanceId || seg.toRole,
        instanceId: seg.toInstanceId,
        ts: seg.ts,
      });
    } else if (seg.kind === 'done') {
      collapsed.push({ kind: 'done', label: '✓', ts: seg.ts });
    } else if (seg.kind === 'blocked') {
      collapsed.push({ kind: 'blocked', label: '⚠', ts: seg.ts });
    }
  }
  // 第一段如果没有,加 fromRole 起点
  if (chain.length && collapsed.length) {
    const firstSeg = chain[0];
    if (firstSeg.fromRole && firstSeg.fromInstanceId !== collapsed[0].instanceId) {
      collapsed.unshift({ kind: 'start', label: firstSeg.fromRole, instanceId: firstSeg.fromInstanceId });
    }
  }
  const html = `<span class="bc-label">${t('breadcrumb.label')}:</span>` + collapsed.map((c, i) => {
    const sep = i > 0 ? '<span class="bc-sep">→</span>' : '';
    const cls = `bc-seg bc-${c.kind}`;
    const repeat = c.repeat ? `<span class="bc-repeat">× ${c.repeat}</span>` : '';
    return `${sep}<span class="${cls}" title="${escapeHtml(c.instanceId || '')}">${escapeHtml(c.label)}${repeat}</span>`;
  }).join('');
  host.innerHTML = html;
  host.hidden = false;
}

// 当前线索的 queue / backlog 列表(放在面包屑下方)
function renderQueueAndBacklog() {
  let host = document.querySelector('#queue-backlog-panel');
  if (!host) {
    host = document.createElement('div');
    host.id = 'queue-backlog-panel';
    const bc = document.querySelector('#dispatch-breadcrumb');
    if (bc && bc.parentNode) bc.parentNode.insertBefore(host, bc.nextSibling);
  }
  const items = (queueByThread.get(state.focusedSlug) || []);
  if (!items.length) { host.innerHTML = ''; host.hidden = true; return; }
  const groups = { queued: [], backlog: [], waiting_user: [], processing: [] };
  for (const it of items) (groups[it.status] || (groups[it.status] = [])).push(it);
  const rows = [];
  for (const it of groups.queued) {
    rows.push(`<div class="qb-row qb-queued">
      <span class="qb-state">⏸ ${t('queue.statusQueued')}</span>
      <span class="qb-target">→ ${escapeHtml(it.targetId)}</span>
      <button class="qb-cancel" data-id="${it.id}">${t('queue.cancel')}</button>
    </div>`);
  }
  for (const it of groups.backlog) {
    rows.push(`<div class="qb-row qb-backlog">
      <span class="qb-state">📥 ${t('queue.statusBacklog')}</span>
      <span class="qb-target">→ ${escapeHtml(it.targetId)}</span>
      <button class="qb-dispatch" data-id="${it.id}">${t('queue.dispatchNow')}</button>
      <button class="qb-cancel" data-id="${it.id}">${t('queue.cancel')}</button>
    </div>`);
  }
  for (const it of groups.waiting_user) {
    rows.push(`<div class="qb-row qb-waiting">
      <span class="qb-state">❓ ${t('queue.statusWaitingUser')}</span>
      <span class="qb-target">→ ${escapeHtml(it.targetId)}</span>
    </div>`);
  }
  host.innerHTML = rows.join('');
  host.hidden = false;
  host.querySelectorAll('.qb-cancel').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try { await api(`/queue/${btn.dataset.id}/cancel`, { method: 'POST', body: {} }); }
      catch (e) { alert('cancel failed: ' + e.message); }
    });
  });
  host.querySelectorAll('.qb-dispatch').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try { await api(`/backlog/${btn.dataset.id}/dispatch`, { method: 'POST', body: {} }); }
      catch (e) { alert('dispatch failed: ' + e.message); }
    });
  });
}

// [需求@2026-06-12 §8.10] 顶栏粘性 system banner(cap warn 用)
function showSystemBanner(kind, text) {
  const id = `sys-banner-${kind}`;
  let node = document.getElementById(id);
  if (!node) {
    node = document.createElement('span');
    node.id = id;
    node.className = 'banner';
    node.style.background = '#5a1f1f';
    node.style.color = '#ffaaaa';
    node.style.cursor = 'pointer';
    node.title = t('banner.closeTip');
    node.addEventListener('click', () => node.remove());
    els.banners.appendChild(node);
  }
  node.textContent = text;
}

// [需求@2026-06-12 Phase 2E §12] 乐观 UI helpers
function makeClientMessageId() {
  return `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function appendOptimisticUserBubble(text, clientMessageId) {
  const node = document.createElement('div');
  node.className = 'msg user msg-sending';
  node.dataset.clientId = clientMessageId;
  // 使用既有 makeMsg 结构(role + body),但简化:user 自己的 bubble 直接放 text
  const roleEl = document.createElement('span');
  roleEl.className = 'role';
  roleEl.textContent = 'you';
  const bodyEl = document.createElement('div');
  bodyEl.className = 'body';
  bodyEl.textContent = text;
  const statusEl = document.createElement('span');
  statusEl.className = 'msg-status';
  statusEl.textContent = '· sending';
  node.appendChild(roleEl);
  node.appendChild(bodyEl);
  node.appendChild(statusEl);
  els.stream.appendChild(node);
  els.stream.scrollTop = els.stream.scrollHeight;
  return node;
}

// [需求@2026-06-12 Phase 2E §10] 派工进度状态机卡片
//   pending → spawning → ready 或 → failed
//   通过 handoffKey 关联;同 key 后续事件更新同一张卡片
function renderHandoffCard(payload, stage) {
  const key = payload.handoffKey || `${payload.from}-${payload.target}-${payload.threadSlug}`;
  let card = els.stream.querySelector(`.handoff-card[data-handoff-key="${CSS.escape(key)}"]`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'msg system handoff-card';
    card.dataset.handoffKey = key;
    card.innerHTML = `
      <div class="hf-line hf-line-1"><span class="hf-icon"></span><span class="hf-text"></span></div>
      <div class="hf-line hf-line-2"><span class="hf-reason"></span></div>
    `;
    els.stream.appendChild(card);
    els.stream.scrollTop = els.stream.scrollHeight;
  }
  card.classList.remove('hf-pending', 'hf-spawning', 'hf-ready', 'hf-failed');
  card.classList.add(`hf-${stage}`);
  const iconEl = card.querySelector('.hf-icon');
  const textEl = card.querySelector('.hf-text');
  const reasonEl = card.querySelector('.hf-reason');
  const target = payload.toDisplayName || payload.target;
  const map = {
    pending:  { icon: '▸', text: t('handoff.pending', { target }) },
    spawning: { icon: '◌', text: t('handoff.spawning', { target }) },
    ready:    { icon: '✓', text: t('handoff.ready', { target }) },
    failed:   { icon: '✗', text: t('handoff.failed', { error: payload.error || t('handoff.failedUnspecified') }) },
  };
  const m = map[stage] || map.pending;
  iconEl.textContent = m.icon;
  textEl.textContent = m.text;
  reasonEl.textContent = payload.reason || '';
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

// [需求@2026-06-12 §8.6.5] 仪表盘 render 函数已迁到 public/dashboard.js
//   主页面只保留 updateTerminalsCount(为顶栏 N badge 实时更新)


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
    // [需求@2026-06-12 Phase 2E §14] chip 跟随 active project
    if (window.RuntimeChip) window.RuntimeChip.setProjectId(newId);
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
      if (!info.exists) els.apInspect.textContent = t('dialog.addProject.inspectNotExist');
      else if (!info.isDirectory) els.apInspect.textContent = t('dialog.addProject.inspectNotDir');
      else {
        const tags = [];
        if (info.hasClaude) tags.push('.claude/');
        if (info.hasGit) tags.push('git');
        if (info.hasPackageJson) tags.push('package.json');
        if (info.hasClaudeMd) tags.push('CLAUDE.md');
        els.apInspect.textContent = tags.length ? t('dialog.addProject.inspectFound', { tags: tags.join(', ') }) : t('dialog.addProject.inspectEmpty');
      }
    } catch (e) {
      els.apInspect.textContent = t('dialog.addProject.inspectFailed', { error: e.message });
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
    els.hcResults.innerHTML = `<div class="muted">${escapeHtml(t('dialog.healthcheck.placeholder'))}</div>`;
    els.hcDialog.showModal();
  });
  els.hcRun.addEventListener('click', runHealthcheck);

  // [需求@2026-06-12 §8.6.5] "系统 (N)" 按钮跳独立仪表盘页面(新 tab)
  els.terminalsBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    window.open('/dashboard.html', '_blank', 'noopener');
  });

  // [需求@2026-06-10 §1.4] 新线索 dialog(slug 由 backend 自动生成)
  els.newThreadBtn.addEventListener('click', () => {
    if (!state.activeProjectId) { alert(t('dialog.newThread.needProject')); return; }
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
      alert(t('convHeader.stageFailed', { error: e.message }));
    }
  });

  els.sendForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!state.focusedSlug) return;
    // [需求@2026-06-13 §18] busy 状态下 sendBtn 是 ■ 停止 — 点击触发 stop 而非 send
    if (isFocusedThreadBusy()) {
      if (!confirm(t('send.stopConfirm'))) return;
      els.sendBtn.disabled = true;
      try {
        const out = await api(`/threads/${encodeURIComponent(state.focusedSlug)}/stop?projectId=${state.activeProjectId}`, { method: 'POST' });
        const n = (out.killed || []).length;
        const names = (out.killed || []).map((k) => k.displayName || k.id).join(', ');
        pushTickerEvent('kill', t('ticker.stopThread', { slug: state.focusedSlug, n, names: names ? ' (' + names + ')' : '' }));
        const sys = makeMsg('system', t('send.stopped'), n > 0 ? t('send.stoppedKill', { names }) : t('send.stoppedNone'));
        els.stream.appendChild(sys);
        els.stream.scrollTop = els.stream.scrollHeight;
        stopWaitIndicator();
      } catch (e) {
        alert(t('send.stopFailed', { error: e.message }));
      } finally {
        els.sendBtn.disabled = false;
      }
      return;
    }
    const text = els.msgInput.value.trim();
    if (!text) return;
    // [需求@2026-06-12 Phase 2E §12] 乐观 UI:立即渲染 bubble,带 sending 标志;后端 echo back 时 dedup
    const clientMessageId = makeClientMessageId();
    const bubble = appendOptimisticUserBubble(text, clientMessageId);
    const sentText = text;
    els.msgInput.value = '';
    try {
      await api(`/threads/${encodeURIComponent(state.focusedSlug)}/message?projectId=${state.activeProjectId}`, {
        method: 'POST', body: { text: sentText, clientMessageId },
      });
      bubble.classList.remove('msg-sending');
      bubble.classList.add('msg-sent');
      // [需求@2026-06-13 §19] 发完 user → 立即显 LLM 等待 indicator
      startWaitIndicator('user-send');
      const t = await api(`/threads/${encodeURIComponent(state.focusedSlug)}?projectId=${state.activeProjectId}`);
      state.threads.set(t.slug, t);
      renderThreads();
      applyBusyUiState();
    } catch (e) {
      bubble.classList.remove('msg-sending');
      bubble.classList.add('msg-failed');
      bubble.title = t('send.failedTip', { error: e.message });
      bubble.addEventListener('click', () => {
        els.msgInput.value = sentText;
        els.msgInput.focus();
        bubble.remove();
      }, { once: true });
    }
  });

  els.msgInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      els.sendForm.requestSubmit();
    }
  });

  // [需求@2026-06-13 §17] 流式渲染开关
  if (els.streamingToggle) {
    els.streamingToggle.checked = state.streamingEnabled;
    els.streamingToggle.addEventListener('change', () => {
      state.streamingEnabled = els.streamingToggle.checked;
      localStorage.setItem('mate.streaming', state.streamingEnabled ? 'on' : 'off');
      // 切到 off 时清理任何活的 streaming bubble(没 final 收尾就清了)
      if (!state.streamingEnabled) {
        for (const [slug, s] of state.streamingAssistants) {
          if (s.el && s.el.isConnected) s.el.remove();
        }
        state.streamingAssistants.clear();
      }
    });
  }

  // i18n 语言切换
  if (els.langBtn && window.MateI18n) {
    applyLangBtnLabel();
    els.langBtn.addEventListener('click', () => {
      const cur = window.MateI18n.getLang();
      window.MateI18n.setLang(cur === 'zh' ? 'en' : 'zh');
    });
    window.MateI18n.onChange(() => {
      applyLangBtnLabel();
      // 重新渲染动态产生的 UI(threads list, conv header, busy state)
      renderThreads();
      renderConvHeader();
      applyBusyUiState();
    });
  }
}

// [需求@2026-06-16 B3] 全文检索 — 顶栏搜索框 → /api/search → 结果 popover
let searchDebounce = null;
function wireSearch() {
  if (!els.searchInput) return;
  els.searchInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    const q = els.searchInput.value.trim();
    if (!q) { els.searchResults.hidden = true; els.searchResults.innerHTML = ''; return; }
    searchDebounce = setTimeout(() => doSearch(q), 300);
  });
  els.searchInput.addEventListener('focus', () => {
    if (els.searchResults.children.length) els.searchResults.hidden = false;
  });
  // 外部点击关闭
  document.addEventListener('click', (ev) => {
    if (els.searchResults.hidden) return;
    if (els.searchResults.contains(ev.target) || els.searchInput === ev.target) return;
    els.searchResults.hidden = true;
  });
}

async function doSearch(q) {
  try {
    // 默认当前 project;按需可加全局选项
    const url = `/api/search?q=${encodeURIComponent(q)}&projectId=${state.activeProjectId}&limit=30`;
    const rows = await api(url);
    renderSearchResults(rows, q);
  } catch (e) {
    els.searchResults.innerHTML = `<div class="sr-error">${escapeHtml(e.message)}</div>`;
    els.searchResults.hidden = false;
  }
}

function renderSearchResults(rows, q) {
  if (!rows.length) {
    els.searchResults.innerHTML = `<div class="sr-empty">${escapeHtml(t('search.empty'))}</div>`;
    els.searchResults.hidden = false;
    return;
  }
  const head = `<div class="sr-head">${escapeHtml(t('search.resultCount', { n: rows.length }))}</div>`;
  const body = rows.map((r) => {
    const ts = new Date(r.ts);
    const time = `${ts.getMonth()+1}-${ts.getDate()} ${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}`;
    const sub = t('search.resultRow', {
      thread: escapeHtml(r.threadTitle || r.threadSlug || '-'),
      role: escapeHtml(r.roleName || r.eventType || '-'),
      time,
    });
    // r.snippet 可能含 <mark> 高亮 — 不转义内层 mark,但其它 HTML 要 escape
    //   snippet 来自 FTS5 snippet(),格式安全;LIKE fallback 走纯文本要 escape
    const safeSnippet = (r.snippet || '').replace(/<(?!\/?mark>)/g, '&lt;').slice(0, 240);
    return `<div class="sr-row" data-slug="${escapeHtml(r.threadSlug || '')}" data-pid="${r.projectId}">
      <div class="sr-meta">${sub}</div>
      <div class="sr-snippet">${safeSnippet}</div>
    </div>`;
  }).join('');
  els.searchResults.innerHTML = head + body;
  els.searchResults.hidden = false;
  els.searchResults.querySelectorAll('.sr-row').forEach((row) => {
    row.addEventListener('click', () => {
      const slug = row.dataset.slug;
      const pid = parseInt(row.dataset.pid, 10);
      if (!slug) return;
      els.searchResults.hidden = true;
      els.searchInput.value = '';
      // 如果不同 project 要先切
      if (pid !== state.activeProjectId) {
        state.activeProjectId = pid;
        localStorage.setItem(LS_KEY, String(pid));
        els.projectPicker.value = String(pid);
        reloadProjectScopedData().then(() => focusThread(slug));
      } else {
        focusThread(slug);
      }
    });
  });
}

init().then(() => wireSearch()).catch((e) => {
  console.error('init failed:', e);
  document.body.innerHTML = `<div style="padding:40px;color:#f88">init failed: ${e.message}</div>`;
});
