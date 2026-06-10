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
