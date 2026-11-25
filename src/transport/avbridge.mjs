import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AUTH_HEADER, NONCE_HEADER, SESSION_HEADER, isToken, signResponse, verifyRequest } from './auth.mjs';

const BODY_LIMIT = 16 * 1024 * 1024;
const NONCE_WINDOW_MS = 60000;
const MAX_NONCES = 4096;
const OPERATIONS = new Set(['ping', 'tabs.list', 'tabs.current', 'tabs.create', 'tabs.close', 'tabs.preserve', 'tabs.update', 'debugger.send', 'debugger.detachAll']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class AvBridge {
  constructor(port = 9335, { token } = {}) {
    this.port = port;
    this.token = token;
    this.server = null;
    this.queue = [];
    this.pullers = [];
    this.waiting = new Map();
    this.info = null;
    this.closed = false;
    this.peerSession = null;
    this.nonces = new Map();
    this.startTimer = null;
    this.openingServer = null;
    this.startPromise = null;
    this.startReject = null;
    this.health = { received_requests: 0, authenticated_requests: 0, authentication_rejections: 0, origin_rejections: 0, peer_conflicts: 0 };
  }

  diagnostics() {
    return { ...this.health, port: this.port, peer_bound: !!this.peerSession,
      waiting_jobs: this.waiting.size, queued_jobs: this.queue.length };
  }

  start() {
    if (this.closed) return Promise.reject(new Error('bridge closed'));
    if (!isToken(this.token)) return Promise.reject(new Error('Bridge is not paired; run init'));
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      this.startReject = reject;
      let tries = 0;
      const attempt = () => {
        this.startTimer = null;
        if (this.closed) { reject(new Error('bridge closed')); return; }
        const server = createServer((req, res) => {
          this._handle(req, res).catch(() => {
            this._respond(req, res, 500, { error: 'bridge request failed' });
          });
        });
        this.openingServer = server;
        server.once('error', error => {
          try { server.close(); } catch {}
          if (this.openingServer === server) this.openingServer = null;
          if (this.closed) { reject(new Error('bridge closed')); return; }
          if (error.code === 'EADDRINUSE' && tries++ < 12) this.startTimer = setTimeout(attempt, 180);
          else reject(error);
        });
        server.listen(this.port, '127.0.0.1', () => {
          if (this.closed) { try { server.close(); } catch {} reject(new Error('bridge closed')); return; }
          this.openingServer = null;
          this.server = server;
          this.port = server.address().port;
          this.startReject = null;
          resolve(this);
        });
      };
      attempt();
    });
    return this.startPromise;
  }

  _respond(req, res, status, value) {
    if (res.destroyed || res.writableEnded) return false;
    const body = JSON.stringify(value);
    const origin = req.headers.origin;
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    if (origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      headers['access-control-allow-origin'] = origin;
      headers.vary = 'Origin';
      headers['access-control-expose-headers'] = AUTH_HEADER;
    }
    if (req.avAuth) headers[AUTH_HEADER] = signResponse(this.token, req.avAuth.nonce, status, body, req.avAuth.session);
    try { res.writeHead(status, headers); res.end(body); return true; } catch { return false; }
  }

  _authenticate(req, body) {
    const nonce = req.headers[NONCE_HEADER];
    const session = req.headers[SESSION_HEADER];
    const signature = req.headers[AUTH_HEADER];
    if (typeof nonce !== 'string' || !/^\d{13}\.[0-9a-f-]{36}$/i.test(nonce)
      || typeof session !== 'string' || !/^[0-9a-f-]{36}$/i.test(session)) return false;
    if (!verifyRequest(this.token, req.method, req.url, nonce, body, session, signature)) return false;
    req.avAuth = { nonce, session };
    const now = Date.now();
    const timestamp = Number(nonce.split('.')[0]);
    if (Math.abs(now - timestamp) > NONCE_WINDOW_MS || this.nonces.has(nonce)) return false;
    for (const [previous, expires] of this.nonces) if (expires <= now) this.nonces.delete(previous);
    if (this.nonces.size >= MAX_NONCES) return false;
    this.nonces.set(nonce, now + NONCE_WINDOW_MS);
    return true;
  }

  async _handle(req, res) {
    this.health.received_requests++;
    const origin = req.headers.origin;
    if ((origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))
      || !/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '')
      || !['GET', 'POST', 'OPTIONS'].includes(req.method)) {
      this.health.origin_rejections++;
      this._respond(req, res, 403, { error: 'forbidden' }); return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
        'access-control-allow-methods': 'GET,POST',
        'access-control-allow-headers': 'content-type,x-av-auth,x-av-nonce,x-av-session',
        'access-control-max-age': '600',
      });
      res.end(); return;
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > BODY_LIMIT) { this._respond(req, res, 413, { error: 'request too large' }); return; }
        chunks.push(bytes);
      }
    } catch {
      this._respond(req, res, 400, { error: 'incomplete request' }); return;
    }
    const body = Buffer.concat(chunks, size).toString('utf8');
    if (!this._authenticate(req, body)) {
      this.health.authentication_rejections++;
      this._respond(req, res, 403, { error: 'bridge authentication failed' }); return;
    }
    this.health.authenticated_requests++;
    if (this.closed) { this._respond(req, res, 503, { error: 'bridge closed' }); return; }
    if (this.peerSession && this.peerSession !== req.avAuth.session) {
      this.health.peer_conflicts++;
      this._respond(req, res, 409, { error: 'bridge is bound to another browser session' }); return;
    }
    if (!['/ping', '/pull', '/push'].includes(req.url)) { this._respond(req, res, 404, { error: 'not found' }); return; }
    if ((req.url === '/push' && req.method !== 'POST')
      || (req.url !== '/push' && req.method !== 'GET')) {
      this._respond(req, res, 405, { error: 'method not allowed' }); return;
    }
    if (req.method === 'GET' && body) { this._respond(req, res, 400, { error: 'GET body is not allowed' }); return; }
    if (req.url === '/ping') {
      const info = this.info || {};
      this._respond(req, res, 200, {
        ok: true, paired: this.pullers.length > 0, info: this.info,
        extension: info.extension || null, version: info.version || null,
        attached: info.attached || [], bridge_port: this.port,
        session_id: this.peerSession,
      });
      return;
    }
    if (req.url === '/pull') {
      if (!this.peerSession) this.peerSession = req.avAuth.session;
      if (this.queue.length) {
        const job = this.queue.shift();
        if (this._respond(req, res, 200, job)) {
          const waiting = this.waiting.get(job.id);
          if (waiting) waiting.delivered = true;
        }
        return;
      }
      if (this.pullers.length >= 32) { this._respond(req, res, 429, { error: 'too many pullers' }); return; }
      const puller = { req, res, timer: null };
      const remove = () => {
        clearTimeout(puller.timer);
        const index = this.pullers.indexOf(puller);
        if (index >= 0) this.pullers.splice(index, 1);
      };
      puller.timer = setTimeout(() => { remove(); this._respond(req, res, 200, {}); }, 20000);
      this.pullers.push(puller);
      res.once('close', remove);
      return;
    }
    let out;
    try { out = JSON.parse(body); } catch {
      this._respond(req, res, 400, { error: 'invalid JSON' }); return;
    }
    if (!isRecord(out) || typeof out.id !== 'string' || typeof out.ok !== 'boolean'
      || (out.ok && !Object.hasOwn(out, 'result'))
      || (!out.ok && typeof out.error !== 'string')) {
      this._respond(req, res, 400, { error: 'invalid job response' }); return;
    }
    const waiting = this.waiting.get(out.id);
    if (waiting) {
      this.waiting.delete(out.id);
      waiting.call(out);
    }
    this._respond(req, res, 200, { ok: true, accepted: !!waiting });
  }

  job(op, args = {}, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(new Error('bridge closed'));
    if (!OPERATIONS.has(op) || !isRecord(args)) return Promise.reject(new Error('invalid bridge job'));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('invalid bridge timeout'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const delivered = !!this.waiting.get(id)?.delivered;
        this.waiting.delete(id);
        this.queue = this.queue.filter(job => job.id !== id);
        const error = new Error(delivered ? 'bridge job timeout; dispatched outcome may be unknown: ' + op
          : 'bridge job timeout; no task delivered to extension: ' + op);
        error.code = delivered ? 'AV_BRIDGE_RESULT_UNKNOWN' : 'AV_BRIDGE_PEER_UNAVAILABLE';
        error.delivered = delivered;
        error.diagnostics = this.diagnostics();
        reject(error);
      }, timeoutMs);
      this.waiting.set(id, {
        timer, reject, delivered: false,
        call: out => {
          clearTimeout(timer);
          if (out.ok) {
            if (op === 'ping' && isRecord(out.result)) this.info = out.result;
            resolve(out.result);
          } else reject(new Error(out.error || ('job failed: ' + op)));
        },
      });
      this._deliver({ id, op, args, expires_at: Date.now() + timeoutMs });
    });
  }

  _deliver(job) {
    while (this.pullers.length) {
      const puller = this.pullers.shift();
      clearTimeout(puller.timer);
      if (this._respond(puller.req, puller.res, 200, job)) {
        const waiting = this.waiting.get(job.id);
        if (waiting) waiting.delivered = true;
        return;
      }
    }
    this.queue.push(job);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.startTimer);
    if (this.startReject) { this.startReject(new Error('bridge closed')); this.startReject = null; }
    for (const waiting of this.waiting.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('bridge closed')); }
    this.waiting.clear();
    this.queue.length = 0;
    for (const puller of this.pullers) { clearTimeout(puller.timer); this._respond(puller.req, puller.res, 200, {}); }
    this.pullers.length = 0;
    this.nonces.clear();
    for (const server of [this.openingServer, this.server]) {
      if (!server) continue;
      try { server.closeAllConnections?.(); } catch {}
      try { server.close(); } catch {}
    }
    this.openingServer = null;
    this.server = null;
  }
}
