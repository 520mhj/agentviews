import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessAction } from '../safety.mjs';
import { createNonce, signRequest } from '../src/transport/auth.mjs';

const execute = promisify(execFile);
const CLI = fileURLToPath(new URL('../agentviews.mjs', import.meta.url));

async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function session(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'avs-cli-test-'));
  const port = await unusedPort();
  const jobs = [];
  const pages = [
    { id: '10', type: 'page', active: false, url: 'https://example.com/other' },
    { id: '20', type: 'page', active: true, url: 'https://example.com/current' },
  ];
  let active = '20';
  let sessionId = 'browser-session-1';
  let login = false;
  let guardChecks = 0;
  let snapshot = options.snapshot || { documentId: 'document1', revision: 1, url: 'https://example.com/current', text: '第1题 已答1/2',
    nodes: [{ role: 'radio', name: '选项B', checked: true, states: ['checked'], actions: [] }] };
  const env = { ...process.env, AV_STATE: join(directory, 'state.json'), AV_BRIDGE_PORT: String(port),
    AV_DAEMON: String(await unusedPort()), AV_AUTO: '0', AV_EXT: '0', AV_ATTACH_PORT: '', AV_BRIDGE_TOKEN: 'a'.repeat(64) };
  const peerSession = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const headers = (method, path, body = '') => {
    const nonce = createNonce();
    return { 'x-av-nonce': nonce, 'x-av-session': peerSession, 'x-av-auth': signRequest(env.AV_BRIDGE_TOKEN, method, path, nonce, body, peerSession) };
  };
  const respond = job => {
    jobs.push(job);
    if (job.op === 'ping') return { extension: 'a'.repeat(32), version: '1.0.0', attached: [], session_id: sessionId };
    if (job.op === 'tabs.list') return pages;
    if (job.op === 'tabs.current') return pages.find(page => page.id === active);
    if (job.op === 'debugger.detachAll') return { detached: 1 };
    if (job.op === 'tabs.preserve') return { preserved: true };
    if (job.op === 'tabs.create') {
      const page = { id: '30', type: 'page', url: job.args.url };
      pages.push(page); return page;
    }
    if (job.op !== 'debugger.send') throw new Error('unexpected job: ' + job.op);
    const { method, params } = job.args;
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 7 } };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame1' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') {
      if (options.keyFailure) throw new Error('key dispatch unavailable');
      if (options.loginAfterSearch) login = true;
    }
    if (method !== 'Runtime.evaluate') return {};
    if (params.throwOnSideEffect) return { exceptionDetails: { text: 'Possible side-effect in debug-evaluate' } };
    const expression = params.expression;
    if (expression === 'window.__avUploadInput' && params.returnByValue === false) return { result: { objectId: 'upload1' } };
    let value = true;
    if (expression.includes('window.__avAssessAction=')) value = { kept: 2, view_chars: 20, compression_x: 1 };
    else if (expression === 'window.__av.snapshot') value = snapshot;
    else if (expression === '__av.searchCandidates()') value = options.searchTargets || [];
    else if (expression.includes('function inspectLoginPage')) value = { need_login: login, url: login ? 'https://example.com/user/login.aspx' : 'https://example.com/current' };
    else if (expression.includes('window.__avGuardKey ?')) value = { ok: true };
    else if (expression.includes('window.__avGuardUpload ?')) value = { ok: true };
    else if (expression.includes('window.__avGuardHit ?')) value = ++guardChecks > 1 && options.clickFallback ? options.clickFallback : { ok: true };
    else if (expression.includes('(window.__avClicks||[]).length>0')) value = false;
    else if (expression.includes('const G = { search')) value = { capabilities: [], site: 'https://example.com/current', title: 'Current', total_nodes: 2 };
    else if (expression.startsWith('window.__avVerifyPage(__av.snapshot,')) value = { ok: snapshot.text.includes(JSON.parse(expression.slice('window.__avVerifyPage(__av.snapshot,'.length, -1)).contains) };
    else if (expression.startsWith('__av.read(')) value = { ok: true, text: 'x' };
    else if (expression.startsWith('JSON.stringify(__av.act(')) {
      const payload = JSON.parse(expression.slice('JSON.stringify(__av.act('.length, -2));
      if (options.actionFailure) return { result: { value: JSON.stringify(options.actionFailure) } };
      const scope = JSON.stringify({ document: snapshot.documentId, text: snapshot.text });
      if (payload.preview) return { result: { value: JSON.stringify({ ok: false, status: 'needs_user_action', approval_scope: scope }) } };
      const permission = payload.approval?.scope === scope ? { ok: true }
        : assessAction({ ...payload, role: 'button', safeSearch: options.safeSearch, effects: payload.verb === 'press_enter' ? ['form_submit'] : ['state_change'] });
      value = JSON.stringify(permission.ok && payload.verb === 'press_enter' ? { ok: true, key: 'Enter' }
        : permission.ok && payload.verb === 'upload_files' ? { ok: true, file_upload: { method: payload.upload_mode === 'drop' ? 'trusted_drag_drop' : 'native_file_input', point: [10, 20] } }
        : permission.ok && options.clickFallback && payload.verb === 'click' ? { ok: true, point: [10, 20] }
        : permission.confirmation_required ? { ...permission, approval_scope: scope } : permission);
    } else if (expression.startsWith('({url:location.href')) value = { url: 'https://example.com/result', title: 'Result', text: 'User completed the step' };
    else if (expression.includes('__av.settle(')) value = JSON.stringify({ reason: 'stable', settled_ms: 1 });
    else if (expression === 'location.href') value = login ? 'https://example.com/user/login.aspx' : 'https://example.com/current';
    else if (expression === 'document.readyState') value = 'complete';
    else if (expression.includes('nodes: __av.nodes.length')) value = JSON.stringify({ url: 'https://example.com/current', selected: [], checked: 0, nodes: 2 });
    return { result: { value } };
  };
  const run = async (...args) => {
    const controller = new AbortController();
    let stopped = false;
    const poll = (async () => {
      while (!stopped) {
        try {
          const response = await fetch('http://127.0.0.1:' + port + '/pull', { signal: controller.signal, headers: headers('GET', '/pull') });
          const job = await response.json();
          if (job.id) {
            let result;
            try { result = { id: job.id, ok: true, result: respond(job) }; }
            catch (error) { result = { id: job.id, ok: false, error: error.message }; }
            const body = JSON.stringify(result);
            await fetch('http://127.0.0.1:' + port + '/push', { method: 'POST', body, headers: headers('POST', '/push', body), signal: controller.signal });
          }
        } catch {
          if (!stopped) await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
    })();
    try {
      const output = await execute(process.execPath, [CLI, '--ext', ...args], { env, timeout: 10000 });
      return JSON.parse(output.stdout);
    } finally { stopped = true; controller.abort(); await poll; }
  };
  return { run, jobs, env, setActive: value => { active = value; }, setSession: value => { sessionId = value; },
    setLogin: value => { login = value; },
    setSnapshot: value => { snapshot = value; },
    state: () => JSON.parse(readFileSync(env.AV_STATE, 'utf8')) };
}

test('CLI consumes a matching explicit confirmation once and does not expose raw binding material', async () => {
  const browser = await session();
  await browser.run('--current', 'map', '--json');
  const request = await browser.run('act', '--name', '提交', '--json');
  assert.ok(request.confirmation.request_id);
  assert.equal(request.approval_scope, undefined);
  assert.equal(request.confirmation.binding_key, undefined);
  const requestId = request.confirmation.request_id;
  const missing = await browser.run('act', '--name', '提交', '--confirm', requestId, '--json');
  assert.equal(missing.reason, 'explicit_user_confirmation_required');
  const negative = await browser.run('act', '--name', '提交', '--confirm', requestId, '--user-confirmed', 'false', '--json');
  assert.equal(negative.reason, 'explicit_user_confirmation_required');
  const changed = await browser.run('act', '--name', '删除', '--confirm', requestId, '--user-confirmed', '--json');
  assert.equal(changed.reason, 'confirmation_action_changed');
  const confirmed = await browser.run('act', '--name', '提交', '--confirm', requestId, '--user-confirmed', '--json');
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.confirmation_consumed, true);
  assert.equal(browser.state().action_confirmation, null);
  assert.equal(browser.state().pending_user_action, null);
  const replay = await browser.run('act', '--name', '提交', '--confirm', requestId, '--user-confirmed', '--json');
  assert.equal(replay.reason, 'confirmation_not_found');
});

