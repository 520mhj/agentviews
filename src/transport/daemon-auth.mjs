import { randomUUID } from 'node:crypto';
import { isToken, createNonce, signRequest, verifyRequest, signResponse, verifyResponse } from './auth.mjs';

export class DaemonAuthenticator {
  constructor(token) {
    if (!isToken(token)) throw new Error('daemon 缺少有效鉴别凭据；先初始化或设置 AV_DAEMON_TOKEN');
    this.token = token;
    this.nonces = new Map();
  }

  authorize(request, body = '') {
    const nonce = request.headers['x-av-nonce'];
    const session = request.headers['x-av-session'];
    if (typeof nonce !== 'string' || !/^\d{13}\.[0-9a-f-]{36}$/i.test(nonce)
      || typeof session !== 'string' || !/^daemon-[0-9a-f-]{36}$/i.test(session)) return false;
    const now = Date.now();
    const timestamp = Number(nonce.split('.')[0]);
    if (Math.abs(now - timestamp) > 60000) return false;
    for (const [key, expiry] of this.nonces) if (expiry <= now) this.nonces.delete(key);
    if (this.nonces.has(nonce) || this.nonces.size >= 4096) return false;
    if (!verifyRequest(this.token, request.method, request.url, nonce, body, session, request.headers['x-av-auth'])) return false;
    this.nonces.set(nonce, now + 60000);
    request.avAuth = { nonce, session };
    return true;
  }

  respond(request, response, status, value) {
    if (response.destroyed || response.writableEnded) return;
    const body = JSON.stringify(value);
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    if (request.avAuth) headers['x-av-auth'] = signResponse(this.token, request.avAuth.nonce, status, body, request.avAuth.session);
    response.writeHead(status, headers);
    response.end(body);
  }
}

export async function daemonRequest(token, url, { method = 'GET', body = '', timeoutMs = 500 } = {}) {
  const path = new URL(url).pathname;
  const nonce = createNonce();
  const session = 'daemon-' + randomUUID();
  const response = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs),
    ...(method === 'GET' ? {} : { body }),
    headers: { 'content-type': 'application/json', 'x-av-nonce': nonce, 'x-av-session': session,
      'x-av-auth': signRequest(token, method, path, nonce, body, session) } });
  const result = await response.text();
  if (!verifyResponse(token, nonce, response.status, result, session, response.headers.get('x-av-auth'))) throw new Error('daemon 响应鉴别失败；停止，不信任此端口的结果');
  return JSON.parse(result);
}
