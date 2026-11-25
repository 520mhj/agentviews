import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectBrowsers, findUserDataDir } from '../chrome-detect.mjs';
import { assessAction, validateNavigation, SAFETY_SOURCE } from '../safety.mjs';
import { agentDirectories, installAgentSkills, initialize } from '../setup.mjs';
import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';

const unavailable = () => { throw new Error('not installed'); };

test('macOS discovers both system and user application bundles', () => {
  const installed = new Set([
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Users/example/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ]);
  const found = detectBrowsers({ platform: 'darwin', home: '/Users/example', env: {}, exists: filename => installed.has(filename), exec: unavailable });
  assert.deepEqual(found.map(browser => browser.product), ['chrome', 'edge']);
  assert.equal(findUserDataDir(found[0].exe, { platform: 'darwin', home: '/Users/example', env: {} }), '/Users/example/Library/Application Support/Google/Chrome');
  assert.equal(findUserDataDir(found[1].exe, { platform: 'darwin', home: '/Users/example', env: {} }), '/Users/example/Library/Application Support/Microsoft Edge');
});

test('Windows discovers a custom App Paths installation and expanded environment', () => {
  const exe = 'D:\\Applications\\Chrome\\chrome.exe';
  const found = detectBrowsers({ platform: 'win32', home: 'C:\\Users\\example', env: { CUSTOM: 'D:\\Applications' },
    exists: filename => filename === exe,
    exec: (command, args) => {
      if (command === 'reg' && args[1].endsWith('\\chrome.exe')) return '    (Default)    REG_EXPAND_SZ    %CUSTOM%\\Chrome\\chrome.exe\n';
      throw new Error('not installed');
    } });
  assert.equal(found[0].exe, exe);
  assert.equal(findUserDataDir(exe, { platform: 'win32', home: 'C:\\Users\\example', env: {} }), 'C:\\Users\\example\\AppData\\Local\\Google\\Chrome\\User Data');
});

test('Linux discovers PATH and respects XDG configuration', () => {
  const found = detectBrowsers({ platform: 'linux', home: '/home/example', env: { PATH: '/custom/bin' },
    exists: filename => filename === '/custom/bin/brave-browser', exec: unavailable });
  assert.equal(found[0].product, 'brave');
  assert.equal(findUserDataDir(found[0].exe, { platform: 'linux', home: '/home/example', env: { XDG_CONFIG_HOME: '/data/config' } }), '/data/config/BraveSoftware/Brave-Browser');
});

test('an invalid explicit executable does not silently select another browser', () => {
  assert.deepEqual(detectBrowsers({ env: { AV_CHROME: '/missing/browser' }, exists: () => false }), []);
});

test('sensitive and unclassified operations default to explicit user confirmation', () => {
  for (const name of ['付款', '确认购买', '删除资源', '提交', '交卷', '发送', '续费', '自动续费', 'Pay now', 'Delete', 'Submit']) {
    assert.equal(assessAction({ name, verb: 'click', role: 'button', effects: ['state_change'] }).status, 'needs_user_action', name);
  }
  assert.equal(assessAction({ name: '无名称动作', verb: 'click', role: 'button' }).reason, 'unclassified_action');
  assert.equal(assessAction({ name: 'Confirm', verb: 'click', role: 'button' }).status, 'needs_user_action');
  assert.equal(assessAction({ name: '密码', verb: 'set_value', inputType: 'password' }).reason, 'private_input');
  assert.equal(assessAction({ name: '保存', verb: 'click', effects: ['form_submit'] }).reason, 'form_submission');
  assert.equal(assessAction({ name: '搜索', verb: 'click', safeSearch: true, effects: ['form_submit'] }).ok, true);
});

test('low-risk reads and controls remain usable', () => {
  assert.equal(assessAction({ name: '支付文档', role: 'link', href: 'https://example.com/docs/payment', verb: 'click' }).ok, true);
  assert.equal(assessAction({ name: '展开', verb: 'click', role: 'button', effects: ['panel_visibility'] }).ok, true);
  assert.equal(assessAction({ name: '关键词', verb: 'set_value', role: 'textbox' }).ok, true);
  assert.equal(validateNavigation('https://example.com').ok, true);
  assert.equal(validateNavigation('https://example.com/delete?id=1').status, 'needs_user_action');
  assert.throws(() => validateNavigation('javascript:alert(1)'));
  assert.throws(() => validateNavigation('https://user:secret@example.com'));
});