test('page changes invalidate and consume confirmation without dispatching the action', async () => {
  const browser = await session();
  await browser.run('--current', 'map', '--json');
  const request = await browser.run('act', '--name', '提交', '--json');
  browser.setSnapshot({ documentId: 'document2', text: 'changed', nodes: [] });
  const count = browser.jobs.filter(job => job.args?.params?.expression?.startsWith('JSON.stringify(__av.act(')).length;
  const confirmed = await browser.run('act', '--name', '提交', '--confirm', request.confirmation.request_id, '--user-confirmed', '--json');
  assert.equal(confirmed.reason, 'confirmation_page_changed');
  assert.equal(browser.state().action_confirmation, null);
  assert.equal(browser.state().pending_user_action.reason, 'confirmation_consumed');
  assert.equal(browser.jobs.filter(job => job.args?.params?.expression?.startsWith('JSON.stringify(__av.act(')).length, count + 1);
  const declined = await browser.run('resume', '--decline', '--request-id', request.confirmation.request_id);
  assert.equal(declined.executed, false);
  assert.equal(browser.state().pending_user_action, null);
});

test('declining a request requires its ID and does not execute or retain an approval', async () => {
  const browser = await session();
  await browser.run('--current', 'map', '--json');
  const request = await browser.run('act', '--name', '提交', '--json');
  await assert.rejects(browser.run('resume', '--decline', '--request-id', 'wrong'), /取消确认需要匹配/);
  const result = await browser.run('resume', '--decline', '--request-id', request.confirmation.request_id);
  assert.equal(result.executed, false);
  assert.equal(browser.state().action_confirmation, null);
  assert.equal(browser.state().pending_user_action, null);
});

