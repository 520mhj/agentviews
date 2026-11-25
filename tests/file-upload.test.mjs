import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareFileSelection, fileSelectionSummary } from '../src/core/file-selection.mjs';
import { dispatchFileUpload } from '../src/cli/file-upload.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'avs-upload-test-'));
  mkdirSync(join(directory, 'src'));
  writeFileSync(join(directory, 'src', 'index.mjs'), 'export const value = 1;');
  writeFileSync(join(directory, '.gitignore'), 'node_modules/');
  return directory;
}

test('file selections preserve names and bytes without exposing absolute paths in public summaries', () => {
  const directory = fixture();
  try {
    const selection = prepareFileSelection([join(directory, 'src'), join(directory, '.gitignore')]);
    assert.deepEqual(selection.inventory.map(file => file.name), ['src/index.mjs', '.gitignore']);
    assert.equal(selection.file_count, 2);
    assert.equal(JSON.stringify(fileSelectionSummary(selection)).includes(directory), false);
    assert.throws(() => prepareFileSelection(['src/index.mjs']), /absolute paths/);
    assert.throws(() => prepareFileSelection([directory, directory]), /Duplicate/);
    symlinkSync(join(directory, '.gitignore'), join(directory, 'link'));
    assert.throws(() => prepareFileSelection([directory]), /symlinks/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function transport({ rejectDrop = false, moved = false, cleanupFailure = false } = {}) {
  const calls = [];
  return { calls, __contextId: 42, send: async (method, params) => {
    calls.push({ method, params });
    if (cleanupFailure && method === 'Input.cancelDragging') throw new Error('cleanup timeout');
    if (method === 'Runtime.evaluate') {
      if (params.expression === 'window.__avUploadInput') return { result: { objectId: 'input1' } };
      return { result: { value: moved ? { ok: false, reason: 'target_moved' } : { ok: true } } };
    }
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 7 } };
    if (rejectDrop && (method === 'DOM.setFileInputFiles' || params.type === 'drop')) throw new Error('unknown dispatch');
    return {};
  } };
}

test('native upload releases references and never guesses a selector or opens a dialog', async () => {
  const directory = fixture();
  try {
    const selection = prepareFileSelection([join(directory, '.gitignore')]);
    const cdp = transport();
    const result = await dispatchFileUpload(cdp, selection, { method: 'native_file_input' });
    assert.equal(result.ok, true);
    assert.equal(cdp.calls.filter(call => call.method === 'DOM.setFileInputFiles').length, 1);
    assert.equal(cdp.calls.some(call => call.method === 'Runtime.releaseObject'), true);
    assert.equal(result.cleanup_complete, true);
    const failed = transport({ rejectDrop: true });
    assert.equal((await dispatchFileUpload(failed, selection, { method: 'native_file_input' })).reason, 'upload_dispatch_unknown');
    assert.equal(failed.calls.some(call => call.method === 'Runtime.releaseObject'), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('drag upload guards every stage and cancels dragging on success or unknown outcome', async () => {
  const directory = fixture();
  try {
    const selection = prepareFileSelection([join(directory, 'src')]);
    const plan = { method: 'trusted_drag_drop', point: [10, 20] };
    for (const rejectDrop of [false, true]) {
      const cdp = transport({ rejectDrop });
      const result = await dispatchFileUpload(cdp, selection, plan);
      assert.equal(result.ok, !rejectDrop);
      assert.deepEqual(cdp.calls.filter(call => call.method === 'Input.dispatchDragEvent').map(call => call.params.type), ['dragEnter', 'dragOver', 'drop']);
      assert.equal(cdp.calls.some(call => call.method === 'Input.cancelDragging'), true);
      if (rejectDrop) assert.match(result.instruction, /不能盲目重放上传/);
    }
    const moved = transport({ moved: true });
    assert.equal((await dispatchFileUpload(moved, selection, plan)).reason, 'target_moved');
    assert.equal(moved.calls.some(call => call.method === 'Input.dispatchDragEvent'), false);
    writeFileSync(join(directory, 'src', 'index.mjs'), 'changed');
    const changed = transport();
    assert.equal((await dispatchFileUpload(changed, selection, plan)).reason, 'upload_files_changed');
    assert.equal(changed.calls.some(call => call.method === 'Input.dispatchDragEvent'), false);
    const cleanup = transport({ cleanupFailure: true });
    const fresh = prepareFileSelection([join(directory, 'src')]);
    const incomplete = await dispatchFileUpload(cleanup, fresh, plan);
    assert.equal(incomplete.reason, 'upload_cleanup_incomplete');
    assert.equal(incomplete.cleanup_complete, false);
    assert.equal(incomplete.dispatched, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
