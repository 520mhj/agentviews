import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from '../src/core/arguments.mjs';
import { CommandQueue } from '../src/core/command-queue.mjs';
import { TaskState } from '../src/core/task-state.mjs';
import { acquireSessionLock } from '../src/core/session-lock.mjs';
import { semanticPage, diffSemanticPages, verifySemanticPage } from '../src/core/semantic-page.mjs';
import { planAnswerTiming, waitForAnswerTiming } from '../src/core/pacing.mjs';
import { installAgentSkills } from '../src/setup/install.mjs';
import { resourcePath } from '../src/core/paths.mjs';
import { evalJs } from '../src/browser/evaluate.mjs';
import { createBrowserRuntime } from '../src/platform/browser-runtime.mjs';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('literal arguments and empty field values cannot become CLI flags', () => {
  assert.equal(parse(['act', '--text', '']).flags.text, '');
  assert.equal(parse(['act', '--name', '--current']).flags.name, '--current');
  assert.equal(parse(['search', '--json', '--', '--current']).flags.current, undefined);
  assert.deepEqual(parse(['search', '--json', '--', '--current']).positional, ['--current']);
  assert.throws(() => parse(['act', '--text']), /缺少参数/);
});

test('command queue serializes state and never idles during active work', async () => {
  let idled = false;
  const queue = new CommandQueue({ idleMs: 20, onIdle: () => { idled = true; } });
  const events = [];
  const first = queue.run(async () => { events.push('first'); await delay(50); events.push('first-finished'); });
  const second = queue.run(() => events.push('second'));
  await delay(30);
  assert.equal(idled, false);
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first', 'first-finished', 'second']);
  queue.close();
  await assert.rejects(queue.run(() => {}), /closed/);
});

test('task state switches explicit files, writes atomically, and refuses malformed input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'avs-task-state-'));
  let filename = join(directory, 'first.json');
  const state = new TaskState({ path: () => filename, key: () => 'ext:9335' });
  state.get().curr = '10'; state.save();
  filename = join(directory, 'second.json');
  assert.equal(state.get().curr, null);
  writeFileSync(filename, 'null');
  const invalid = new TaskState({ path: () => filename, key: () => 'ext:9335' });
  assert.throws(() => invalid.get(), /无效任务状态/);
});

test('separate processes cannot concurrently own the same task state', async () => {
  const filename = join(mkdtempSync(join(tmpdir(), 'avs-lock-')), 'state.json');
  const release = await acquireSessionLock(filename);
  await assert.rejects(acquireSessionLock(filename, { timeoutMs: 20 }), /另一条命令/);
  release();
  const again = await acquireSessionLock(filename); again();
});

test('semantic page assertions and deltas describe observed state, not dispatch success', () => {
  const node = { id: 'd1:r1:n1', handle: 'button:展开', role: 'button', name: '展开', states: [], actions: [], sec: 'body' };
  const before = semanticPage([node], { revision: 1, url: 'https://example.com', text: '第一题' });
  const after = semanticPage([{ ...node, states: ['selected'] }], { revision: 2, url: before.url, text: '第二题' });
  assert.equal(diffSemanticPages(before, after).changed.length, 1);
  assert.equal(verifySemanticPage(after, { contains: '第一题' }).status, 'assertion_failed');
  assert.equal(verifySemanticPage(after, { name: '展开', role: 'button', contains: '第二题' }).ok, true);
  const replacement = { ...after, documentId: 'new-document' };
  assert.equal(diffSemanticPages(after, replacement).reset, true);
});

test('isolated evaluation recreates only destroyed contexts and never replays the expression', async () => {
  const methods = [];
  let failed = true;
  const cdp = { send: async (method, params) => {
    methods.push({ method, params });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 };
    if (failed) { failed = false; throw new Error('Cannot find context'); }
    return { result: { value: 'title' } };
  } };
  await assert.rejects(evalJs(cdp, 'document.title'), /context/);
  assert.equal(cdp.__contextId, null);
  assert.equal(methods.filter(entry => entry.method === 'Runtime.evaluate').length, 1);
  assert.equal(await evalJs(cdp, 'document.title'), 'title');
  assert.equal(methods.at(-1).params.contextId, 9);
});

test('practice pacing varies with text and uncertainty and subtracts actual reasoning time', async () => {
  const short = planAnswerTiming('一加一等于几？', { difficulty: 0, minimumMs: 0 });
  const long = planAnswerTiming('请阅读并分析复杂材料。'.repeat(20), { difficulty: 1, uncertainty: 1 });
  assert.ok(long.plannedMs > short.plannedMs);
  assert.equal(planAnswerTiming('短题', { elapsedMs: 45000 }).waitMs, 0);
  assert.equal(planAnswerTiming('长题'.repeat(100), { remainingMs: 1 }).fitsDeadline, false);
  const controller = new AbortController();
  const waiting = waitForAnswerTiming({ fitsDeadline: true, waitMs: 5000 }, { signal: controller.signal });
  controller.abort(new Error('cancelled'));
  await assert.rejects(waiting, /cancelled/);
});