test('unknown confirmed dispatch outcomes retain a consumed request and never replay it', async () => {
  const browser = await session({ keyFailure: true });
  await browser.run('--current', 'map', '--json');
  const request = await browser.run('act', '--name', '搜索', '--key', 'Enter', '--json');
  const confirmed = await browser.run('act', '--name', '搜索', '--key', 'Enter', '--confirm', request.confirmation.request_id, '--user-confirmed', '--json');
  assert.equal(confirmed.reason, 'key_dispatch_failed');
  assert.equal(browser.state().action_confirmation, null);
  assert.equal(browser.state().pending_user_action.reason, 'confirmation_consumed');
  const attempts = browser.jobs.filter(job => job.args?.method === 'Input.dispatchKeyEvent').length;
  const replay = await browser.run('act', '--name', '搜索', '--key', 'Enter', '--confirm', request.confirmation.request_id, '--user-confirmed', '--json');
  assert.equal(replay.reason, 'confirmation_not_found');
  assert.equal(browser.jobs.filter(job => job.args?.method === 'Input.dispatchKeyEvent').length, attempts);
});

test('cancelling a task revokes its outstanding action confirmation', async () => {
  const browser = await session();
  await browser.run('--current', 'map', '--json');
  await browser.run('task', 'start', '--authorized', '--goal', '发布草稿', '--total', '1');
  const request = await browser.run('act', '--name', '发布', '--json');
  await browser.run('task', 'cancel');
  assert.equal(browser.state().action_confirmation, null);
  const replay = await browser.run('act', '--name', '发布', '--confirm', request.confirmation.request_id, '--user-confirmed', '--json');
  assert.equal(replay.reason, 'confirmation_not_found');
  assert.equal(browser.jobs.some(job => /^Input\./.test(job.args?.method || '')), false);
});

