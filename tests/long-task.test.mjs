import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskCommands } from '../src/cli/commands/task.mjs';
import { boundSemanticPage } from '../src/core/semantic-page.mjs';
import { TaskState } from '../src/core/task-state.mjs';
import { startLongTask, validateLongTask, isLongTaskOpen, longTaskSummary, recordLongTaskResult,
  observeLongTask, checkpointLongTask, readyLongTask, watchLongTask } from '../src/core/long-task.mjs';

const task = total => startLongTask({ tab: '20', goal: '完成授权练习，等待用户提交', total: total || 2, authorized: true, now: 1000 });
const snapshot = (revision = 1) => ({ documentId: 'document-1', revision, url: 'https://example.com/practice', text: '第1题 全部已答',
  nodes: [{ id: 'document-1:r' + revision + ':n1', role: 'radio', name: '选项B', section: 'choices', checked: true, states: ['checked'], actions: [] }] });
const expected = { contains: '第1题', name: '选项B', role: 'radio', checked: true };

test('practice long tasks require explicit authorization and bounded input', () => {
  assert.throws(() => startLongTask({ tab: '20', goal: '练习', total: 2 }), /明确授权/);
  for (const total of [0, 1001, NaN, 1.5]) assert.throws(() => startLongTask({ tab: '20', goal: '练习', total, authorized: true }));
  assert.throws(() => startLongTask({ tab: '20', goal: '练习', total: 2, timeoutSec: Infinity, authorized: true }));
  assert.equal(task().status, 'active');
});

test('recoverable actions preserve progress and require verification rather than replay', () => {
  const current = task();
  recordLongTaskResult(current, { ok: false, status: 'needs_agent_review', reason: 'stale_revision' }, 1100);
  assert.equal(current.status, 'recovering');
  assert.equal(longTaskSummary(current, 1100).should_continue, true);
  recordLongTaskResult(current, { ok: true, status: 'requires_verification' }, 1200);
  assert.equal(current.status, 'verifying');
  assert.equal(current.checkpoints.length, 0);
  assert.equal(longTaskSummary(current, 1200).agent_work_completed, false);
});

test('only observed unique selected choices create checkpoints and stale evidence fails', () => {
  const current = task();
  const observed = snapshot();
  observeLongTask(current, observed, 1100);
  assert.throws(() => checkpointLongTask(current, { step: 1, expected, snapshot: snapshot(2), now: 1100 }), /刚刚读取/);
  observed.nodes[0].checked = false;
  observeLongTask(current, observed, 1100);
  assert.equal(checkpointLongTask(current, { step: 1, expected, snapshot: observed, now: 1100 }).ok, false);
  observed.nodes[0].checked = true;
  observeLongTask(current, observed, 1200);
  const result = checkpointLongTask(current, { step: 1, expected, snapshot: observed, now: 1200 });
  assert.equal(result.ok, true);
  assert.equal(result.task.completed_steps, 1);
  checkpointLongTask(current, { step: 1, expected, snapshot: observed, now: 1200 });
  assert.equal(current.checkpoints.length, 1);
  assert.deepEqual(longTaskSummary(current, 1200).missing_steps, [2]);
});

test('multi-choice checkpoints verify every supplied option state, not just one successful click', () => {
  const current = task();
  const observed = snapshot();
  observed.nodes = ['A', 'B', 'C'].map(letter => ({ role: 'checkbox', name: letter, checked: letter !== 'B', states: [], actions: [] }));
  observeLongTask(current, observed, 1100);
  const choices = ['A', 'B', 'C'].map(letter => ({ name: letter, role: 'checkbox', checked: letter !== 'B' }));
  assert.equal(checkpointLongTask(current, { step: 1, expected: { contains: '第1题', choices }, snapshot: observed, now: 1100 }).ok, true);
  observed.nodes[2].checked = false;
  observeLongTask(current, observed, 1200);
  assert.equal(checkpointLongTask(current, { step: 2, expected: { contains: '第1题', choices }, snapshot: observed, now: 1200 }).ok, false);
  assert.equal(current.checkpoints.length, 1);
});

test('an unchecked option or empty assertion cannot claim a completed answer', () => {
  const current = task();
  const observed = snapshot();
  observeLongTask(current, observed, 1100);
  assert.throws(() => checkpointLongTask(current, { step: 1, expected: { ...expected, checked: false }, snapshot: observed, now: 1100 }), /实际选择/);
  assert.throws(() => checkpointLongTask(current, { step: 1, expected: { ...expected, contains: '' }, snapshot: observed, now: 1100 }), /题目身份/);
});