test('custom pairing ports persist in runtime and generated MCP configuration', () => {
  const home = mkdtempSync(join(tmpdir(), 'avs-port-'));
  const first = installAgentSkills({ home, env: { AV_BRIDGE_PORT: '9445' }, agents: 'universal', installDir: join(home, 'runtime') });
  const second = installAgentSkills({ home, env: {}, agents: 'universal', installDir: first.runtime });
  assert.equal(second.bridge_port, 9445);
  assert.equal(JSON.parse(readFileSync(second.mcp_config, 'utf8')).mcpServers.agentviews.env.AV_BRIDGE_PORT, '9445');
  assert.equal(readFileSync(resourcePath('bridge-ext', 'config.js'), 'utf8').includes('token: null'), true);
  const manifest = JSON.parse(readFileSync(resourcePath('package.json'), 'utf8'));
  for (const entry of [...manifest.files, 'package.json']) assert.equal(existsSync(join(second.runtime, entry)), true, entry);
  assert.equal(JSON.parse(readFileSync(join(second.runtime, 'package.json'), 'utf8')).scripts.test, 'node smoke.mjs');
});

test('process discovery uses platform tools and degrades safely on unavailable commands', () => {
  const logs = [];
  const failed = createBrowserRuntime({ exec: () => { throw new Error('unavailable'); }, dbg: (...args) => logs.push(args) });
  assert.deepEqual(failed.chromeRoots(), []);
  assert.deepEqual(logs, [['browser process discovery', 'unavailable']]);
  const windows = createBrowserRuntime({ platform: 'win32', exec: (command, args) => {
    assert.equal(command, 'powershell');
    assert.equal(args[0], '-NoProfile');
    return '123\u0001\u0001"C:\\Apps\\chrome.exe" --remote-debugging-port=9444 --user-data-dir="C:\\My Profile"\n';
  } });
  assert.equal(windows.chromeRoots()[0].debugPort, 9444);
  assert.equal(windows.chromeRoots()[0].ud, 'C:\\My Profile');
});

test('macOS process discovery preserves unquoted spaces and Unicode in profile paths', () => {
  const profile = '/Users/example/Library/Application Support/agentviews/配置 目录';
  for (const suffix of [' --remote-debugging-port=0', ' https://example.com', '']) {
    const runtime = createBrowserRuntime({ platform: 'darwin', exec: (command, args) => {
      assert.equal(command, 'ps');
      assert.equal(args[0], '-ww');
      return '123 /Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=' + profile + suffix + '\n';
    } });
    assert.equal(runtime.chromeRoots()[0].ud, profile);
  }
});

test('Linux process discovery prefers exact NUL-delimited arguments and safely falls back to ps', () => {
  const profile = '/home/example/Profile -- name 中文';
  const command = '123 /usr/bin/chromium --user-data-dir=' + profile + ' --remote-debugging-port=0\n';
  const runtime = createBrowserRuntime({ platform: 'linux', exec: () => command, read: filename => {
    assert.equal(filename, '/proc/123/cmdline');
    return '/usr/bin/chromium\0--user-data-dir=' + profile + '\0--remote-debugging-port=0\0';
  } });
  assert.equal(runtime.chromeRoots()[0].ud, profile);
  const fallback = createBrowserRuntime({ platform: 'linux', exec: () => '123 /usr/bin/chromium --user-data-dir=/home/example/Profile 中文 --remote-debugging-port=0\n',
    read: () => { throw new Error('process exited'); } });
  assert.equal(fallback.chromeRoots()[0].ud, '/home/example/Profile 中文');
});

test('profile paths containing spaces resolve the random DevTools port from the correct file', async () => {
  const profile = '/Users/example/Library/Application Support/agentviews/配置 目录';
  const fetched = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    fetched.push(url);
    return { json: async () => url.endsWith('/json/version') ? { Browser: 'Chromium' } : [{ type: 'page', title: 'Page' }] };
  };
  try {
    const runtime = createBrowserRuntime({ platform: 'darwin', install: () => ({}), defaultUserDataDir: () => profile, extPing: async () => null,
      HOST_STATE: '/missing/host-state.json', exec: () => '123 /Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=' + profile + ' --remote-debugging-port=0\n',
      read: filename => {
        if (filename === join(profile, 'DevToolsActivePort')) return '9444\n/devtools/browser/example\n';
        throw new Error('file not found');
      } });
    const result = await runtime.discoverBrowsers();
    assert.equal(result.browsers[0].profile, profile);
    assert.equal(result.browsers[0].cdp_port, 9444);
    assert.equal(result.browsers[0].attachable, true);
    assert.ok(fetched.includes('http://127.0.0.1:9444/json/version'));
  } finally { globalThis.fetch = originalFetch; }
});

test('source works after relocation to a different directory with spaces and Chinese characters', () => {
  const directory = mkdtempSync(join(tmpdir(), 'avs portable 中文 '));
  const manifest = JSON.parse(readFileSync(resourcePath('package.json'), 'utf8'));
  for (const file of [...manifest.files, 'package.json']) cpSync(resourcePath(file), join(directory, file), { recursive: true });
  const output = execFileSync(process.execPath, [join(directory, 'agentviews.mjs'), 'help'], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, AV_AUTO: '0', AV_EXT: '0', AV_ATTACH_PORT: '', AV_DAEMON: '1' } });
  assert.match(output, /AgentViews/);
  const walk = path => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]);
  for (const file of walk(resourcePath('src')).filter(file => /\.(mjs|js)$/.test(file))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /(?:from\s*|import\s*)['"](?:\/Users\/|\/home\/|[A-Z]:\\)/, file);
  }
});