test('CLI pins the explicitly selected user tab and keeps it on done', async () => {
  const browser = await session();
  assert.equal((await browser.run('--current', 'map', '--json')).title, 'Current');
  browser.setActive('10');
  await browser.run('verify');
  const targets = browser.jobs.filter(job => job.op === 'debugger.send').map(job => job.args.tabId);
  assert.ok(targets.every(tabId => tabId === '20'));
  assert.equal(browser.jobs.some(job => job.op === 'tabs.create'), false);
  assert.equal(browser.jobs.some(job => job.args.method === 'Page.bringToFront'), false);
  assert.equal(browser.jobs.some(job => job.args.method === 'Page.addScriptToEvaluateOnNewDocument'), false);
  assert.equal((await browser.run('done')).mode, 'keep');
  assert.deepEqual(browser.jobs.find(job => job.op === 'debugger.detachAll').args.tabIds, ['20']);
  assert.equal(browser.jobs.some(job => job.op === 'tabs.close'), false);
});

test('keep retains an explicitly selected user target across subsequent calls without opening a replacement', async () => {
  const browser = await session();
  await browser.run('--current', 'map', '--json');
  await browser.run('keep');
  browser.setActive('10');
  await browser.run('act', '--name', '展开', '--json');
  assert.equal(browser.state().curr, '20');
  assert.equal(browser.state().user_current, '20');
  assert.equal(browser.jobs.some(job => job.op === 'tabs.create'), false);
});

test('CLI file upload binds explicit local bytes, requests consent and dispatches only once', async () => {
  const browser = await session();
  const filename = join(mkdtempSync(join(tmpdir(), 'avs-cli-upload-')), 'module.mjs');
  writeFileSync(filename, 'export const value = 1;');
  const paths = JSON.stringify([filename]);
  await browser.run('--current', 'map', '--json');
  const request = await browser.run('act', '--name', 'Choose files', '--role', 'fileinput', '--files', paths, '--json');
  assert.equal(request.reason, 'file_upload');
  assert.equal(request.operation.files.file_count, 1);
  assert.equal(JSON.stringify(browser.state()).includes(filename), false);
  assert.equal(browser.jobs.some(job => job.args?.method === 'DOM.setFileInputFiles'), false);
  writeFileSync(filename, 'changed');
  const changed = await browser.run('act', '--name', 'Choose files', '--role', 'fileinput', '--files', paths, '--confirm', request.confirmation.request_id, '--user-confirmed', '--json');
  assert.equal(changed.reason, 'confirmation_action_changed');
  writeFileSync(filename, 'export const value = 1;');
  const confirmed = await browser.run('act', '--name', 'Choose files', '--role', 'fileinput', '--files', paths, '--confirm', request.confirmation.request_id, '--user-confirmed', '--json');
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.act.upload.file_count, 1);
  assert.equal(confirmed.status, 'requires_verification');
  assert.equal(browser.jobs.filter(job => job.args?.method === 'DOM.setFileInputFiles').length, 1);
  assert.equal(browser.jobs.some(job => job.args?.method === 'Runtime.releaseObject'), true);
});

test('long tasks keep the original page and progress across keep and Agent-recovery errors', async () => {
  const browser = await session({ actionFailure: { ok: false, status: 'needs_agent_review', reason: 'no_such_name' } });
  await browser.run('--current', 'map', '--json');
  const started = await browser.run('task', 'start', '--authorized', '--goal', '授权练习', '--total', '2');
  assert.equal(started.task.status, 'active');
  await browser.run('keep');
  browser.setActive('10');
  assert.equal(browser.state().user_current, '20');
  await browser.run('act', '--name', '未知控件', '--json');
  assert.equal(browser.state().long_task.status, 'recovering');
  const watched = await browser.run('task', 'watch', '--timeout', '0');
  assert.equal(watched.task.should_continue, true);
  assert.equal(watched.task.tab, '20');
  assert.equal(browser.jobs.some(job => job.op === 'tabs.create' || job.args.method === 'Page.bringToFront'), false);
  await assert.rejects(browser.run('--current', 'map', '--json'), /长任务已固定/);
  await assert.rejects(browser.run('tab', 'new'), /长任务期间/);
  await browser.run('task', 'cancel');
  assert.equal(browser.state().long_task.status, 'cancelled');
  assert.equal(browser.jobs.some(job => job.op === 'tabs.close'), false);
});