test('human handoff never clears itself when the page or action result changes', () => {
  const current = task();
  recordLongTaskResult(current, { ok: false, status: 'needs_user_action', reason: 'sensitive_action' }, 1100);
  recordLongTaskResult(current, { ok: true }, 1200);
  observeLongTask(current, snapshot(), 1300);
  assert.equal(current.status, 'waiting_user');
  assert.throws(() => checkpointLongTask(current, { step: 1, expected, snapshot: snapshot(), pending: { reason: 'sensitive_action' }, now: 1300 }), /人工等待/);
  assert.equal(longTaskSummary(current, 1300).should_continue, true);
});

test('all checkpoints and final page proof are required before waiting for user submission', () => {
  const current = task(1);
  const observed = snapshot();
  observeLongTask(current, observed, 1100);
  assert.throws(() => readyLongTask(current, { expected: { contains: '全部已答' }, snapshot: observed, now: 1100 }), /尚有题目/);
  checkpointLongTask(current, { step: 1, expected, snapshot: observed, now: 1200 });
  assert.equal(readyLongTask(current, { expected: { contains: 'missing' }, snapshot: observed, now: 1200 }).ok, false);
  const result = readyLongTask(current, { expected: { contains: '全部已答' }, snapshot: observed, now: 1300 });
  assert.equal(result.status, 'awaiting_submission');
  assert.equal(result.task.agent_work_completed, true);
  assert.equal(result.task.task_completed, false);
  assert.equal(result.task.automatic_submission, false);
  assert.equal(result.task.manual_submission_required, true);
  assert.equal(longTaskSummary(current, 99999999).status, 'awaiting_submission');
});

test('persistent progress stores hashes rather than page contents and survives new CLI processes', () => {
  const filename = join(mkdtempSync(join(tmpdir(), 'avs-long-task-')), 'state.json');
  const state = new TaskState({ path: () => filename, key: () => 'ext:9335' });
  const current = task();
  observeLongTask(current, snapshot(), 1100);
  checkpointLongTask(current, { step: 1, expected, snapshot: snapshot(), now: 1100 });
  state.get().long_task = current; state.save();
  assert.equal(readFileSync(filename, 'utf8').includes('选项B'), false);
  assert.equal(readFileSync(filename, 'utf8').includes('https://example.com/practice'), false);
  assert.equal(new TaskState({ path: () => filename, key: () => 'ext:9335' }).get().long_task.checkpoints.length, 1);
  writeFileSync(filename, JSON.stringify({ port: 'ext:9335', long_task: { ...current, checkpoints: [current.checkpoints[0], current.checkpoints[0]] } }));
  assert.throws(() => new TaskState({ path: () => filename, key: () => 'ext:9335' }).get(), /无效长任务/);
  assert.throws(() => validateLongTask({ ...current, status: 'invented' }), /无效长任务/);
});

async function watchFixture({ current = task(), fail = false, exists = true, pending = null, signal, timeoutMs = 500 } = {}) {
  let clock = 1100, reads = 0, saves = 0;
  observeLongTask(current, snapshot(), clock);
  const result = await watchLongTask({ task: current, timeoutMs, intervalMs: 100, signal, now: () => clock,
    wait: async milliseconds => { clock += milliseconds; }, save: () => saves++, pending: () => pending,
    targetExists: async () => exists, observe: async () => { reads++; if (fail) throw new Error('transport lost'); return snapshot(reads); } });
  return { result, reads, saves, current };
}

test('unchanged semantic observations ignore revision churn and yield bounded heartbeats without ending the task', async () => {
  const { result, reads } = await watchFixture();
  assert.equal(result.event, 'heartbeat');
  assert.equal(result.task.should_continue, true);
  assert.ok(reads > 1 && reads <= 6);
});

test('transport read failures recover within the watch budget without replaying an action', async () => {
  const { result, reads, current } = await watchFixture({ fail: true });
  assert.equal(result.status, 'needs_agent_review');
  assert.equal(result.task.should_continue, true);
  assert.equal(current.status, 'recovering');
  assert.ok(reads > 1 && reads <= 6);
});

test('watch preserves human waiting even after updated page evidence', async () => {
  const { result, current } = await watchFixture({ pending: { status: 'needs_user_action', reason: 'sensitive_action' } });
  assert.equal(result.task.status, 'waiting_user');
  assert.equal(result.task.should_continue, true);
  assert.equal(current.checkpoints.length, 0);
});

