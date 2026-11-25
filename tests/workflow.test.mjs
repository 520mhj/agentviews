import test from 'node:test';
import assert from 'node:assert/strict';
import { startLongTask, observeLongTask, checkpointLongTask } from '../src/core/long-task.mjs';
import { createTaskCommands } from '../src/cli/commands/task.mjs';

test('workflow checkpoints validate declared unique page targets rather than a built-in scenario', () => {
  const task = startLongTask({ tab: '20', kind: 'workflow', goal: 'Read an authorized document', total: 1, authorized: true, now: 1000 });
  const snapshot = { documentId: 'doc', revision: 1, url: 'https://example.com', text: 'Document complete', nodes: [
    { name: 'Document', role: 'heading', states: [], actions: [] }
  ] };
  observeLongTask(task, snapshot, 1100);
  const result = checkpointLongTask(task, { step: 1, expected: { contains: 'Document complete', name: 'Document', role: 'heading' }, snapshot, now: 1200 });
  assert.equal(result.ok, true);
  assert.equal(task.checkpoints[0].verification, 'page_assertion_only');
  assert.throws(() => checkpointLongTask(task, { step: 1, expected: { contains: 'Document complete', name: 'Document', role: 'heading' }, snapshot,
    pending: { reason: 'payment' }, now: 1300 }));
});

test('workflow completion requires every checkpoint and never clears a pending human action', async () => {
  const snapshot = { documentId: 'doc', revision: 1, text: 'Document complete', nodes: [{ name: 'Document', role: 'heading', states: [], actions: [] }] };
  const run = async ({ checkpoint, pending }) => {
    const task = startLongTask({ tab: '20', kind: 'workflow', goal: 'Read a document', total: 1, authorized: true });
    observeLongTask(task, snapshot);
    if (checkpoint) checkpointLongTask(task, { step: 1, expected: { contains: 'Document complete', name: 'Document', role: 'heading' }, snapshot });
    const state = { long_task: task, pending_user_action: pending };
    let output;
    const commands = createTaskCommands({ cdp: {}, flags: { contains: 'Document complete' }, positional: ['complete'], emit: value => { output = JSON.parse(value); },
      evalJs: async () => snapshot, ensureAv: async () => {}, tabs: () => state, saveTabs: () => {}, CURR: '20' });
    await commands.task();
    return { task, output, state };
  };
  await assert.rejects(run({ checkpoint: false }), /尚有题目/);
  await assert.rejects(run({ checkpoint: true, pending: { reason: 'payment' } }), /人工等待/);
  const result = await run({ checkpoint: true });
  assert.equal(result.task.status, 'completed');
  assert.equal(result.output.task.task_completed, true);
  assert.equal(result.output.task.automatic_submission, false);
});