test('long-task manual waiting keeps listening but cannot auto-resume or claim completion', async () => {
  const browser = await session();
  await browser.run('--current', 'map', '--json');
  await browser.run('task', 'start', '--authorized', '--goal', '授权练习', '--total', '1');
  assert.equal((await browser.run('act', '--name', '确认付款', '--json')).status, 'needs_user_action');
  const watched = await browser.run('task', 'watch', '--timeout', '0');
  assert.equal(watched.task.status, 'waiting_user');
  assert.equal(browser.state().pending_user_action.reason, 'sensitive_action');
  await assert.rejects(browser.run('task', 'checkpoint', '--step', '1', '--contains', '第1题', '--name', '选项B', '--role', 'radio', '--checked', 'true'), /人工等待/);
  await browser.run('resume', '--user-done');
  assert.equal(browser.state().long_task.status, 'verifying');
  const checkpoint = await browser.run('task', 'checkpoint', '--step', '1', '--contains', '第1题', '--name', '选项B', '--role', 'radio', '--checked', 'true');
  assert.equal(checkpoint.task.completed_steps, 1);
  browser.setSnapshot({ documentId: 'document1', revision: 2, url: 'https://example.com/current', text: '第1题 已答1/1',
    nodes: [{ role: 'radio', name: '选项B', checked: true, states: ['checked'], actions: [] }] });
  const ready = await browser.run('task', 'ready', '--contains', '已答1/1');
  assert.equal(ready.task.status, 'awaiting_submission');
  assert.equal(ready.task.agent_work_completed, true);
  const submission = await browser.run('act', '--name', '交卷', '--json');
  assert.equal(submission.status, 'needs_user_action');
  assert.ok(submission.confirmation.request_id);
  await browser.run('resume', '--decline', '--request-id', submission.confirmation.request_id);
  await browser.run('keep');
  assert.equal(browser.state().user_current, '20');
  await assert.rejects(browser.run('task', 'submitted', '--contains', '交卷成功'), /明确反馈/);
  browser.setSnapshot({ documentId: 'result1', revision: 1, url: 'https://example.com/result', text: '交卷成功', nodes: [] });
  const submitted = await browser.run('task', 'submitted', '--user-done', '--contains', '交卷成功');
  assert.equal(submitted.task.task_completed, true);
  assert.equal(browser.jobs.some(job => job.op === 'tabs.create' || job.op === 'tabs.close'), false);
});

test('coding preflight is read-only and early result evidence interrupts without claiming completed answers', async () => {
  const browser = await session({ snapshot: { documentId: 'code1', revision: 1, url: 'https://example.com/code', text: '第1题',
    nodes: [{ id: 'code1:r1:n1', name: '代码编辑器', role: 'textbox', editor: 'native_textarea', value: 'const answer=42;', states: [], actions: [] }] } });
  await browser.run('--current', 'map', '--json');
  const preflight = await browser.run('task', 'preflight');
  assert.equal(preflight.status, 'editor_detected_unverified');
  assert.equal(preflight.editors[0].live_writing_verified, false);
  assert.equal(browser.jobs.some(job => job.op === 'tabs.create' || job.args.method?.startsWith('Input.')), false);
  await browser.run('task', 'start', '--kind', 'coding', '--authorized', '--goal', '编程练习', '--total', '2');
  assert.equal((await browser.run('task', 'checkpoint', '--step', '1', '--contains', '第1题', '--name', '代码编辑器', '--role', 'textbox', '--value', 'const answer=42;', '--origin', 'agent')).ok, true);
  browser.setSnapshot({ documentId: 'result1', revision: 1, url: 'https://example.com/result', text: '考试已结束', nodes: [] });
  const interrupted = await browser.run('task', 'interrupt', '--contains', '考试已结束');
  assert.equal(interrupted.task.status, 'interrupted');
  assert.equal(interrupted.task.task_completed, false);
  assert.equal(interrupted.task.completed_steps, 1);
  assert.equal((await browser.run('act', '--name', '交卷', '--json')).status, 'interrupted');
  assert.equal(browser.jobs.some(job => job.op === 'tabs.close'), false);
});

