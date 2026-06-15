// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L6 Frontend / 组件
// 责任:顶栏实时运行态 chip + 4 列 swimlane popover(挂 #runtime-chip-mount)
// 公共 API:window.RuntimeChip = { init({projectId}) / setProjectId(id) /
//   refresh / showPopover / hidePopover }
// 允许依赖:仅浏览器 API + fetch(/api/runtime/...) + WebSocket /ws
// 禁止:
//   - 直接 require/import server 模块(违反 L6 → L4 only)
//   - 修改 mate 业务状态(只展示;quota override 也走 POST endpoint)
//   - 跨页面共享 state(每个挂载点独立 init)
// ============================================================================
//
// [需求@2026-06-12 Phase 2E §14] 顶栏实时运行态 chip + popover
//
// 自包含组件。挂载点 #runtime-chip-mount。
//
// chip 显示:
//   [N idle · busy: [T1] [T2]] [排队:N] [5h:91%↘19:30]
//   busy TERM 闪烁(0.5s/周期)
//   quota 只显最危;两轨都低绿压缩
//
// popover(点击 chip 展开):4 列 swimlane(R/H/B/C),每列 idle/busy/disconnected
//
// 数据源:
//   1. fetch /api/runtime/snapshot?projectId=N(全量)
//   2. WS 增量:instance.status_change / spawned / exited /
//      system.quota_update / quota_paused / quota_resumed / cap_warn
//
// 暴露全局 RuntimeChip 对象:
//   - init(): 初始化挂载 + 启动数据流
//   - setProjectId(id): 主视图切 project 时调
//   - refresh(): 主动刷新
//   - showPopover() / hidePopover()
//
// 设计:不依赖 app.js / dashboard.js,可单独跑。WS 连接自管理。

