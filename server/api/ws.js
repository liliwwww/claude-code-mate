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