test('doctor verifies only the extension transport and does not select, create or visit a tab', async () => {
  const browser = await session();
  const result = await browser.run('doctor', '--json');
  assert.equal(result.status, 'bridge_ready');
  assert.equal(result.website_requested, false);
  assert.equal(result.tabs_created, 0);
  assert.ok(browser.jobs.every(job => job.op === 'ping'));
  assert.equal(existsSync(browser.env.AV_STATE), false);
});

test('doctor reports an absent peer instead of instructing an unconditional extension reload', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'avs-doctor-'));
  const state = join(directory, 'state.json');
  const result = await execute(process.execPath, [CLI, 'doctor', '--json', '--timeout', '1', '--state', state], {
    timeout: 5000, env: { ...process.env, AV_BRIDGE_TOKEN: 'a'.repeat(64), AV_BRIDGE_PORT: String(await unusedPort()) },
  });
  const failure = JSON.parse(result.stdout);
  assert.equal(failure.reason, 'extension_not_polling');
  assert.equal(failure.task_delivered, false);
  assert.equal(failure.diagnostics.received_requests, 0);
  assert.equal(existsSync(state), false);
});

test('CLI never dispatches or replays blocked payment actions', async () => {
  const browser = await session();
  await browser.run('--current', 'map', '--json');
  assert.equal((await browser.run('act', '--name', '确认付款', '--json')).status, 'needs_user_action');
  assert.equal(browser.state().pending_user_action.reason, 'sensitive_action');
  assert.equal((await browser.run('done')).mode, 'keep');
  assert.equal((await browser.run('resume', '--user-done')).replayed, false);
  assert.equal(browser.state().pending_user_action, null);
  assert.equal(browser.jobs.some(job => /^Input\./.test(job.args.method || '')), false);
  assert.equal(browser.jobs.some(job => job.op === 'tabs.close'), false);
});

test('CLI eval uses the CDP side-effect-free evaluator', async () => {
  const browser = await session();
  await browser.run('--current', 'map', '--json');
  const output = await browser.run('eval', 'document.querySelector("button").click()');
  assert.equal(output.status, 'read_only_eval_rejected');
  assert.ok(browser.jobs.some(job => job.args.params?.throwOnSideEffect === true));
});

test('an out-of-range tab index never falls back to a user page', async () => {
  const browser = await session();
  await assert.rejects(browser.run('tab', 'use', '#999'), /找不到标签页/);
  assert.equal(browser.jobs.some(job => job.op === 'tabs.create'), false);
  assert.equal(browser.jobs.some(job => job.op === 'debugger.send'), false);
});

test('browser restart never reuses a recycled tab ID for an existing current-tab task', async () => {
  const browser = await session();
  await browser.run('--current', 'map', '--json');
  browser.setSession('browser-session-2');
  await assert.rejects(browser.run('verify'), /浏览器会话已经改变/);
  assert.equal(browser.jobs.some(job => job.op === 'tabs.create'), false);
});

test('a normal task stays on the user-completed page after handoff and resume', async () => {
  const browser = await session();
  await browser.run('tab', 'new', 'https://example.com/product');
  await browser.run('act', '--name', '确认付款', '--json');
  await browser.run('keep');
  await browser.run('resume', '--user-done');
  await browser.run('verify');
  assert.equal(browser.state().user_current, '30');
  assert.equal(browser.jobs.filter(job => job.op === 'tabs.create').length, 1);
});

test('search and unknown controls ask for Agent recovery without pending human state or URL guesses', async () => {
  const browser = await session({ actionFailure: { ok: false, status: 'needs_agent_review', reason: 'no_such_name' } });
  await browser.run('--current', 'map', '--json');
  assert.equal((await browser.run('search', 'poem', '--json')).reason, 'search_target_not_found');
  assert.equal((await browser.run('act', '--name', '未知控件', '--json')).status, 'needs_agent_review');
  assert.equal(browser.state().pending_user_action, null);
  assert.equal(browser.jobs.some(job => job.args.method === 'Page.navigate'), false);
  assert.equal(browser.jobs.some(job => /^Input\./.test(job.args.method || '')), false);
});

