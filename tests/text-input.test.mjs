import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchTrustedText } from '../src/cli/text-input.mjs';

function transport({ guard = () => ({ ok: true }), failKey = false, failInsert = false } = {}) {
  const calls = [];
  const cdp = { __contextId: 42, send: async (method, params) => {
    calls.push({ method, params });
    if (method === 'Runtime.evaluate') return { result: { value: guard(params.expression) } };
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && failKey) throw new Error('key failed');
    if (method === 'Input.insertText' && failInsert) throw new Error('unknown outcome');
    return {};
  } };
  return { cdp, calls };
}

test('trusted text uses platform select-all, rechecks the target and inserts literal code only once', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const { cdp, calls } = transport();
    const code = 'const text = "<script>not executed</script>";\n';
    assert.equal((await dispatchTrustedText(cdp, code, { platform })).ok, true);
    const keys = calls.filter(call => call.method === 'Input.dispatchKeyEvent');
    assert.deepEqual(keys.map(call => call.params.type), ['keyDown', 'keyUp']);
    assert.equal(keys[0].params.modifiers, platform === 'darwin' ? 4 : 2);
    assert.deepEqual(keys[0].params.commands, ['selectAll']);
    assert.equal(keys[1].params.commands, undefined);
    assert.equal(calls.filter(call => call.method === 'Input.insertText').length, 1);
    assert.equal(calls.find(call => call.method === 'Input.insertText').params.text, code);
  }
});

test('stale focus or selection never inserts text into an unintended target', async () => {
  for (const rejectAt of ['select', 'insert']) {
    const { cdp, calls } = transport({ guard: expression => expression.includes('"' + rejectAt + '"')
      ? { ok: false, status: 'needs_agent_review', reason: 'stale_text_target' } : { ok: true } });
    assert.equal((await dispatchTrustedText(cdp, 'code')).ok, false);
    assert.equal(calls.some(call => call.method === 'Input.insertText'), false);
  }
});

test('keyboard and unknown insertion outcomes clean up without script fallback or replay', async () => {
  for (const options of [{ failKey: true }, { failInsert: true }]) {
    const { cdp, calls } = transport(options);
    const result = await dispatchTrustedText(cdp, 'code');
    assert.equal(result.reason, 'text_dispatch_unknown');
    assert.equal(result.replayed, false);
    assert.equal(calls.filter(call => call.method === 'Input.dispatchKeyEvent').at(-1).params.type, 'keyUp');
    assert.ok(calls.filter(call => call.method === 'Input.insertText').length <= 1);
    assert.equal(calls.some(call => call.method === 'Page.bringToFront'), false);
  }
});
