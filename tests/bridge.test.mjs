import test from 'node:test';
import assert from 'node:assert/strict';
import { AvBridge } from '../avbridge.mjs';
import { authenticatedFetch } from '../bridge-ext/auth.js';
import { bridgeFailure } from '../src/transport/bridge-diagnostics.mjs';

test('bridge refuses ordinary webpage origins and removes timed-out jobs', async () => {
  const bridge = await new AvBridge(0, { token: 'a'.repeat(64) }).start();
  const url = 'http://127.0.0.1:' + bridge.server.address().port;
  try {
    const rejected = await fetch(url + '/pull', { headers: { Origin: 'https://example.com' } });
    assert.equal(rejected.status, 403);
    const pending = bridge.job('ping', {}, 20);
    await assert.rejects(pending, /timeout/);
    assert.equal(bridge.queue.length, 0);
    assert.equal(bridge.waiting.size, 0);
  } finally { bridge.close(); }
});

test('bridge close rejects waiting callers rather than leaking pending work', async () => {
  const bridge = await new AvBridge(0, { token: 'a'.repeat(64) }).start();
  const pending = bridge.job('ping', {}, 1000);
  const rejected = assert.rejects(pending, /bridge closed/);
  bridge.close();
  await rejected;
  assert.equal(bridge.waiting.size, 0);
  assert.equal(bridge.queue.length, 0);
});

test('unconnected and delivered timeouts preserve different outcomes without exposing credentials', async () => {
  const token = 'a'.repeat(64);
  const bridge = await new AvBridge(0, { token }).start();
  try {
    await assert.rejects(bridge.job('ping', {}, 30), error => {
      assert.equal(error.code, 'AV_BRIDGE_PEER_UNAVAILABLE');
      assert.equal(error.delivered, false);
      assert.equal(bridgeFailure(error, { runtime: '/fixture', port: bridge.port }).reason, 'extension_not_polling');
      return true;
    });
    const pending = bridge.job('ping', {}, 150);
    const rejected = assert.rejects(pending, error => {
      assert.equal(error.code, 'AV_BRIDGE_RESULT_UNKNOWN');
      assert.equal(error.delivered, true);
      return true;
    });
    await authenticatedFetch('/pull', { token, port: bridge.port, session: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', timeoutMs: 1000 });
    await rejected;
    assert.equal(bridge.diagnostics().authenticated_requests, 1);
    assert.equal(JSON.stringify(bridge.diagnostics()).includes(token), false);
  } finally { bridge.close(); }
});

test('rejected authentication is reported separately from extension version or website failures', async () => {
  const bridge = await new AvBridge(0, { token: 'a'.repeat(64) }).start();
  try {
    await fetch('http://127.0.0.1:' + bridge.port + '/pull');
    assert.equal(bridge.diagnostics().authentication_rejections, 1);
    await assert.rejects(bridge.job('ping', {}, 30), error => {
      const failure = bridgeFailure(error, { runtime: '/fixture', port: bridge.port });
      assert.equal(failure.reason, 'bridge_authentication_rejected');
      assert.equal(failure.website_requested, false);
      assert.equal(failure.task_delivered, false);
      return true;
    });
  } finally { bridge.close(); }
});
