import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const AUTH_HEADER = 'x-av-auth';
export const NONCE_HEADER = 'x-av-nonce';
export const SESSION_HEADER = 'x-av-session';

export function isToken(token) {
  return typeof token === 'string' && /^[a-f0-9]{64}$/i.test(token);
}

export function createNonce() {
  return Date.now() + '.' + randomUUID();
}

export function requestPayload(method, path, nonce, body = '', session = '') {
  return JSON.stringify(['AVS-REQUEST-1', method, path, nonce, body, session]);
}

export function responsePayload(nonce, status, body = '', session = '') {
  return JSON.stringify(['AVS-RESPONSE-1', nonce, status, body, session]);
}

function sign(token, payload) {
  if (!isToken(token)) throw new Error('AgentViews bridge token is missing or invalid; run init');
  return createHmac('sha256', token).update(payload, 'utf8').digest('hex');
}

function verify(expected, actual) {
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/i.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

export function signRequest(token, method, path, nonce, body = '', session = '') {
  return sign(token, requestPayload(method, path, nonce, body, session));
}

export function verifyRequest(token, method, path, nonce, body, session, signature) {
  if (!isToken(token)) return false;
  return verify(signRequest(token, method, path, nonce, body, session), signature);
}

export function signResponse(token, nonce, status, body = '', session = '') {
  return sign(token, responsePayload(nonce, status, body, session));
}

export function verifyResponse(token, nonce, status, body, session, signature) {
  if (!isToken(token)) return false;
  return verify(signResponse(token, nonce, status, body, session), signature);
}
