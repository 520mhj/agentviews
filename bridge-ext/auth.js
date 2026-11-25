const encoder = new TextEncoder();
let cachedToken = null;
let cachedKey = null;

function isToken(token) {
  return typeof token === 'string' && /^[a-f0-9]{64}$/i.test(token);
}

async function keyFor(token) {
  if (!isToken(token)) throw new Error('Bridge is not paired; run init and reload the installed extension');
  if (cachedToken !== token) {
    cachedToken = token;
    cachedKey = crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  }
  return cachedKey;
}

export function requestPayload(method, path, nonce, body = '', session = '') {
  return JSON.stringify(['AVS-REQUEST-1', method, path, nonce, body, session]);
}

export function responsePayload(nonce, status, body = '', session = '') {
  return JSON.stringify(['AVS-RESPONSE-1', nonce, status, body, session]);
}

async function sign(token, payload) {
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', await keyFor(token), encoder.encode(payload)));
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

async function verify(token, payload, signature) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const bytes = Uint8Array.from(signature.match(/../g), pair => parseInt(pair, 16));
  return crypto.subtle.verify('HMAC', await keyFor(token), bytes, encoder.encode(payload));
}

export function signRequest(token, method, path, nonce, body = '', session = '') {
  return sign(token, requestPayload(method, path, nonce, body, session));
}

export function verifyRequest(token, method, path, nonce, body, session, signature) {
  return verify(token, requestPayload(method, path, nonce, body, session), signature);
}

export function signResponse(token, nonce, status, body = '', session = '') {
  return sign(token, responsePayload(nonce, status, body, session));
}

export function verifyResponse(token, nonce, status, body, session, signature) {
  return verify(token, responsePayload(nonce, status, body, session), signature);
}

export async function authenticatedFetch(path, { token, port, session, method = 'GET', body = '', timeoutMs = 25000 }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid bridge port');
  if (typeof session !== 'string' || !session) throw new Error('Missing browser session');
  const nonce = Date.now() + '.' + crypto.randomUUID();
  const signature = await signRequest(token, method, path, nonce, body, session);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-av-nonce': nonce, 'x-av-session': session, 'x-av-auth': signature },
      ...(method === 'GET' ? {} : { body }),
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
    });
    const text = await response.text();
    if (!(await verifyResponse(token, nonce, response.status, text, session, response.headers.get('x-av-auth')))) {
      throw new Error('Bridge response authentication failed');
    }
    if (!response.ok) throw new Error('Authenticated bridge request failed: ' + response.status + ' ' + text);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}