(function () {
  const POLL_INTERVAL_MS = 30 * 1000;  // 30s 兜底
  const QUOTA_DANGER_RED = 0.95;
  const QUOTA_WARN_YELLOW = 0.6;

  // ---------------- i18n helper ----------------
  const t = (key, params) => (window.MateI18n ? window.MateI18n.t(key, params) : key);

  const state = {
    projectId: null,    // null = 全局视图(dashboard 用),number = 当前 project
    snapshot: null,
    pollTimer: null,
    popoverOpen: false,
    mountEl: null,
    chipEl: null,
    popoverEl: null,
  };

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(e.style, attrs[k]);
      else if (attrs[k] === true) e.setAttribute(k, '');
      else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
    for (const c of children) {
      if (c == null) continue;
      if (typeof c === 'string' || typeof c === 'number') e.appendChild(document.createTextNode(String(c)));
      else if (Array.isArray(c)) c.forEach((x) => x && e.appendChild(x));
      else e.appendChild(c);
    }
    return e;
  }

  function fmtTime(unixMs) {
    if (!unixMs) return '—';
    const d = new Date(unixMs);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function fmtAgo(ts) {
    if (!ts) return '';
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }

  // 选择最危的 quota 一轨(给 chip 紧凑显示)
  function pickHottestQuota(q) {
    if (!q) return null;
    const ents = [q.five_hour, q.seven_day].filter(Boolean);
    if (!ents.length) return null;
    // 优先 paused → 优先 util 高
    ents.sort((a, b) => {
      if (a.paused !== b.paused) return a.paused ? -1 : 1;
      return (b.utilization || 0) - (a.utilization || 0);
    });
    return ents[0];
  }

  function quotaColorClass(util) {
    if (util == null) return 'quota-ok';
    if (util >= QUOTA_DANGER_RED) return 'quota-danger';
    if (util >= QUOTA_WARN_YELLOW) return 'quota-warn';
    return 'quota-ok';
  }

  // ---------------- chip render ----------------

  function renderChip() {
    if (!state.chipEl) return;
    state.chipEl.setAttribute('title', t('chip.title'));
    const snap = state.snapshot;
    if (!snap) {
      state.chipEl.innerHTML = `<span class="rc-loading">${escapeHtml(t('chip.loading'))}</span>`;
      return;
    }
    const counts = snap.counts || {};
    const busyInsts = snap.instances?.busy || [];
    const spawningInsts = snap.instances?.spawning || [];

    // busy TERM chips (含 spawning)
    const activeTerms = [...busyInsts.map((i) => ({ ...i, _kind: 'busy' })),
                        ...spawningInsts.map((i) => ({ ...i, _kind: 'spawning' }))];
    const termChips = activeTerms.length
      ? activeTerms.map((i) => {
          const titleParts = [
            `${i.displayName}`,
            i.threadSlug ? t('chip.thread', { slug: i.threadSlug }) : t('chip.unbound'),
            i.currentModel ? t('chip.model', { model: i.currentModel }) : '',
            i.currentActivity ? t('chip.recentActivity', { act: i.currentActivity }) : '',
            `${fmtAgo(i.lastActiveAt)}`,
          ].filter(Boolean).join('\n');
          // [需求@2026-06-13 §14] chip inline 显近活提示 — busy 实例后面带 "· 🔧 Grep" 之类,
          //   让 user 不 hover 也能看到此刻 term 在干什么。截 ~20 字防 chip 撑爆。
          let actInline = '';
          if (i.currentActivity) {
            const a = i.currentActivity.length > 20 ? i.currentActivity.slice(0, 20) + '…' : i.currentActivity;
            actInline = ` · ${a}`;
          }
          return `<span class="rc-term rc-term-${i._kind}" title="${escapeHtml(titleParts)}">${escapeHtml(i.displayName)}<span class="rc-term-act">${escapeHtml(actInline)}</span></span>`;
        }).join('')
      : `<span class="rc-no-busy">${escapeHtml(t('chip.noBusy'))}</span>`;

    // pending
    const pendingTotal = snap.pending?.total || 0;
    const pendingClass = pendingTotal > 0 ? 'rc-pending-has' : 'rc-pending-none';

    // quota
    const hot = pickHottestQuota(snap.quota);
    let quotaHtml = '';
    if (hot) {
      const util = hot.utilization;
      const reset = fmtTime(hot.resetsAt);
      const cls = quotaColorClass(util);
      const pausedMark = hot.paused ? ' ⏸' : '';
      const typeLabel = hot.type === 'five_hour' ? '5h' : '7d';
      const utilStr = util != null ? `${Math.round(util * 100)}%` : '?';
      quotaHtml = `<span class="rc-quota ${cls}" title="${escapeHtml(JSON.stringify(snap.quota))}">${typeLabel}:${utilStr}${pausedMark}↘${reset}</span>`;
    } else {
      quotaHtml = `<span class="rc-quota quota-ok">${escapeHtml(t('chip.quotaOk'))}</span>`;
    }

    // cap (atCap 时红色)
    const cap = snap.cap || {};
    const capClass = cap.atCap ? 'rc-cap rc-cap-warn' : 'rc-cap';
    const capHtml = `<span class="${capClass}" title="${escapeHtml(t('chip.capTip', { alive: cap.alive, cap: cap.cap }))}">${cap.alive}/${cap.cap}</span>`;

    // chip 主体
    state.chipEl.innerHTML = `
      <span class="rc-counts">${counts.idle || 0} ${escapeHtml(t('chip.idle'))}</span>
      <span class="rc-sep">${escapeHtml(t('chip.sep'))}</span>
      <span class="rc-busy-label">${escapeHtml(t('chip.busyLabel'))}</span>
      <span class="rc-terms">${termChips}</span>
      <span class="rc-pending ${pendingClass}" title="${escapeHtml(t('chip.pendingTip'))}">${escapeHtml(t('chip.pending', { n: pendingTotal }))}</span>
      ${quotaHtml}
      ${capHtml}
    `;
  }

  function escapeHtml(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------- popover ----------------

  function ensurePopover() {
    if (state.popoverEl) return state.popoverEl;
    const p = el('div', { class: 'runtime-popover', id: 'runtime-popover' });
    document.body.appendChild(p);
    state.popoverEl = p;
    return p;
  }

  function renderPopover() {
    const p = ensurePopover();
    const snap = state.snapshot;
    if (!snap) { p.innerHTML = `<div class="rp-loading">${escapeHtml(t('popover.loading'))}</div>`; return; }

    // 4 列 by roleType
    const byType = { requirements: [], orchestrator: [], executor: [], validator: [] };
    const allInsts = [
      ...(snap.instances.busy || []),
      ...(snap.instances.idle || []),
      ...(snap.instances.spawning || []),
      ...(snap.instances.disconnected || []),
    ];
    for (const i of allInsts) {
      const t = i.roleType;
      if (!byType[t]) byType[t] = [];
      byType[t].push(i);
    }

    const cols = [
      { type: 'requirements', label: t('popover.col.r') },
      { type: 'orchestrator', label: t('popover.col.h') },
      { type: 'executor',     label: t('popover.col.b') },
      { type: 'validator',    label: t('popover.col.c') },
    ];

    const projLabel = snap.project
      ? escapeHtml(t('popover.project', { name: snap.project.name }))
      : escapeHtml(t('popover.globalView'));
    let html = `<div class="rp-header"><div>${projLabel}</div>`;
    if (snap.quota?.paused) {
      html += `<button class="rp-quota-override" type="button">${escapeHtml(t('popover.quotaOverride'))}</button>`;
    }
    html += `</div>`;
    html += `<div class="rp-cols">`;
    for (const col of cols) {
      const items = byType[col.type] || [];
      const live = items.filter((i) => i.status !== 'disconnected');
      const disc = items.filter((i) => i.status === 'disconnected');
      html += `<div class="rp-col"><h4>${escapeHtml(col.label)}</h4>`;
      if (live.length === 0) html += `<div class="rp-empty">${escapeHtml(t('popover.colEmpty'))}</div>`;
      for (const i of live) {
        const blink = i.status === 'busy' ? ' rp-blink' : '';
        const statusBadge = `<span class="rp-status rp-status-${i.status}">${i.status}</span>`;
        const modelStr = i.currentModel ? `<div class="rp-model">${escapeHtml(i.currentModel)}</div>` : '';
        const taskStr = i.threadSlug ? `<div class="rp-task">@ ${escapeHtml(i.threadSlug)}</div>` : '';
        const actStr = i.currentActivity ? `<div class="rp-act">${escapeHtml(i.currentActivity)}</div>` : '';
        const agoStr = `<div class="rp-ago">${escapeHtml(fmtAgo(i.lastActiveAt))}</div>`;
        html += `<div class="rp-inst${blink}">
          <div class="rp-inst-head">${statusBadge} <span class="rp-name">${escapeHtml(i.displayName)}</span></div>
          ${taskStr}${actStr}${modelStr}${agoStr}
        </div>`;
      }
      if (disc.length) {
        html += `<div class="rp-disc-header">${escapeHtml(t('popover.discHeader', { n: disc.length }))}</div>`;
        for (const i of disc.slice(0, 5)) {
          html += `<div class="rp-inst rp-inst-disc">
            <div class="rp-inst-head"><span class="rp-status rp-status-disconnected">disc</span> <span class="rp-name">${escapeHtml(i.displayName)}</span></div>
            ${i.currentModel ? `<div class="rp-model">${escapeHtml(i.currentModel)}</div>` : ''}
            <div class="rp-ago">${escapeHtml(fmtAgo(i.lastActiveAt))}</div>
          </div>`;
        }
        if (disc.length > 5) html += `<div class="rp-more">${escapeHtml(t('popover.moreOlder', { n: disc.length - 5 }))}</div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;

    // 排队详情
    if (snap.pending?.total > 0) {
      html += `<div class="rp-pending-section">
        <h4>${escapeHtml(t('popover.pendingHeader', { n: snap.pending.total }))}</h4>`;
      for (const it of (snap.pending.byTarget || []).slice(0, 10)) {
        // popover.pendingItem 含 <code> — 用 raw replace 保留 HTML
        const itemHtml = t('popover.pendingItem')
          .replace('{kind}', escapeHtml(it.targetKind))
          .replace('{id}', `<code>${escapeHtml(it.targetId)}</code>`)
          .replace('{n}', String(it.n));
        html += `<div class="rp-pending-item">${itemHtml}</div>`;
      }
      html += `</div>`;
    }

    p.innerHTML = html;

    // 解除暂停按钮 binding
    const ovBtn = p.querySelector('.rp-quota-override');
    if (ovBtn) {
      ovBtn.addEventListener('click', async () => {
        if (!confirm(t('popover.quotaOverrideConfirm'))) return;
        try {
          await fetch('/api/runtime/quota/override', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          refresh();
        } catch (e) { alert(t('popover.quotaOverrideFailed', { error: e.message })); }
      });
    }
  }

  function showPopover() {
    state.popoverOpen = true;
    renderPopover();
    positionPopover();
    state.popoverEl.classList.add('open');
  }

  function hidePopover() {
    state.popoverOpen = false;
    if (state.popoverEl) state.popoverEl.classList.remove('open');
  }

  function positionPopover() {
    if (!state.chipEl || !state.popoverEl) return;
    const rect = state.chipEl.getBoundingClientRect();
    state.popoverEl.style.top = `${rect.bottom + 8}px`;
    state.popoverEl.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  }

  // ---------------- data flow ----------------

  async function refresh() {
    try {
      const url = state.projectId
        ? `/api/runtime/snapshot?projectId=${encodeURIComponent(state.projectId)}`
        : '/api/runtime/snapshot';
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      state.snapshot = await r.json();
      renderChip();
      if (state.popoverOpen) renderPopover();
    } catch (e) {
      console.warn('[runtime-chip] refresh failed:', e.message);
    }
  }

  // [arch §9 ✅] 通过 MateWS 单例订阅;不再自建 WebSocket
  function setupWS() {
    if (!window.MateWS) {
      console.warn('[runtime-chip] MateWS not loaded — check script order in HTML');
      return;
    }
    const INTERESTING = [
      'instance.spawned', 'instance.status_change', 'instance.exited',
      'system.cap_warn', 'system.quota_update', 'system.quota_paused', 'system.quota_resumed',
      'instance.ttl_soon', 'instance.ttl_expired',
    ];
    for (const topic of INTERESTING) {
      window.MateWS.subscribe(topic, () => scheduleRefresh());
    }
    // 重连成功后强制刷一次(可能错过事件)
    window.MateWS.onConnected(() => scheduleRefresh());
  }

  let refreshDebounce = null;
  function scheduleRefresh() {
    if (refreshDebounce) clearTimeout(refreshDebounce);
    refreshDebounce = setTimeout(() => { refreshDebounce = null; refresh(); }, 200);
  }

  // ---------------- public API ----------------

  function init({ projectId = null } = {}) {
    state.projectId = projectId;
    state.mountEl = document.getElementById('runtime-chip-mount');
    if (!state.mountEl) {
      console.warn('[runtime-chip] mount point #runtime-chip-mount not found');
      return;
    }
    // build chip element
    state.chipEl = el('div', { class: 'runtime-chip', title: t('chip.title') });
    state.chipEl.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (state.popoverOpen) hidePopover();
      else showPopover();
    });
    state.mountEl.appendChild(state.chipEl);

    // 外部点击关闭 popover
    document.addEventListener('click', (ev) => {
      if (!state.popoverOpen) return;
      if (state.popoverEl && state.popoverEl.contains(ev.target)) return;
      hidePopover();
    });
    window.addEventListener('resize', () => state.popoverOpen && positionPopover());
    window.addEventListener('scroll', () => state.popoverOpen && positionPopover());

    setupWS();
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(refresh, POLL_INTERVAL_MS);

    // 语言切换 → 重渲 chip + popover
    if (window.MateI18n) {
      window.MateI18n.onChange(() => {
        renderChip();
        if (state.popoverOpen) renderPopover();
      });
    }

    refresh();
  }

  function setProjectId(id) {
    if (state.projectId === id) return;
    state.projectId = id;
    refresh();
  }

  window.RuntimeChip = { init, setProjectId, refresh, showPopover, hidePopover };
})();
