export class CommandQueue {
  constructor({ idleMs = 0, onIdle = () => {} } = {}) {
    this.tail = Promise.resolve();
    this.pending = 0;
    this.idleMs = idleMs;
    this.onIdle = onIdle;
    this.armIdle();
  }

  armIdle() {
    clearTimeout(this.timer);
    if (!this.closed && !this.pending && this.idleMs) this.timer = setTimeout(this.onIdle, this.idleMs);
  }

  run(operation) {
    if (this.closed) return Promise.reject(new Error('command queue closed'));
    this.pending++;
    clearTimeout(this.timer);
    const result = this.tail.then(() => {
      if (this.closed) throw new Error('command queue closed');
      return operation();
    });
    this.tail = result.catch(() => {}).finally(() => { this.pending--; this.armIdle(); });
    return result;
  }

  close() { this.closed = true; clearTimeout(this.timer); }
}
