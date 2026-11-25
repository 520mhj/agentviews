import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNonce, signRequest } from '../src/transport/auth.mjs';
import { PageWatchStore } from '../src/core/page-watch.mjs';

const execute = promisify(execFile);
const CLI = fileURLToPath(new URL('../agentviews.mjs', import.meta.url));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'avs-watch-cli-'));
  const port = await unusedPort();
  const token = 'a'.repeat(64);
  const session = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const state = join(directory, 'state.json');
  const env = { ...process.env, AV_STATE: state, AV_BRIDGE_PORT: String(port), AV_BRIDGE_TOKEN: token,
    AV_DAEMON: String(await unusedPort()), AV_EXT: '0', AV_AUTO: '0', AV_ATTACH_PORT: '' };
  const model = { text: 'Initial page', browserSession: 'browser-1', active: '20', pages: [{ id: '20', type: 'page', url: 'https://example.com/current' }], jobs: [] };
  const controller = new AbortController();
  let closed = false;
  let daemon;
  const headers = (method, path, body = '') => {
    const nonce = createNonce();
    return { 'x-av-nonce': nonce, 'x-av-session': session, 'x-av-auth': signRequest(token, method, path, nonce, body, session) };
  };
  const respond = job => {
    model.jobs.push(job);
    if (job.op === 'ping') return { extension: 'a'.repeat(32), session_id: model.browserSession, version: 'test' };
    if (job.op === 'tabs.list') return model.pages;
    if (job.op === 'tabs.current') return model.pages.find(page => page.id === model.active);
    assert.equal(job.op, 'debugger.send');
    const { method, params } = job.args;
    assert.ok(['Page.getFrameTree', 'Page.createIsolatedWorld', 'Page.enable', 'Runtime.enable', 'Runtime.evaluate'].includes(method));
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
    if (method !== 'Runtime.evaluate') return {};
    if (params.expression === 'window.__av.snapshot') return { result: { value: { schema: 'avs.semantic-page/1', documentId: 'doc', revision: 1,
      title: 'Fixture', url: 'https://example.com/current', text: model.text, nodes: [], dialogs: [], frames: [] } } };
    if (params.expression === 'window.__av.diff') return { result: { value: { added: [], removed: [], changed: [] } } };
    return { result: { value: true } };
  };
  const peer = (async () => {
    while (!closed) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/pull', { headers: headers('GET', '/pull'), signal: controller.signal });
        const job = await response.json();
        if (job.id) {
          if (model.hangEvaluate && job.op === 'debugger.send' && job.args.method === 'Runtime.evaluate') { model.jobs.push(job); continue; }
          let result;
          try { result = { id: job.id, ok: true, result: respond(job) }; }
          catch (error) { result = { id: job.id, ok: false, error: error.message }; }
          const body = JSON.stringify(result);
          await fetch('http://127.0.0.1:' + port + '/push', { method: 'POST', body, headers: headers('POST', '/push', body), signal: controller.signal });
        }
      } catch { if (!closed) await delay(20); }
    }
  })();
  const run = async (...args) => {
    const { stdout } = await execute(process.execPath, [CLI, '--ext', '--state', state, ...args], { env, timeout: 12000 });
    try { return JSON.parse(stdout); } catch { return { text: stdout.trim() }; }
  };
  return { model, state, store: new PageWatchStore(state), run,
    startDaemon: async () => {
      daemon = spawn(process.execPath, [CLI, '--ext', '--state', state, 'serve'], { env: { ...env, AV_IDLE_MS: '0' }, stdio: 'ignore' });
      await delay(400);
    }, close: async () => {
    try { await run('watch', 'stop'); if (daemon) await run('stop'); }
    finally { await delay(2200); closed = true; controller.abort(); await peer; if (daemon && daemon.exitCode === null) daemon.kill('SIGTERM'); }
  } };
}

