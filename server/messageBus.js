// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L0 Infrastructure
// 责任:进程内 pub/sub(EventEmitter wrapper)
// 公共 API:单例 `bus` + `publish(topic, payload)` + `subscribe(topic, handler)`
//   + `on('*')` 收所有事件(供 ws fan-out 用)
// 允许依赖:仅 node:events
// 禁止:
//   - 持久化(不存事件,不缓存订阅 ack)
//   - 业务过滤(client 自己 filter)
//   - 不允许跨进程(单进程 only,跨进程在 L4 ws 层做 fan-out)
// ============================================================================
// In-process pub/sub. WebSocket layer subscribes and selectively pushes to FE.
const { EventEmitter } = require('node:events');

class MessageBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }
  publish(topic, payload) {
    this.emit(topic, payload);
    this.emit('*', { topic, payload });
  }
  subscribe(topic, handler) {
    this.on(topic, handler);
    return () => this.off(topic, handler);
  }
}

module.exports = new MessageBus();
