import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { AvBridge } from '../avbridge.mjs';
import { createNonce, signRequest, signResponse, verifyResponse } from '../src/transport/auth.mjs';
import { authenticatedFetch } from '../bridge-ext/auth.js';

const token = 'a'.repeat(64), session = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function headers(method, path, body = '', nonce = createNonce()) {
  return { 'x-av-nonce': nonce, 'x-av-session': session, 'x-av-auth': signRequest(token, method, path, nonce, body, session) };
}

test('bridge refuses unpaired peers, nonce replay and null result packets', async () => {
  const bridge = await new AvBridge(0, { token }).start();
  const base = 'http://127.0.0.1:' + bridge.port;
  try {
    assert.equal((await fetch(base + '/pull')).status, 403);
    const signed = headers('GET', '/ping');
    const first = await fetch(base + '/ping', { headers: signed });
    const body = await first.text();
    assert.equal(verifyResponse(token, signed['x-av-nonce'], first.status, body, session, first.headers.get('x-av-auth')), true);
    assert.equal((await fetch(base + '/ping', { headers: signed })).status, 403);
    assert.equal((await fetch(base + '/push', { method: 'POST', headers: headers('POST', '/push', 'null'), body: 'null' })).status, 400);
  } finally { bridge.close(); }
});

test('Unicode result packets decode correctly across HTTP byte boundaries', async () => {
  const bridge = await new AvBridge(0, { token }).start();
  const base = 'http://127.0.0.1:' + bridge.port;
  try {
    const pending = bridge.job('ping');
    const job = await (await fetch(base + '/pull', { headers: headers('GET', '/pull') })).json();
    const body = JSON.stringify({ id: job.id, ok: true, result: { text: '中文' } });
    const bytes = Buffer.from(body);
    const boundary = bytes.indexOf(Buffer.from('中')) + 1;
    await new Promise((resolve, reject) => {
      const outgoing = request(base + '/push', { method: 'POST', headers: headers('POST', '/push', body) }, response => {
        response.resume(); response.once('end', resolve);
      });
      outgoing.once('error', reject);
      outgoing.write(bytes.subarray(0, boundary)); outgoing.end(bytes.subarray(boundary));
    });
    assert.equal((await pending).text, '中文');
  } finally { bridge.close(); }
});

test('browser authentication rejects forged server jobs without exposing the shared secret', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(JSON.stringify(options.headers).includes(token), false);
    return new Response(JSON.stringify({ id: 'forged', op: 'debugger.send' }), { headers: { 'x-av-auth': 'b'.repeat(64) } });
  };
  try { await assert.rejects(authenticatedFetch('/pull', { token, port: 9335, session, timeoutMs: 1000 }), /auth|signature|鉴别/i); }
  finally { globalThis.fetch = original; }
});

test('browser and Node use the same authenticated response protocol', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.stringify({ paired: true });
    const signature = signResponse(token, options.headers['x-av-nonce'], 200, body, session);
    return new Response(body, { headers: { 'x-av-auth': signature } });
  };
  try { assert.equal((await authenticatedFetch('/ping', { token, port: 9335, session, timeoutMs: 1000 })).paired, true); }
  finally { globalThis.fetch = original; }
});

test('the browser authentication module completes a real signed pull and push roundtrip', async () => {
  const bridge = await new AvBridge(0, { token }).start();
  try {
    const pending = bridge.job('ping', {}, 2000);
    const job = await authenticatedFetch('/pull', { token, port: bridge.port, session, timeoutMs: 2000 });
    assert.equal(job.op, 'ping');
    await authenticatedFetch('/push', { token, port: bridge.port, session, method: 'POST',
      body: JSON.stringify({ id: job.id, ok: true, result: { session_id: session } }), timeoutMs: 2000 });
    assert.deepEqual(await pending, { session_id: session });
    assert.equal(bridge.diagnostics().authentication_rejections, 0);
  } finally { bridge.close(); }
});
