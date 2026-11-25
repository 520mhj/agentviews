import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonAuthenticator, daemonRequest } from '../src/transport/daemon-auth.mjs';
import { createNonce, signRequest } from '../src/transport/auth.mjs';

const token = 'b'.repeat(64);
const session = 'daemon-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('daemon authentication rejects unsigned, altered and replayed requests', () => {
  const authentication = new DaemonAuthenticator(token);
  assert.equal(authentication.authorize({ headers: {}, method: 'POST', url: '/cmd' }), false);
  const body = '{"argv":["help"]}';
  const nonce = createNonce();
  const request = { method: 'POST', url: '/cmd', headers: { 'x-av-nonce': nonce, 'x-av-session': session,
    'x-av-auth': signRequest(token, 'POST', '/cmd', nonce, body, session) } };
  assert.equal(authentication.authorize(request, body + ' '), false);
  assert.equal(authentication.authorize(request, body), true);
  assert.equal(authentication.authorize(request, body), false);
  assert.throws(() => new DaemonAuthenticator(null), /凭据/);
});

test('daemon clients reject forged success responses before consuming command output', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(JSON.stringify(options.headers).includes(token), false);
    return new Response('{"ok":true,"out":["fake result"]}', { headers: { 'x-av-auth': 'a'.repeat(64) } });
  };
  try { await assert.rejects(daemonRequest(token, 'http://127.0.0.1:9334/status'), /鉴别失败/); }
  finally { globalThis.fetch = original; }
});

test('real daemon authenticates state routing without launching or operating a browser', async () => {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const directory = mkdtempSync(join(tmpdir(), 'avs-daemon-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../agentviews.mjs', import.meta.url)), '--attach', '12345', 'serve'], {
    env: { ...process.env, AV_DAEMON: String(port), AV_DAEMON_TOKEN: token, AV_STATE: join(directory, 'state.json'),
      AV_IDLE_MS: '0', AV_EXT: '0', AV_AUTO: '0', AV_ATTACH_PORT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon startup timeout')), 5000);
      const ready = chunk => {
        if (chunk.toString().includes('daemon on')) { clearTimeout(timer); child.stderr.off('data', ready); resolve(); }
      };
      child.stderr.on('data', ready);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('daemon exited before startup')); });
    });
    const base = 'http://127.0.0.1:' + port;
    assert.equal((await fetch(base + '/status')).status, 403);
    assert.equal((await fetch(base + '/cmd', { method: 'POST', body: '{}' })).status, 403);
    const status = await daemonRequest(token, base + '/status');
    assert.equal(status.identity.endpoint, 12345);
    const identity = { ...status.identity, state: join(directory, 'other-task.json') };
    const result = await daemonRequest(token, base + '/cmd', { method: 'POST', body: JSON.stringify({ argv: ['help'], identity }) });
    assert.equal(result.ok, true);
    assert.match(result.out.join('\n'), /AgentViews/);
    const mismatch = await daemonRequest(token, base + '/cmd', { method: 'POST',
      body: JSON.stringify({ argv: ['help'], identity: { ...identity, endpoint: 9999 } }) });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.error, /mismatch/);
    assert.equal((await daemonRequest(token, base + '/status')).state_routing, true);
  } finally {
    child.kill();
    await exited;
  }
});