test('lost targets, expired deadlines, and cancellation never create a page or submit', async () => {
  const lost = await watchFixture({ exists: false });
  assert.equal(lost.result.status, 'target_lost');
  assert.equal(lost.reads, 0);
  const expired = task(); expired.deadline = 1050;
  const deadline = await watchFixture({ current: expired });
  assert.equal(deadline.result.status, 'expired');
  assert.equal(deadline.result.task.agent_work_completed, false);
  const controller = new AbortController(); controller.abort();
  const cancelled = await watchFixture({ signal: controller.signal });
  assert.equal(cancelled.result.status, 'watch_cancelled');
  assert.equal(cancelled.reads, 0);
  assert.equal(isLongTaskOpen(cancelled.current), true);
});

test('a complete 60-question practice reaches only manual-submission handoff after every verified question', () => {
  const current = task(60);
  for (let step = 1; step <= 60; step++) {
    const observed = snapshot(step);
    observed.text = '第' + step + '题 已答' + step + '/60';
    observeLongTask(current, observed, 1100 + step);
    assert.equal(checkpointLongTask(current, { step, expected: { ...expected, contains: '第' + step + '题' }, snapshot: observed, now: 1100 + step }).ok, true);
  }
  const observed = snapshot(61); observed.text = '已答60/60';
  observeLongTask(current, observed, 1200);
  const ready = readyLongTask(current, { expected: { contains: '已答60/60' }, snapshot: observed, now: 1200 });
  assert.equal(ready.task.completed_steps, 60);
  assert.deepEqual(ready.task.missing_steps, []);
  assert.equal(ready.task.agent_work_completed, true);
  assert.equal(ready.task.task_completed, false);
  assert.equal(ready.task.automatic_submission, false);
});

test('watch releases signal listeners on success and invalid input', async () => {
  const signals = ['SIGINT', 'SIGTERM'];
  const before = signals.map(signal => process.listenerCount(signal));
  const state = { long_task: startLongTask({ tab: '20', goal: '练习', total: 1, authorized: true }) };
  const flags = { timeout: '0' };
  const commands = createTaskCommands({ cdp: {}, CURR: '20', flags, positional: ['watch'], tabs: () => state,
    saveTabs: () => {}, emit: () => {}, ensureAv: async () => {}, evalJs: async () => snapshot(), listPages: async () => [{ id: '20' }] });
  await commands.task();
  assert.deepEqual(signals.map(signal => process.listenerCount(signal)), before);
  flags.timeout = 'invalid';
  await assert.rejects(commands.task(), /监听窗口/);
  assert.deepEqual(signals.map(signal => process.listenerCount(signal)), before);
});

test('same-question dialog changes survive tiny node budgets and are not lost as a heartbeat', async () => {
  const current = task();
  const before = snapshot(); before.dialogs = [];
  observeLongTask(current, before, 1100);
  const after = snapshot(2); after.dialogs = [{ name: '提示', kind: 'proctoring', text: '已切屏2次，继续切屏可能自动交卷', controls: [] }];
  const watched = await watchLongTask({ task: current, observe: async () => after, save: () => {}, pending: () => null,
    targetExists: async () => true, timeoutMs: 0, now: () => 1200 });
  assert.equal(watched.changes.dialogs, true);
  const bounded = boundSemanticPage(watched.snapshot, { max: 1 });
  assert.equal(bounded.dialogs[0].kind, 'proctoring');
  assert.equal(bounded.dialogs[0].text.includes('自动交卷'), true);
});

test('coding checkpoint verifies exact source readback but never labels it as passed compilation or tests', () => {
  const current = startLongTask({ tab: '20', goal: '编程练习', kind: 'coding', total: 1, authorized: true, now: 1000 });
  const observed = { ...snapshot(), nodes: [{ role: 'textbox', name: '代码编辑器', value: 'const answer = 42;', states: [], actions: [] }] };
  observeLongTask(current, observed, 1100);
  const expected = { contains: '第1题', role: 'textbox', name: '代码编辑器', value: 'const answer = 42;' };
  assert.equal(checkpointLongTask(current, { step: 1, expected: { ...expected, value: 'wrong' }, snapshot: observed, now: 1100 }).ok, false);
  assert.equal(checkpointLongTask(current, { step: 1, expected, snapshot: observed, origin: 'agent', now: 1100 }).ok, true);
  assert.equal(current.checkpoints[0].verification, 'editor_readback_only');
  assert.equal(longTaskSummary(current, 1100).verified_origin_counts.agent, 1);
});
