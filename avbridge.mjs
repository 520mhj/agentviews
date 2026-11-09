import { createServer } from 'node:http';

// AgentView v10 — 进程内 loopback 桥（零依赖，只用 Node 内置 http）。
// 扩展（MV3 SW）作 HTTP 长轮询客户端：
//   GET  /pull  → 取一个 job（没有则挂起最多 20s，保持 SW 活跃）
//   POST /push  → 回传 job 结果
//   GET  /ping  → 存活/配对探测（popup / probe 用）
// CLI 侧 job(op,args) 把 job 放进队列并等 /push；命令结束即 close()，
// 不留下任何常驻后台进程。

export class AvBridge {
  constructor(port = 9335) {
    this.port = port;
    this.server = null;
    this.queue = [];
    this.pullers = [];
    this.waiting = new Map();
    this.idc = 0;
    this.info = null;
    this.closed = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = () => {
        const server = createServer((req, res) => { this._handle(req, res); });
        server.once('error', e => {
          try { server.close(); } catch { /* ignore */ }
          if (e.code === 'EADDRINUSE' && tries++ < 12) setTimeout(attempt, 180);
          else reject(e);
        });
        server.listen(this.port, '127.0.0.1', () => {
          this.server = server;
          resolve(this);
        });
      };
      attempt();
    });
  }

  async _handle(req, res) {
    const h = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };
    let body = '';
    try { for await (const c of req) body += c; } catch { /* ignore */ }
    if (req.url === '/ping') {
      res.writeHead(200, h);
      return res.end(JSON.stringify({ ok: true, paired: this.pullers.length > 0, info: this.info }));
    }
    if (req.url === '/pull') {
      if (this.queue.length) {
        res.writeHead(200, h);
        return res.end(JSON.stringify(this.queue.shift()));
      }
      const p = { res, timer: null };
      p.timer = setTimeout(() => {
        const i = this.pullers.indexOf(p);
        if (i >= 0) this.pullers.splice(i, 1);
        try { res.writeHead(200, h); res.end('{}'); } catch { /* ignore */ }
      }, 20000);
      this.pullers.push(p);
      return;
    }
    if (req.url === '/push') {
      let out = {};
      try { out = JSON.parse(body || '{}'); } catch { /* ignore */ }
      const w = this.waiting.get(out.id);
      if (w) { this.waiting.delete(out.id); w.call(out); }
      res.writeHead(200, h);
      return res.end('ok');
    }
    res.writeHead(404, h);
    res.end('{}');
  }

  job(op, args = {}, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(new Error('bridge closed'));
    const id = ++this.idc;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('bridge job timeout: ' + op));
      }, timeoutMs);
      this.waiting.set(id, {
        timer,
        call: (out) => {
          clearTimeout(timer);
          if (out.ok) resolve(out.result);
          else reject(new Error(out.error || ('job failed: ' + op)));
        }
      });
      this._deliver({ id, op, args });
    });
  }

  _deliver(job) {
    while (this.pullers.length) {
      const p = this.pullers.shift();
      clearTimeout(p.timer);
      try {
        p.res.writeHead(200, { 'content-type': 'application/json' });
        p.res.end(JSON.stringify(job));
        return;
      } catch { /* 连接已断，换下一个 puller */ }
    }
    this.queue.push(job);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [, w] of this.waiting) { clearTimeout(w.timer); }
    this.waiting.clear();
    for (const p of this.pullers) { clearTimeout(p.timer); try { p.res.end('{}'); } catch { /* ignore */ } }
    this.pullers.length = 0;
    if (this.server) {
      // 扩展的 /pull 是长连接，server.close() 会等它 drain；先强制掐断再关。
      try { this.server.closeAllConnections && this.server.closeAllConnections(); } catch { /* ignore */ }
      try { this.server.close(); } catch { /* ignore */ }
    }
  }
}
