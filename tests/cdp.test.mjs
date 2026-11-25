import test from 'node:test';
import assert from 'node:assert/strict';
import { CDP } from '../src/transport/cdp.mjs';

class Socket extends EventTarget {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(message) { this.sent.push(JSON.parse(message)); }
}

test('CDP disconnect invalidates its lifecycle and rejects dispatched work without replay', async () => {
  const socket = new Socket();
  const cdp = new CDP(socket);
  cdp.__contextId = 9;
  const pending = cdp.send('Input.dispatchMouseEvent');
  const rejected = assert.rejects(pending, error => error.code === 'AV_CDP_RESULT_UNKNOWN' && error.delivered);
  socket.readyState = 3;
  socket.dispatchEvent(new Event('close'));
  await rejected;
  assert.equal(cdp.closed, true);
  assert.equal(cdp.__contextId, null);
  assert.equal(cdp.pending.size, 0);
  await assert.rejects(cdp.send('Runtime.enable'), /connection closed/);
  assert.equal(socket.sent.length, 1);
});

test('a CDP command timeout remains an unknown dispatched result and ignores late responses', async () => {
  const socket = new Socket();
  const cdp = new CDP(socket, 5);
  try {
    await assert.rejects(cdp.send('Input.dispatchKeyEvent'), error => error.code === 'AV_CDP_RESULT_UNKNOWN' && error.delivered);
    const late = new Event('message');
    late.data = JSON.stringify({ id: socket.sent[0].id, result: {} });
    socket.dispatchEvent(late);
    assert.equal(cdp.pending.size, 0);
    assert.equal(socket.sent.length, 1);
  } finally { cdp.dispose(); }
});

test('an already closed socket fails before dispatch and disposes stale context state', async () => {
  const socket = new Socket();
  const cdp = new CDP(socket);
  cdp.__contextId = 11;
  socket.readyState = 3;
  await assert.rejects(cdp.send('Runtime.enable'), error => !error.delivered && /closed/.test(error.message));
  assert.equal(cdp.closed, true);
  assert.equal(cdp.__contextId, null);
  assert.equal(socket.sent.length, 0);
});
