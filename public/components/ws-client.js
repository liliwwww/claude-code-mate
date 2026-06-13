// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L6 Frontend / 组件
// 责任:**单例** WebSocket 客户端,所有页面 / 组件共用一条到 /ws 的连接;
//   提供 topic-based + catch-all 订阅;自动重连(exponential backoff,
//   max 30s);page hidden 时暂停 reconnect。
// 公共 API(挂 window.MateWS):
//   subscribe(topic, handler) → unsubscribe()        — 按 topic 过滤
//   subscribeAll(handler)     → unsubscribe()        — 收所有事件
//   onConnected(cb)           → off()                — 连接建立
//   onDisconnected(cb)        → off()                — 断开
//   isConnected() → boolean
// 允许依赖:无(纯浏览器 API)
// 禁止:
//   - 业务过滤(订阅者自己决定要不要处理某 topic)
//   - 持久化离线事件(WS 断开期间消息丢就丢,subscriber 自行 30s fetch 兜底)
//   - 多实例(全 page 必须共用,避免 N 个 connection)
// ============================================================================

(function () {
  if (window.MateWS) return; // 防重复加载

  const MAX_BACKOFF_MS = 30 * 1000;
  const MIN_BACKOFF_MS = 2 * 1000;

  const state = {
    ws: null,
    backoffMs: MIN_BACKOFF_MS,
    reconnectTimer: null,
    paused: false,                     // page hidden 时 true,visible 后重连
    topicSubs: new Map(),              // topic → Set<handler>
    allSubs: new Set(),                // handlers 收所有事件
    connHandlers: new Set(),
    disconnHandlers: new Set(),
    connected: false,
  };

  function url() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  function connect() {
    if (state.paused) return;
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
    try {
      state.ws = new WebSocket(url());
    } catch (e) {
      console.warn('[MateWS] WebSocket constructor failed:', e.message);
      scheduleReconnect();
      return;
    }
    state.ws.addEventListener('open', onOpen);
    state.ws.addEventListener('message', onMessage);
    state.ws.addEventListener('close', onClose);
    state.ws.addEventListener('error', onError);
  }

  function onOpen() {
    state.connected = true;
    state.backoffMs = MIN_BACKOFF_MS;
    for (const cb of state.connHandlers) {
      try { cb(); } catch (e) { console.warn('[MateWS] onConnected handler error:', e); }
    }
  }

  function onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    // catch-all
    for (const h of state.allSubs) {
      try { h(msg); } catch (e) { console.warn('[MateWS] subscribeAll handler error:', e); }
    }
    // topic filter
    const handlers = state.topicSubs.get(msg.type);
    if (handlers) {
      for (const h of handlers) {
        try { h(msg); } catch (e) { console.warn(`[MateWS] subscribe(${msg.type}) handler error:`, e); }
      }
    }
  }

  function onClose() {
    state.connected = false;
    state.ws = null;
    for (const cb of state.disconnHandlers) {
      try { cb(); } catch (e) { console.warn('[MateWS] onDisconnected handler error:', e); }
    }
    scheduleReconnect();
  }

  function onError() {
    // 忽略 — close 会跟着触发,scheduleReconnect 在 onClose 里
  }

  function scheduleReconnect() {
    if (state.paused) return;
    if (state.reconnectTimer) return;
    const delay = state.backoffMs;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      // exponential backoff:每次失败翻倍,封顶
      state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
      connect();
    }, delay);
  }

  function subscribe(topic, handler) {
    if (typeof topic !== 'string' || typeof handler !== 'function') {
      throw new Error('MateWS.subscribe(topic: string, handler: fn)');
    }
    if (!state.topicSubs.has(topic)) state.topicSubs.set(topic, new Set());
    state.topicSubs.get(topic).add(handler);
    return () => {
      const set = state.topicSubs.get(topic);
      if (set) {
        set.delete(handler);
        if (set.size === 0) state.topicSubs.delete(topic);
      }
    };
  }

  function subscribeAll(handler) {
    if (typeof handler !== 'function') throw new Error('MateWS.subscribeAll(handler: fn)');
    state.allSubs.add(handler);
    return () => state.allSubs.delete(handler);
  }

  function onConnected(cb) {
    state.connHandlers.add(cb);
    if (state.connected) { try { cb(); } catch {} }
    return () => state.connHandlers.delete(cb);
  }

  function onDisconnected(cb) {
    state.disconnHandlers.add(cb);
    return () => state.disconnHandlers.delete(cb);
  }

  function isConnected() {
    return state.connected;
  }

  // page hidden → 暂停 reconnect;visible → 立刻 reconnect(如果当前 down)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      state.paused = true;
      if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    } else {
      state.paused = false;
      if (!state.connected) connect();
    }
  });

  window.MateWS = {
    subscribe,
    subscribeAll,
    onConnected,
    onDisconnected,
    isConnected,
  };

  // 立刻起一次连接
  connect();
})();
