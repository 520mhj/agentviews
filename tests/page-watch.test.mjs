import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPageWatch, recordPageWatch, checkPageWatchTarget, stopPageWatch, pollPageWatch, PageWatchStore, validatePageWatch } from '../src/core/page-watch.mjs';
import { createWatchCommands } from '../src/cli/commands/watch.mjs';
import { semanticPage, boundSemanticPage } from '../src/core/semantic-page.mjs';

const create = () => createPageWatch({ tab: '20', session: 'session', key: 'ext:9335', timeoutSec: 60, now: 1000 });
const page = (text = 'Page', revision = 1) => ({ documentId: 'document', revision, url: 'https://example.com/?secret=private', text,
  nodes: [{ id: 'revision-' + revision, role: 'button', name: 'Read', states: [] }], dialogs: [], frames: [] });
const context = { port: 'ext:9335', curr: '20', user_current: '20', owned: [], browser_session: 'session' };

test('page watch validates bounded parameters and refuses malformed journals', () => {
  for (const timeoutSec of [0, 28801, Infinity, NaN]) assert.throws(() => createPageWatch({ tab: '20', session: 'session', key: 'ext:9335', timeoutSec }));
  for (const intervalMs of [0, 249, 10001, Infinity]) assert.throws(() => createPageWatch({ tab: '20', session: 'session', key: 'ext:9335', intervalMs }));
  assert.throws(() => validatePageWatch({ ...create(), text: 'page body' }));
  assert.throws(() => validatePageWatch({ ...create(), events: [{ sequence: 1, at: 1, type: 'page_changed', text: 'private' }] }));
});

test('watch records semantic changes and recovery but not unstable node ids or revisions', () => {
  const watch = create();
  recordPageWatch(watch, page(), 1100);
  recordPageWatch(watch, page('Page', 2), 1200);
  assert.equal(watch.sequence, 1);
  recordPageWatch(watch, null, 1300);
  recordPageWatch(watch, null, 1400);
  recordPageWatch(watch, page('New page', 3), 1500);
  assert.deepEqual(watch.events.map(event => event.type), ['page_changed', 'read_failed', 'recovered', 'page_changed']);
  assert.equal(watch.status, 'running');
  assert.equal(watch.lastObservedAt, 1500);
});

test('the original target, browser session and deadline remain fixed', () => {
  for (const [state, expected] of [[{ ...context, curr: 'other' }, 'target_changed'], [{ ...context, browser_session: 'new' }, 'session_changed'],
    [{ ...context, port: 'ext:other' }, 'session_changed'], [{ ...context, user_current: null }, 'target_changed']]) {
    const watch = create();
    assert.equal(checkPageWatchTarget(watch, state, 1100), false);
    assert.equal(watch.status, expected);
  }
  const watch = create();
  assert.equal(checkPageWatchTarget(watch, context, 1100), true);
  assert.equal(checkPageWatchTarget(watch, context, 61000), false);
  assert.equal(watch.status, 'expired');
  const sequence = watch.sequence;
  recordPageWatch(watch, page(), 62000);
  assert.equal(watch.sequence, sequence);
});

test('bounded cursor journal reports gaps and never stores page content or query credentials', () => {
  const watch = create();
  for (let index = 0; index < 140; index++) recordPageWatch(watch, page('private-body-' + index), 1100 + index);
  const result = pollPageWatch(watch);
  assert.equal(result.gap, true);
  assert.equal(result.events.length, 128);
  assert.equal(result.next_cursor, 140);
  assert.equal(pollPageWatch(watch, { after: 140, id: watch.id }).events.length, 0);
  assert.throws(() => pollPageWatch(watch, { after: 141 }));
  assert.throws(() => pollPageWatch(watch, { id: 'other' }));
  assert.doesNotMatch(JSON.stringify(watch), /private-body|example\.com|secret=|Read/);
});

test('watch stop is idempotent and private state survives reload without raw snapshots', () => {
  const directory = mkdtempSync(join(tmpdir(), 'avs-watch-state-'));
  try {
    const store = new PageWatchStore(join(directory, 'state.json'));
    assert.equal(store.read(), null);
    const watch = create();
    recordPageWatch(watch, page('sensitive body'), 1100);
    stopPageWatch(watch, 'stopped', 1200);
    stopPageWatch(watch, 'stopped', 1300);
    assert.equal(watch.sequence, 2);
    store.save(watch);
    assert.deepEqual(store.read(), watch);
    assert.doesNotMatch(readFileSync(store.filename, 'utf8'), /sensitive body|secret=/);
    if (process.platform !== 'win32') assert.equal(statSync(store.filename).mode & 0o777, 0o600);
    writeFileSync(store.filename, '{corrupt');
    assert.throws(() => store.read());
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('watch detects changed action policy, editor capability and frame completeness metadata', () => {
  const watch = create();
  const snapshot = page();
  snapshot.nodes[0].actions = [{ verb: 'click', effects: ['panel_visibility'] }];
  recordPageWatch(watch, snapshot, 1100);
  snapshot.nodes[0].actions[0].effects = ['form_submit'];
  recordPageWatch(watch, snapshot, 1200);
  snapshot.nodes[0].editor_capability = { supported: false, reason: 'proxy' };
  recordPageWatch(watch, snapshot, 1300);
  snapshot.frames_total = 21;
  recordPageWatch(watch, snapshot, 1400);
  assert.equal(watch.sequence, 4);
});

test('poll refuses snapshots belonging to a different watch created during the poll window', async () => {
  const original = PageWatchStore.prototype.read;
  const first = create(), second = create();
  let reads = 0;
  PageWatchStore.prototype.read = () => ++reads === 1 ? first : second;
  try {
    const commands = createWatchCommands({ flags: { snapshot: true }, positional: ['poll'], emit: () => {}, stateFile: () => '/unused/metadata', sleep: async () => {} });
    await assert.rejects(commands.watch(), /Watch changed while polling/);
  } finally { PageWatchStore.prototype.read = original; }
});

test('full observation keeps the original extraction truncation signal', () => {
  const snapshot = semanticPage([], { documentId: 'doc', revision: 1, text: 'first part', text_truncated: true, text_total_length: 13000 });
  const bounded = boundSemanticPage(snapshot, { full: true });
  assert.equal(bounded.text_truncated, true);
  assert.equal(bounded.text_total_length, 13000);
});
