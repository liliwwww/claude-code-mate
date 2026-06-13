// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L4 API Surface
// 责任:bus.publish 事件 → 所有连接的 WS client(client 自己过滤)
// 公共 API:attach(httpServer)
// 允许依赖:messageBus / ws
// 禁止:
//   - 后端过滤(client 自己决定要不要渲染)
//   - 缓存(消息丢就丢,前端 30s 兜底 fetch)
//   - 双向 RPC(只 fan-out,不接收 client 指令)
// ============================================================================
//
// WebSocket push. Server-side fan-out from messageBus to all connected clients.
// Phase 1: no subscriptions/filtering — every client gets every event.

const { WebSocketServer } = require('ws');
const bus = require('../messageBus');

function attach(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  const send = (ws, type, payload) => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify({ type, payload, ts: Date.now() }));
    } catch (e) {
      console.warn('[ws] send failed:', e.message);
    }
  };

  // Subscribe once to bus, broadcast to all sockets.
  bus.on('*', ({ topic, payload }) => {
    for (const ws of wss.clients) send(ws, topic, payload);
  });

  wss.on('connection', (ws) => {
    send(ws, 'system.hello', { msg: 'connected' });
    ws.on('message', (raw) => {
      // Client-to-server commands could go here later; Phase 1 ignores.
    });
  });

  return wss;
}

module.exports = { attach };
