export class CDP {
  constructor(socket, timeoutMs = 30000) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.closed = false;
    this.sequence = 0;
    this.pending = new Map();
    this.onMessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (message.method === 'Runtime.executionContextsCleared' || message.method === 'Runtime.executionContextDestroyed') this.__contextId = null;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    };
    this.onDisconnect = () => this.dispose(new Error('CDP connection closed'));
    socket.addEventListener('message', this.onMessage);
    socket.addEventListener('close', this.onDisconnect);
    socket.addEventListener('error', this.onDisconnect);
  }

  send(method, params = {}) {
    if (this.closed || typeof this.socket.readyState === 'number' && this.socket.readyState !== 1) {
      this.dispose(new Error('CDP connection closed'));
      return Promise.reject(new Error('CDP connection closed'));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(method + ' timeout; dispatched outcome is unknown');
        error.code = 'AV_CDP_RESULT_UNKNOWN';
        error.delivered = true;
        reject(error);
      }, this.timeoutMs);
      const pending = { resolve, reject, timer, dispatched: false };
      this.pending.set(id, pending);
      try { this.socket.send(JSON.stringify({ id, method, params })); pending.dispatched = true; }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  dispose(error = new Error('CDP connection disposed')) {
    if (this.closed) return;
    this.closed = true;
    this.__contextId = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      const outcome = new Error(error.message);
      if (pending.dispatched) { outcome.code = 'AV_CDP_RESULT_UNKNOWN'; outcome.delivered = true; }
      pending.reject(outcome);
    }
    this.pending.clear();
    this.socket.removeEventListener('message', this.onMessage);
    this.socket.removeEventListener('close', this.onDisconnect);
    this.socket.removeEventListener('error', this.onDisconnect);
  }
}