test('search reaches a login wall and resumes only after real login evidence', async () => {
  const browser = await session({ searchTargets: [{ id: 'n1', name: 'value' }], safeSearch: true, loginAfterSearch: true });
  await browser.run('--current', 'map', '--json');
  const result = await browser.run('search', '不第后赋菊', '--json');
  assert.equal(result.reason, 'login_required');
  assert.deepEqual(result.choices, ['login_and_continue', 'skip_task']);
  assert.equal(browser.state().pending_user_action.tab, '20');
  assert.equal((await browser.run('resume', '--user-done')).reason, 'login_required');
  const before = browser.jobs.filter(job => job.args.method === 'Input.dispatchKeyEvent').length;
  browser.setLogin(false);
  assert.equal((await browser.run('resume', '--user-done')).replayed, false);
  assert.equal(browser.state().pending_user_action, null);
  assert.equal(browser.jobs.filter(job => job.args.method === 'Input.dispatchKeyEvent').length, before);
  assert.equal(browser.jobs.some(job => job.args.method === 'Page.navigate' || job.args.method === 'Page.bringToFront' || job.op === 'tabs.create'), false);
  assert.equal((await browser.run('done')).mode, 'keep');
});

test('user-declared login skip clears waiting but preserves the page', async () => {
  const browser = await session({ searchTargets: [{ id: 'n1', name: 'value' }], safeSearch: true, loginAfterSearch: true });
  await browser.run('--current', 'map', '--json');
  await browser.run('search', 'poem', '--json');
  assert.equal((await browser.run('resume', '--skip')).status, 'task_skipped');
  assert.equal(browser.state().pending_user_action, null);
  assert.equal((await browser.run('keep')).kept, true);
  assert.equal(browser.jobs.some(job => job.op === 'tabs.close'), false);
});

test('Enter dispatch failure remains recoverable and always sends keyUp cleanup', async () => {
  const browser = await session({ safeSearch: true, keyFailure: true });
  await browser.run('--current', 'map', '--json');
  const result = await browser.run('act', '--name', 'value', '--key', 'Enter', '--json');
  assert.equal(result.reason, 'key_dispatch_failed');
  assert.equal(browser.jobs.some(job => job.args.method === 'Input.dispatchKeyEvent' && job.args.params.type === 'keyUp'), true);
  assert.equal(browser.state().pending_user_action, null);
});

test('same-URL search is unverified, never replaced with an invented navigation', async () => {
  const browser = await session({ searchTargets: [{ id: 'n1', name: 'value' }], safeSearch: true });
  await browser.run('--current', 'map', '--json');
  const result = await browser.run('search', 'poem', '--json');
  assert.equal(result.status, 'requires_verification');
  assert.equal(result.task_completed, false);
  assert.equal(browser.jobs.some(job => job.args.method === 'Page.navigate'), false);
  assert.equal(browser.state().pending_user_action, null);
});

test('ambiguous search discovery asks the Agent to select without typing or submitting', async () => {
  const browser = await session({ searchTargets: [{ id: 'n1', name: 'query' }, { id: 'n2', name: 'query' }] });
  await browser.run('--current', 'map', '--json');
  const result = await browser.run('search', 'poem', '--json');
  assert.equal(result.reason, 'ambiguous_search_target');
  assert.equal(result.candidates.length, 2);
  assert.equal(browser.jobs.some(job => job.args.method === 'Input.dispatchKeyEvent' || job.args.method === 'Page.navigate'), false);
});

test('a rechecked fallback block is returned as a handoff, not successful dispatch', async () => {
  const browser = await session({ clickFallback: { ok: false, status: 'needs_user_action', reason: 'sensitive_context' } });
  await browser.run('--current', 'map', '--json');
  const result = await browser.run('act', '--name', '展开', '--json');
  assert.equal(result.reason, 'sensitive_context');
  assert.equal(browser.state().pending_user_action.reason, 'sensitive_context');
});