test('the browser-side safety policy matches the Node policy', () => {
  const sandbox = { window: {} };
  runInNewContext(SAFETY_SOURCE, sandbox);
  const action = { name: '确认付款', verb: 'click', role: 'button' };
  assert.equal(sandbox.window.__avAssessAction(action).reason, assessAction(action).reason);
});

test('installation is self-contained, respects agent homes, and refuses collisions', () => {
  const home = mkdtempSync(join(tmpdir(), 'avs-install-test-'));
  const env = { CODEX_HOME: join(home, 'custom-codex'), CLAUDE_CONFIG_DIR: join(home, 'custom-claude') };
  const directories = agentDirectories({ home, env });
  const installed = installAgentSkills({ home, env, agents: 'universal,codex,claude', installDir: join(home, 'runtime') });
  assert.equal(installed.installed_skills.length, 3);
  assert.ok(existsSync(join(directories.codex, 'agentviews', 'SKILL.md')));
  const runner = join(directories.claude, 'agentviews', 'scripts', 'avs.mjs');
  const output = execFileSync(process.execPath, [runner, 'help'], { encoding: 'utf8', env: { ...process.env, AV_STATE: join(home, 'state.json'), AV_DAEMON: '1' } });
  assert.match(output, /agentviews/i);
  assert.equal(JSON.parse(readFileSync(installed.mcp_config, 'utf8')).mcpServers.agentviews.args[0], join(installed.runtime, 'mcp.mjs'));
  assert.doesNotThrow(() => installAgentSkills({ home, env, agents: 'universal,codex', installDir: installed.runtime }));
  mkdirSync(join(directories.cursor, 'agentviews'), { recursive: true });
  assert.throws(() => installAgentSkills({ home, env, agents: 'cursor', installDir: installed.runtime }), /拒绝覆盖/);
  assert.throws(() => installAgentSkills({ home, env, agents: 'unknown', installDir: installed.runtime }), /未知 Agent/);
});

test('initialization announces readiness only after verification and tab creation', async () => {
  const installed = { runtime: '/runtime', extension_path: '/runtime/bridge-ext' };
  let created = 0;
  const options = { installed, install: {}, ping: async () => ({ extension: 'id', session_id: 'session' }),
    createTab: async () => { created++; return { id: 'tab' }; } };
  const ready = await initialize('verify', options);
  assert.equal(ready.status, 'ready');
  assert.equal(created, 1);
  const waiting = await initialize('verify', { ...options, ping: async () => null });
  assert.equal(waiting.status, 'needs_extension_import');
  assert.equal(waiting.extension_verified, false);
  assert.equal(created, 1);
});

test('manual and unsupported automatic setup wait for the user without false success', async () => {
  let launches = 0;
  const options = { installed: { runtime: '/runtime', extension_path: '/runtime/bridge-ext' },
    install: { product: 'chrome', exe: '/browser', user_data_dir: '/profile' },
    ping: async () => null, launch: async () => { launches++; }, createTab: async () => assert.fail('must not create task tab') };
  assert.equal((await initialize('auto', options)).status, 'needs_extension_import');
  assert.equal((await initialize('manual', options)).status, 'needs_extension_import');
  assert.equal(launches, 2);
});

test('automatic loading uses an isolated profile and still requires a verified extension', async () => {
  let probes = 0;
  let launch;
  const ready = await initialize('auto', {
    installed: { runtime: '/runtime', extension_path: '/runtime/bridge-ext' },
    install: { product: 'chromium', exe: '/chromium', user_data_dir: '/user/profile' },
    ping: async () => ++probes === 1 ? null : { extension: 'id', session_id: 'session' },
    launch: async options => { launch = options; },
    createTab: async () => ({ id: 'new-tab' }),
  });
  assert.equal(launch.userDataDir, '/runtime/extension-profile');
  assert.equal(launch.extension, '/runtime/bridge-ext');
  assert.equal(ready.status, 'ready');
});

test('an old extension reply or failed tab creation never counts as initialized', async () => {
  const options = { installed: { runtime: '/runtime', extension_path: '/runtime/bridge-ext' },
    install: {}, ping: async () => ({ extension: 'id' }), createTab: async () => null };
  assert.equal((await initialize('verify', options)).status, 'needs_extension_import');
  await assert.rejects(initialize('verify', { ...options, ping: async () => ({ extension: 'id', session_id: 'session' }) }), /未成功创建标签页/);
});
