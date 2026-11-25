import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskState } from '../src/core/task-state.mjs';
import { acquireSessionLock } from '../src/core/session-lock.mjs';

test('explicit reload after acquiring a task lock observes another writer without losing local edits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'avs-reload-'));
  const filename = join(directory, 'state.json');
  const options = { path: () => filename, key: () => 'ext:9335' };
  const persistent = new TaskState(options);
  persistent.get();
  persistent.save();
  let release;
  try {
    release = await acquireSessionLock(filename);
    const external = new TaskState(options);
    external.get().pending_user_action = { tab: '1', status: 'needs_user_action', reason: 'payment' };
    external.save();
    release();
    release = await acquireSessionLock(filename);
    assert.equal(persistent.reload().pending_user_action.reason, 'payment');
    persistent.get().curr = '1';
    assert.equal(persistent.get().curr, '1');
    persistent.save();
    const stored = JSON.parse(readFileSync(filename, 'utf8'));
    assert.equal(stored.pending_user_action.reason, 'payment');
  } finally {
    release?.();
    rmSync(directory, { recursive: true, force: true });
  }
});