test('independent listener survives command exit, pins the target and resumes its cursor', async () => {
  const browser = await fixture();
  try {
    await browser.run('--current', 'observe', '--json');
    const started = await browser.run('watch', 'start', '--beat', '0.25', '--timeout', '20');
    assert.equal(started.ok, true);
    assert.equal(started.watch.worker_alive, true);
    const first = await browser.run('watch', 'poll', '--timeout', '5');
    assert.ok(first.events.some(event => event.type === 'page_changed'));
    browser.model.active = 'other'; browser.model.text = 'Updated page';
    const next = await browser.run('watch', 'poll', '--after', String(first.next_cursor), '--timeout', '5');
    assert.ok(next.events.some(event => event.type === 'page_changed'));
    assert.equal(next.watch.tab, '20');
    assert.equal(browser.model.jobs.filter(job => job.op === 'tabs.current').length, 1);
    assert.ok(browser.model.jobs.filter(job => job.op === 'debugger.send').every(job => job.args.tabId === '20'));
    const record = browser.store.read();
    const originalId = record.id, originalDeadline = record.deadline;
    record.pid = 99999999; browser.store.save(record);
    await delay(900);
    const resumed = await browser.run('watch', 'resume');
    assert.equal(resumed.ok, true);
    assert.equal(resumed.watch.id, originalId);
    assert.equal(browser.store.read().deadline, originalDeadline);
    assert.ok(resumed.watch.cursor >= next.next_cursor);
    assert.doesNotMatch(readFileSync(browser.store.filename, 'utf8'), /Updated page|example\.com/);
    const stopped = await browser.run('watch', 'stop');
    assert.equal(stopped.watch.status, 'stopped');
    assert.equal(stopped.watch.active, false);
    assert.ok(browser.model.jobs.every(job => !['tabs.create', 'tabs.close', 'tabs.update'].includes(job.op)));
  } finally { await browser.close(); }
});

test('listener stops on original target loss without choosing or creating a replacement', async () => {
  const browser = await fixture();
  try {
    await browser.run('--current', 'observe', '--json');
    await browser.run('watch', 'start', '--beat', '0.25', '--timeout', '20');
    const first = await browser.run('watch', 'poll', '--timeout', '5');
    browser.model.pages = [];
    const lost = await browser.run('watch', 'poll', '--after', String(first.next_cursor), '--timeout', '5');
    assert.equal(lost.watch.status, 'target_lost');
    assert.equal(lost.watch.active, false);
    assert.ok(browser.model.jobs.every(job => job.op !== 'tabs.create'));
  } finally { await browser.close(); }
});

test('watch poll snapshot works with the serialized daemon without queue reentry', async () => {
  const browser = await fixture();
  try {
    await browser.run('--current', 'observe', '--json');
    await browser.startDaemon();
    const started = await browser.run('watch', 'start', '--beat', '0.25', '--timeout', '20');
    assert.equal(started.ok, true);
    const result = await browser.run('watch', 'poll', '--timeout', '5', '--snapshot');
    assert.equal(result.snapshot.text, 'Initial page');
    assert.equal(result.watch.id, started.watch.id);
  } finally { await browser.close(); }
});

test('watch stop cooperatively releases the lock of its in-flight read-only subprocess', async () => {
  const browser = await fixture();
  try {
    await browser.run('--current', 'observe', '--json');
    await browser.run('watch', 'start', '--beat', '0.25', '--timeout', '20');
    await browser.run('watch', 'poll', '--timeout', '5');
    browser.model.hangEvaluate = true;
    const until = Date.now() + 5000;
    while (!existsSync(browser.state + '.lock') && Date.now() < until) await delay(30);
    assert.equal(existsSync(browser.state + '.lock'), true);
    await browser.run('watch', 'stop');
    browser.model.hangEvaluate = false;
    const deadline = Date.now() + 5000;
    while (existsSync(browser.state + '.lock') && Date.now() < deadline) await delay(30);
    assert.equal(existsSync(browser.state + '.lock'), false);
    const observation = await browser.run('observe', '--json');
    assert.equal(observation.text, 'Initial page');
  } finally { await browser.close(); }
});
