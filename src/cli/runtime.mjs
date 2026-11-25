import { createBrowserRuntime } from '../platform/browser-runtime.mjs';
import { TaskState } from '../core/task-state.mjs';
import { CommandQueue } from '../core/command-queue.mjs';
import { acquireSessionLock } from '../core/session-lock.mjs';
import { createReadCommands } from './commands/read.mjs';
import { createActionCommands } from './commands/action.mjs';
import { createLoginCommands } from './commands/login.mjs';
import { createTaskCommands } from './commands/task.mjs';
import { createWatchCommands } from './commands/watch.mjs';
import { PageWatchStore, isPageWatchActive } from '../core/page-watch.mjs';
import { isLongTaskOpen, expireLongTask, longTaskSummary, recordLongTaskResult } from '../core/long-task.mjs';
import { ROOT_DIRECTORY } from '../core/paths.mjs';
import { parse } from '../core/arguments.mjs';
import { createBrowserSource, MAP_SRC, COLLECT_SRC } from '../browser/source.mjs';
import { CDP } from '../transport/cdp.mjs';
import { DaemonAuthenticator, daemonRequest } from '../transport/daemon-auth.mjs';
import { bridgeFailure } from '../transport/bridge-diagnostics.mjs';
import { evalJs } from '../browser/evaluate.mjs';
import { readBridgeToken, readBridgeConfiguration } from '../setup/bridge-pairing.mjs';

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { AvBridge } from '../transport/avbridge.mjs';
import { describeInstall, applicationDataDir } from '../platform/browser-discovery.mjs';
import { launchBrowser } from '../platform/browser-launch.mjs';
import { initialize, installAgentSkills } from '../setup/install.mjs';
import { SAFETY_SOURCE, validateNavigation, agentRecovery, inspectLoginPage } from '../policy/actions.mjs';

const HERE = ROOT_DIRECTORY;

const PORT = Number(process.env.AV_PORT || 9333);
const DAEMON = Number(process.env.AV_DAEMON || 9334);

let _install = null;
function install() { return _install || (_install = describeInstall()); }
function defaultUserDataDir() { return install().user_data_dir; }
function browserExe() {
  const e = install().exe;
  if (!e) throw new Error('找不到 Chromium 浏览器：已检查当前系统的安装目录与 PATH，可设 AV_CHROME 指向可执行文件');
  return e;
}

let ATTACH_PORT = null;
const curPort = () => ATTACH_PORT || PORT;

const defaultPairingRuntime = existsSync(join(HERE, 'bridge-auth.json')) ? HERE : applicationDataDir();
let BRIDGE_PORT = Number(process.env.AV_BRIDGE_PORT || (existsSync(join(defaultPairingRuntime, 'bridge-auth.json')) ? readBridgeConfiguration(defaultPairingRuntime).port : 9335));
let EXT_MODE = false;
let BRIDGE = null;
let LAST_EXT_ERROR = null;
let pairingRuntime = existsSync(join(HERE, 'bridge-auth.json')) ? HERE : applicationDataDir();
const isExt = () => EXT_MODE;
const browserLabel = () => isExt()
  ? 'desktop-main-chrome (via AgentViews CDP Bridge)'
  : (ATTACH_PORT !== null ? 'attached-chrome' : 'standalone');

const stateKey = () => isExt() ? 'ext:' + BRIDGE_PORT : String(curPort());

async function ensureBridge() {
  if (BRIDGE) return BRIDGE;
  const b = new AvBridge(BRIDGE_PORT, { token: process.env.AV_BRIDGE_TOKEN || readBridgeToken(pairingRuntime) });
  try { await b.start(); }
  catch (e) { throw new Error(`扩展桥端口 ${BRIDGE_PORT} 起不来：${e.message}。可设 AV_BRIDGE_PORT 换端口`); }
  BRIDGE = b;
  return b;
}
async function extPing(ms = 1200) {
  try {
    const result = await (await ensureBridge()).job('ping', {}, ms);
    LAST_EXT_ERROR = null;
    return result;
  } catch (error) { LAST_EXT_ERROR = error; return null; }
}
async function enableExt() {
  await ensureBridge();
  EXT_MODE = true;
  dbg('ext bridge enabled on', BRIDGE_PORT);
  return BRIDGE;
}

class ExtTransport {
  constructor(tabId) { this.tabId = tabId; }
  dispose() { this.__contextId = null; }
  async send(method, params = {}) {
    const b = await ensureBridge();
    const r = await b.job('debugger.send', { tabId: this.tabId, method, params }, 30000);
    return r || {};
  }
}

let OUT = [];
const emit = value => {
  const output = typeof value === 'string' ? value : JSON.stringify(value);
  if (['act', 'search'].includes(cmd) && isLongTaskOpen(tabs().long_task)) {
    let result;
    try { result = typeof value === 'string' ? JSON.parse(value) : value; } catch {}
    if (result && typeof result === 'object') { recordLongTaskResult(tabs().long_task, result); saveTabs(); }
  }
  OUT.push(output);
};

const argv0 = process.argv.slice(2);
let cmd, flags = {}, positional = [];

({ cmd, flags, positional } = parse(argv0));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dbg = (...a) => { if (process.env.AV_DEBUG) console.error('[av]', ...a); };

async function httpJson(path, method = 'GET') {
  if (isExt()) {
    const b = await ensureBridge();
    if (path === '/json/list') return b.job('tabs.list', {});
    if (path.startsWith('/json/new')) {
      const q = path.includes('?') ? decodeURIComponent(path.split('?').slice(1).join('?')) : '';
      return b.job('tabs.create', { url: q || 'about:blank' });
    }
    if (path.startsWith('/json/close/')) return b.job('tabs.close', { tabId: path.slice('/json/close/'.length) });
    throw new Error('ext mode: unsupported browser op ' + path);
  }
  const r = await fetch(`http://127.0.0.1:${curPort()}${path}`, { method });
  return r.json();
}

async function browserUp() {
  if (isExt()) return !!(await extPing(1500));
  try { await httpJson('/json/version'); return true; } catch { return false; }
}

const HOST_STATE = process.env.AV_HOST_STATE ||
  join(applicationDataDir(), 'browser.json');

const { chromeRoots, discoverBrowsers } = createBrowserRuntime({ install, defaultUserDataDir, HOST_STATE, BRIDGE_PORT, extPing, getBridge: () => BRIDGE, dbg });

const taskState = new TaskState({ path: stateFile, key: stateKey });
const tabs = () => taskState.get();
const saveTabs = () => taskState.save();

async function resolveTabId(spec) {
  if (!spec) return null;
  const pages = await listPages();
  const s = String(spec);
  const exact = pages.find(page => page.id === s);
  if (exact && !s.startsWith('#')) return exact.id;
  if (/^#?\d+$/.test(s)) {
    const n = Number(s.replace('#', ''));
    const p = pages[n - 1];
    return p ? p.id : null;
  }
  const hit = pages.find(p => p.id === s) || pages.find(p => p.id.startsWith(s));
  return hit ? hit.id : null;
}

async function applyTabSelection() {
  if (isPageWatchActive(new PageWatchStore(resolve(stateFile())).read()) && (flags.current || flags.tab)) throw new Error('页面监听已固定原标签页；先停止监听再显式选择新任务');
  if (isLongTaskOpen(tabs().long_task) && (flags.current || flags.tab)) throw new Error('长任务已固定标签页；继续原任务，不重新选择当前页面');
  if (tabs().pending_user_action && (flags.current || flags.tab)) throw new Error('等待用户操作期间不能切换任务标签页');
  if (flags.current) {
    if (flags.tab) throw new Error('--current 与 --tab 不能同时使用');
    if (!isExt()) throw new Error('当前标签页模式需要扩展桥，不能猜测 CDP 列表中的活动页');
    await markBaseline();
    const page = await BRIDGE.job('tabs.current', {});
    if (!page || !page.id) throw new Error('未找到用户当前选择的浏览器标签页');
    const state = tabs();
    state.user_current = page.id;
    state.curr = page.id;
    state.owned = state.owned.filter(id => id !== page.id);
    if (!state.baseline.includes(page.id)) state.baseline.push(page.id);
    saveTabs();
    CURR = page.id;
    return true;
  }
  if (!flags.tab) return false;
  const id = await resolveTabId(flags.tab);
  if (!id) throw new Error('找不到标签页: ' + flags.tab + '（用 tab list 看序号）');
  await markBaseline().catch(() => {});
  const t = tabs();
  if (t.user_current && id !== t.user_current) throw new Error('当前标签页任务不能切到其他页面；先保留并结束当前任务');
  if (t.preserved.includes(id) && id !== t.user_current) throw new Error('该页面已保留给用户；需要用户明确指定当前标签页才能操作');
  if (isAttach() && t.baseline.includes(id) && id !== t.user_current)
    throw new Error('拒绝切换：这是用户的标签页；agentviews 只在自己开的 tab 里活动。用 tab new 开一个');
  if (!t.owned.includes(id) && id !== t.user_current) throw new Error('拒绝操作未获授权的用户标签页；需要用户明确指定当前标签页');
  if (id !== t.user_current) t.user_current = null;
  t.curr = id; saveTabs(); CURR = id;
  dbg('tab ->', id);
  return true;
}

async function createTab(url) {
  if (isLongTaskOpen(tabs().long_task)) throw new Error('长任务期间不能新开标签页');
  if (tabs().pending_user_action) throw new Error('等待用户完成敏感操作期间不允许新开任务标签页');
  if (tabs().user_current) throw new Error('当前标签页任务不允许新开标签页；结束任务并反馈用户后再开始独立任务');
  const check = validateNavigation(url || 'about:blank');
  if (!check.ok) return check;
  await markBaseline();
  const t = tabs();
  const q = url ? encodeURIComponent(url) : 'about:blank';
  const tab = await httpJson('/json/new?' + q, 'PUT');
  if (!tab || !tab.id) throw new Error('新建标签页失败');
  if (!t.owned.includes(tab.id)) t.owned.push(tab.id);
  t.curr = tab.id; saveTabs(); CURR = tab.id;
  return tab;
}

async function capabilityMap(cdp, full = false) {
  const m = await evalJs(cdp, MAP_SRC, false);
  m.product = 'agentviews';
  m.context = 'after-act';
  if (full) m.all_nodes = JSON.parse(await evalJs(cdp, 'JSON.stringify(__av.nodes)', false));
  else for (const cc of m.capabilities) { cc.total = cc.nodes.length; cc.nodes = cc.nodes.slice(0, 14); }
  return m;
}

async function bootDesktop(profileName) {
  const detected = install();
  const profile = profileName || process.env.AV_PROFILE_NAME || 'Default';
  const launched = await launchBrowser({ exe: detected.exe, userDataDir: detected.user_data_dir, profile });
  return { ...detected, ...launched, profile_dir: detected.user_data_dir, profile_name: profile, remote_debugging_port: false };
}

async function autoAttach() {
  if (ATTACH_PORT || isExt()) return;
  const rep = await discoverBrowsers();
  if (rep.recommend && rep.recommend.mode === 'ext') {
    await enableExt();
    dbg('auto attach -> ext bridge (desktop main Chrome)');
    return;
  }

  if (rep.chrome_root_processes === 0) {
    const boot = await bootDesktop(process.env.AV_PROFILE_NAME || 'Default');
    dbg('booted desktop chrome', boot.profile_name);
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      if (await extPing(1200)) { await enableExt(); dbg('auto attach -> ext after boot'); return; }
    }
    dbg('ext bridge not up after boot; fallback standalone (independent profile)');
    return;
  }
  if (rep.recommend) {
    ATTACH_PORT = rep.recommend.port;
    dbg('auto attach ->', ATTACH_PORT, rep.recommend.source);
    return;
  }
  dbg('auto attach: will spawn standalone');
}

function resolveAttach() {
  if (isExt()) return true;
  if (ATTACH_PORT) return true;
  let port = Number(process.env.AV_ATTACH_PORT || 0);
  if (!port && flags.attach) port = Number(flags.attach) || 0;
  if (!port && flags.attach) {
    try {
      const j = JSON.parse(readFileSync(HOST_STATE, 'utf8'));
      port = Number(j.port) || 0;
    } catch (e) {
      throw new Error(`读不到宿主浏览器状态文件 (${HOST_STATE})：${e.message}。用 --attach <port> 或 AV_ATTACH_PORT 指定端口`);
    }
  }
  if (!port) return false;
  if (port !== ATTACH_PORT) {
    ATTACH_PORT = port;
    dbg('attach port', port);
  }
  return true;
}

function stateFile() {
  return flags.state || process.env.AV_STATE || join(applicationDataDir(), 'agentviews-tabs.json');
}

function isAttach() { return ATTACH_PORT !== null || EXT_MODE; }

async function markBaseline() {
  const t = tabs();
  if (t.baseline_set) return;
  const live = await listPages();

  t.owned = t.owned.filter(id => live.some(p => p.id === id));
  t.baseline = live.map(p => p.id);
  t.baseline_set = true;
  if (!t.curr || !live.some(p => p.id === t.curr)) t.curr = null;
  saveTabs();
  dbg('baseline tabs', t.baseline.length, '(sealed)');
}

async function newOwnedTab() {
  await markBaseline();
  const t = tabs();
  const tab = await httpJson('/json/new?about:blank', 'PUT');
  if (!tab || !tab.id) throw new Error('新建标签页失败');
  t.owned.push(tab.id);
  t.curr = tab.id;
  saveTabs();
  dbg('owned tab +', tab.id);
  return tab;
}

function ownTab(id) {
  const t = tabs();
  if (id && !t.owned.includes(id) && !t.baseline.includes(id)) {
    t.owned.push(id);
    saveTabs();
  }
}

async function closeOwned(keepCurr = false) {
  const t = tabs();
  const live = new Set((await listPages()).map(p => p.id));
  const kill = t.owned.filter(id => live.has(id) && !t.baseline.includes(id) && id !== t.user_current
    && (!isLongTaskOpen(t.long_task) || id !== t.long_task.tab)
    && !t.preserved.includes(id) && (!t.pending_user_action || id !== t.pending_user_action.tab) && (!keepCurr || id !== t.curr));
  if (kill.length === live.size && kill.length) kill.pop();
  for (const id of kill) {

    await httpJson('/json/close/' + id).catch(() => {});
  }
  if (!kill.length) return 0;
  await sleep(200);
  const after = new Set((await listPages()).map(p => p.id));
  t.owned = t.owned.filter(id => after.has(id));
  saveTabs();
  return kill.filter(id => !after.has(id)).length;
}

async function ensureBrowser() {

  if (isExt()) {
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) ok = !!(await extPing(2500));
    if (!ok) {
      throw new Error(`自有扩展桥未就绪：请在 chrome://extensions 加载 agentviews/bridge-ext（开发者模式 → 加载已解压的扩展程序），或确认 AV_BRIDGE_PORT=${BRIDGE_PORT} 与扩展 popup 里一致`);
    }
    return 'ext';
  }

  if (resolveAttach()) {
    if (!(await browserUp())) {
      throw new Error(`attach 端口 ${ATTACH_PORT} 不通：目标浏览器可能已关闭。去掉 --attach 走独立浏览器模式，或确认端口`);
    }
    return 'attach';
  }
  if (await browserUp()) return 'standalone-existing';
  const exe = browserExe();
  const profile = process.env.AV_PROFILE || mkdtempSync(join(tmpdir(), 'agentviews-browser-'));
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--remote-allow-origins=*',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1264,900',

    '--mute-audio',
  ];

  const proxy = process.env.AV_PROXY || flags.proxy;
  if (proxy) {
    args.push('--proxy-server=' + proxy);
    args.push('--proxy-bypass-list=localhost;127.0.0.1;<-loopback>');
    dbg('proxy', proxy);
  }
  if (!flags.headful) args.push('--headless=new', '--disable-gpu');
  args.push('about:blank');
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (await browserUp()) return 'standalone-new';
  }
  throw new Error('浏览器启动超时');
}

let CURR = null;

async function syncBrowserSession() {
  if (!isExt()) return;
  const identity = await extPing(2500);
  if (!identity || !identity.session_id) {
    const failure = bridgeFailure(LAST_EXT_ERROR, { runtime: pairingRuntime, port: BRIDGE_PORT, diagnostics: BRIDGE?.diagnostics() });
    throw new Error('扩展连接失败：' + failure.reason + '；' + failure.error + '。先运行 doctor --json 只读排查；不需要打开网站或新标签页。');
  }
  const session = identity.extension + ':' + identity.session_id;
  const state = tabs();
  if (state.browser_session === session) return;
  if (isLongTaskOpen(state.long_task) || (state.user_current || state.pending_user_action) && !flags.current) {
    throw new Error('浏览器会话已经改变；停止原任务，不猜测当前页或新开替代页');
  }
  state.browser_session = session;
  state.baseline_set = false;
  state.baseline = [];
  state.owned = [];
  state.preserved = [];
  state.curr = null;
  state.user_current = null;
  state.pending_user_action = null;
  state.action_confirmation = null;
  saveTabs();
}

async function listPages() {
  await syncBrowserSession();
  const list = await httpJson('/json/list');
  return list.filter(t => t.type === 'page');
}

async function pageTarget() {
  const pages = await listPages();
  if (isLongTaskOpen(tabs().long_task)) {
    const task = tabs().long_task;
    const target = pages.find(page => page.id === task.tab);
    if (!target) { task.status = 'target_lost'; task.reason = 'selected_tab_closed'; saveTabs(); throw new Error('长任务标签页已关闭，进度保留，不新开替代页面'); }
    tabs().curr = task.tab; saveTabs(); return target;
  }
  if (isAttach()) {

    await markBaseline();
    const t = tabs();
    if (t.pending_user_action) {
      const pending = pages.find(page => page.id === t.pending_user_action.tab);
      if (!pending) throw new Error('等待用户操作的标签页已关闭；停止任务并反馈用户');
      return pending;
    }
    if (t.user_current) {
      const selected = pages.find(page => page.id === t.user_current);
      if (!selected) throw new Error('用户当前标签页已关闭；停止任务，不新开或切换其他标签页');
      return selected;
    }
    let mine = pages.find(p => p.id === t.curr && t.owned.includes(p.id) && !t.preserved.includes(p.id));
    if (!mine) mine = pages.find(p => t.owned.includes(p.id) && !t.preserved.includes(p.id));
    if (mine) { t.curr = mine.id; saveTabs(); return mine; }
    return newOwnedTab();
  }

  const tc = tabs().curr;
  if (tc) {
    const cur = pages.find(t => t.id === tc);
    if (cur) return cur;
  }
  if (CURR) {
    const cur = pages.find(t => t.id === CURR);
    if (cur) return cur;
  }

  const owned = pages.find(page => tabs().owned.includes(page.id) && !tabs().preserved.includes(page.id));
  return owned || newOwnedTab();
}

let GWS = null;
let ACTIVE_CDP = null;
async function connect() {
  const started = await ensureBrowser();
  if (started === 'standalone-new' && !process.env.AV_PROFILE) {
    const pages = await listPages();
    const state = tabs();
    state.baseline_set = true; state.baseline = [];
    state.owned = pages.filter(page => page.url === 'about:blank').map(page => page.id);
    saveTabs();
  }
  const page = await pageTarget();
  CURR = page.id;
  tabs().curr = page.id;
  saveTabs();
  let cdp;
  if (isExt()) cdp = new ExtTransport(CURR);
  else {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    GWS = socket;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', opened);
        socket.removeEventListener('error', failed);
      };
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('WebSocket 握手失败')); };
      const timer = setTimeout(() => { cleanup(); socket.close(); reject(new Error('WebSocket 握手超时')); }, 8000);
      socket.addEventListener('open', opened);
      socket.addEventListener('error', failed);
    });
    cdp = new CDP(socket);
  }
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  cdp.__tabId = page.id;
  return { cdp, page };
}

function practiceKind() {
  const task = tabs().long_task;
  return isLongTaskOpen(task) && ['active', 'verifying', 'recovering'].includes(task.status)
    && ['practice', 'coding'].includes(task.kind) ? task.kind : null;
}

function src() { return createBrowserSource({ currentTab: !!tabs().user_current, practiceKind: practiceKind() }); }

async function inject(cdp) {
  return evalJs(cdp, src());
}

async function ensureAv(cdp, { refresh = false } = {}) {
  if (!refresh) {
    try {
      const exists = await evalJs(cdp, 'typeof window.__av === "object" && window.__av.VERSION === "2.0" && window.__avPracticeKind === '
        + JSON.stringify(practiceKind()) + ' && window.__avCurrentTabOnly === ' + !!tabs().user_current, false);
      if (exists) return await evalJs(cdp, 'window.__av.stats', false);
    } catch {}
  }
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      last = await inject(cdp);
      const alive = await evalJs(cdp, 'typeof window.__av === "object" && !!window.__av.nodes', false);
      if (alive) return last;
    } catch {  }
    await sleep(400);
  }
  throw new Error('注入失败：页面在导航中或上下文不可用');
}

async function waitStable(cdp) {

  await sleep(900);
  let last = '', stableSince = Date.now();
  const t0 = Date.now();
  const PROBE = `(()=>{let a=document.querySelectorAll("a[href],button,input,select,textarea,[role=button]").length,c=0;
    for(const x of document.querySelectorAll("a[href]")){if((x.innerText||"").trim().length>=10)c++}
    return a+":"+c})()`;
  while (Date.now() - t0 < 12000) {
    let n;
    try { n = await evalJs(cdp, PROBE, false); }
    catch { n = last; }
    if (n !== last) { last = n; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= 500) break;
    await sleep(150);
  }
  dbg('stable at', last, '(interactive:content_links)');
}

async function goto(cdp, url) {
  const check = validateNavigation(url);
  if (!check.ok) throw new Error(check.instruction);
  const navigation = await cdp.send('Page.navigate', { url });
  if (navigation.errorText) throw new Error('导航失败: ' + navigation.errorText);
  cdp.__contextId = null;
  let loaded = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    await sleep(150);
    try { if (await evalJs(cdp, 'document.readyState', false) === 'complete') { loaded = true; break; } }
    catch {}
  }
  if (!loaded) throw new Error('页面导航超时，未确认文档加载完成');
  await waitStable(cdp);
}

function human(stats) {
  return `${stats.kept} nodes · ${stats.view_chars} chars · ${stats.compression_x}× (HTML ${stats.outerHTML_KB} KB)`;
}

const LOGIN_PROBE = `(${inspectLoginPage.toString()})(document,location.href)`;

function loginProbe(cdp) { return evalJs(cdp, LOGIN_PROBE, false); }

function rememberHandoff(result) {
  if (result.status === 'needs_user_action') {
    tabs().pending_user_action = { tab: CURR, ...result };
    tabs().action_confirmation = null;
    saveTabs();
  }
  return result;
}

async function loginHandoff(cdp) {
  const evidence = await loginProbe(cdp);
  if (!evidence.need_login) return null;
  return rememberHandoff({ ok: false, status: 'needs_user_action', reason: 'login_required', evidence,
    choices: ['login_and_continue', 'skip_task'],
    instruction: '已到登录页面，请问你要亲自登录后继续，还是跳过此任务？保留标签页，不代登、不处理验证码、不换站取答案。登录完成反馈后用 resume --user-done 验证；明确跳过后用 resume --skip 结束等待。' });
}

async function dispatchSearchEnter(cdp) {
  const permission = await evalJs(cdp, 'window.__avGuardKey ? window.__avGuardKey() : ({ok:false,status:"needs_agent_review",reason:"missing_search_target"})', false);
  if (!permission.ok) return rememberHandoff(permission);
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  try {
    try { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key }); }
    finally { await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }); }
    return { ok: true, key: 'Enter', dispatched: true };
  } catch (error) { return agentRecovery('key_dispatch_failed', { error: error.message }); }
}

async function watchLogin(cdp, { timeoutSec = 300, beatSec = 5, freeze = false }) {
  if (freeze) throw new Error('不再冻结用户页面；请使用普通登录等待');
  const started = Date.now();
  const first = await loginProbe(cdp);
  let probe = first;
  while (probe.need_login && Date.now() - started < timeoutSec * 1000) {
    await sleep(Math.min(beatSec * 1000, Math.max(0, timeoutSec * 1000 - (Date.now() - started))));
    probe = await loginProbe(cdp);
  }
  return { result: probe.need_login ? 'timeout_still_login' : 'login_done',
    waited_ms: Date.now() - started, was_need_login: first.need_login, now_need_login: probe.need_login,
    logged_in: probe.logged_in, url: probe.url, freeze_requested: false,
    advice: probe.need_login ? '仍需要用户亲自完成登录，可选择继续等待或跳过' : '登录墙已消失；用户完成反馈后继续核验任务' };
}

async function finish(mode) {
  const watchStore = new PageWatchStore(resolve(stateFile()));
  if (isPageWatchActive(watchStore.read())) {
    await createWatchCommands({ flags: {}, positional: ['stop'], emit: () => {}, stateFile, sleep }).watch();
  }
  const task = tabs();
  const taskTabIds = [...new Set([...task.owned, task.curr, task.user_current, task.pending_user_action?.tab].filter(Boolean))];
  const detachTask = async () => {
    if (!isExt()) return 0;
    const result = await BRIDGE.job('debugger.detachAll', { tabIds: taskTabIds }, 4000);
    if (ACTIVE_CDP && taskTabIds.includes(ACTIVE_CDP.__tabId)) { ACTIVE_CDP.dispose?.(); ACTIVE_CDP = null; }
    return result.detached || 0;
  };
  if (tabs().user_current || tabs().pending_user_action || isLongTaskOpen(tabs().long_task)) mode = 'keep';
  if (mode === 'keep') {
    const t = isAttach() ? tabs() : null;
    if (t) {
      t.preserved = [...new Set([...t.preserved, ...t.owned])];
      saveTabs();
      if (isExt() && t.owned.length) await BRIDGE.job('tabs.preserve', { tabIds: t.owned }, 4000);
    }

    const detached = await detachTask();
    emit(JSON.stringify({
      mode: 'keep', kept: true,
      browser: browserLabel(),
      owned_tabs: t ? t.owned.length : null,
      curr: t ? t.curr : CURR,
      debugger_detached: detached,
      note: t ? '只保留自己开的标签页；用户主窗口与其它标签页完全未动' : '独立窗口保留，可继续下令'
    }, null, 2));
    return;
  }
  if (isAttach()) {
    const detached = await detachTask();
    const closed = await closeOwned(false);
    const t = tabs(); t.curr = null; saveTabs();
    emit(JSON.stringify({ mode: 'done', browser: browserLabel(), closed_owned_tabs: closed, debugger_detached: detached, user_tabs_untouched: true }));
  } else {
    const closed = await closeOwned(false);
    emit(JSON.stringify({ mode: 'done', browser: 'standalone', closed_owned_tabs: closed, browser_close_requested: false }));
  }
}

let IN_DAEMON = false;
let DAEMON_SERVER = null;
let SHUTTING = false;

async function shutdown(code = 0) {
  if (SHUTTING) return;
  SHUTTING = true;
  dbg('shutdown daemon', code);
  try { GWS && GWS.close(); } catch {  }
  try { BRIDGE && BRIDGE.close(); } catch {  }
  try { DAEMON_SERVER && DAEMON_SERVER.close(); } catch {  }
  await sleep(150);
  process.exit(code);
}

async function main(cdpIn) {
  OUT = [];
  if (cmd === 'watch' && ['status', 'poll', 'stop', undefined].includes(positional[0])) {
    await createWatchCommands({ flags, positional, emit, stateFile, sleep }).watch(); return;
  }
  if (cmd === 'task' && ['status', 'cancel'].includes(positional[0] || 'status')) {
    EXT_MODE = !!(flags.ext || process.env.AV_EXT === '1');
    resolveAttach();
    await createTaskCommands({ flags, positional, emit, tabs, saveTabs }).task(); return;
  }
  if (cmd === 'doctor') {
    const timeoutMs = Math.max(1, Math.min(60, Number(flags.timeout) || 10)) * 1000;
    const identity = await extPing(timeoutMs);
    const diagnostics = BRIDGE?.diagnostics() || {};
    emit(JSON.stringify(identity && identity.session_id ? { ok: true, status: 'bridge_ready',
      version: identity.version, extension: identity.extension, bridge_port: BRIDGE_PORT, diagnostics,
      extension_path: join(pairingRuntime, 'bridge-ext'), website_requested: false, tabs_created: 0 }
      : bridgeFailure(LAST_EXT_ERROR, { runtime: pairingRuntime, port: BRIDGE_PORT, diagnostics }), null, 2));
    return;
  }
  if (cmd === 'init') {
    if (!['auto', 'manual', 'verify'].includes(positional[0] || 'auto')) throw new Error('用法：init auto | init manual | init verify');
    const installed = installAgentSkills({ agents: flags.agents, installDir: flags['install-dir'] });
    pairingRuntime = installed.runtime;
    BRIDGE_PORT = installed.bridge_port;
    const result = await initialize(positional[0] || 'auto', {
      installed, install: install(),
      ping: async (timeout = 2000) => {
        await enableExt();
        const until = Date.now() + timeout;
        do {
          const reply = await extPing(Math.min(1500, Math.max(100, until - Date.now())));
          if (reply) return reply;
        } while (Date.now() < until);
        return null;
      },
      createTab,
    });
    emit(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'boot') {
    const before = chromeRoots().length;
    const r = await bootDesktop(flags.profile || process.env.AV_PROFILE_NAME || 'Default');
    emit(JSON.stringify({
      booted: true,
      chrome_root_processes_before: before,
      ...r,
      browser_persistent: true,
      av_boot_process_exits: true,
      next: '浏览器常驻；后续 av_open / av_map / ... 由扩展桥起 9335 后走 chrome.debugger 直连，不必再启动浏览器',
    }, null, 2));
    return;
  }

  if (flags.ext || process.env.AV_EXT === '1' || (flags.current && !flags.attach)) await enableExt();
  else if (flags.auto || process.env.AV_AUTO === '1') await autoAttach();

  resolveAttach();

  if (flags['watch-id']) {
    const record = new PageWatchStore(resolve(stateFile())).read();
    const state = tabs();
    if (!record || record.id !== flags['watch-id'] || record.key !== state.port || record.session !== state.browser_session
      || record.tab !== state.curr || state.user_current !== record.tab && !state.owned.includes(record.tab)) {
      throw new Error('监听目标或浏览器会话已改变，不读取替代页面');
    }
    if (!(await listPages()).some(page => page.id === record.tab)) {
      emit(JSON.stringify({ ok: false, status: 'target_lost', watch_target_lost: true })); return;
    }
  }
  const activeWatch = new PageWatchStore(resolve(stateFile())).read();
  if (isPageWatchActive(activeWatch) && (cmd === 'open' || cmd === 'tab' && !['list', undefined].includes(positional[0]) || cmd === 'pages' && flags.prune)) {
    throw new Error('监听期间不能导航、切换、新开或关闭任务页面；先 watch stop');
  }
  if (cmd === 'task' && positional[0] === 'start' && !flags.current && !tabs().curr) throw new Error('先用 --ext --current map 选择用户明确指定的页面，再开始长任务');
  await applyTabSelection();
  if (cmd === 'watch') {
    await createWatchCommands({ flags, positional, emit, tabs, listPages, stateFile, isExt, sleep }).watch(); return;
  }
  if (cmd === 'task' && positional[0] === 'preflight') {
    const state = tabs();
    if (!state.curr || state.user_current !== state.curr && !state.owned.includes(state.curr)) throw new Error('预检需要先明确选择当前用户页或工具自有页，不自动新开页面');
    if (!(await listPages()).some(page => page.id === state.curr)) throw new Error('预检目标已消失，不新开替代页面');
  }
  if (isLongTaskOpen(tabs().long_task)) {
    expireLongTask(tabs().long_task); saveTabs();
    if (cmd === 'open' || cmd === 'tab' && !['list', undefined].includes(positional[0]) || cmd === 'pages' && flags.prune) {
      throw new Error('长任务期间不能导航、切换、新开或关闭页面；先显式取消任务');
    }
    if (['act', 'search', 'collect'].includes(cmd) && ['expired', 'target_lost', 'interrupted', ...(cmd === 'act' ? [] : ['awaiting_submission'])].includes(tabs().long_task.status)) {
      emit(JSON.stringify({ ok: false, status: tabs().long_task.status, task: longTaskSummary(tabs().long_task),
        instruction: '该长任务只允许读取和人工反馈验证；不会自动交卷、重复作答或消耗下一次机会。' }, null, 2)); return;
    }
  }
  if (!cmd || cmd === 'help' || flags.help) {
    emit(`AgentViews (avs) — 安全的浏览器语义操作层

初始化（选一条）
  init auto             安装项目/Agent技能，按浏览器能力加载并验证扩展
  init manual           安装项目/Agent技能，等待用户手动导入扩展
  init verify           用户反馈导入后验证扩展，新开后台页后才返回 ready
  --agents auto|all|codex,claude,cursor   选择技能安装目标
  --install-dir <目录>   自定义持久化运行目录

读取与低风险操作
  --ext map [--full] [--json]      读取页面能力地图
  --ext observe [--full]          版本化语义页面及变化摘要
  --ext read --name <名称>        按目标读取完整文本
  --ext view | find <名称> | collect | verify
  --ext act --name <名称> [--text <值> | --key Enter] [--map]
  --ext act <原参数> --confirm <request_id> --user-confirmed  用户明确同意后的单次执行
  --ext act --name <文件输入> --files <绝对路径JSON数组> [--drop]  文件/目录上传，先请求确认
  --ext resume --decline --request-id <request_id>           用户拒绝后取消请求，不执行
  --ext act --name <名称> --role <角色> [--option <值> | --checked true|false]
  --ext verify [--url <地址>] [--contains <文字>] [--name <名称>] [--role <角色>]
  --ext search <关键词>            只读搜索；未识别时由 Agent 刷新地图恢复
  --ext eval <表达式>              无副作用读取，拒绝写入/点击/提交
  --ext watch start --timeout 3600 --beat 1  启动独立于 Agent 回合的只读页面监听
  watch status | watch poll --after <cursor> --timeout 5  状态、变化与恢复游标
  --ext watch resume             同一目标/会话恢复采样，不重放动作
  watch stop                    停止采样，不关闭页面
  --ext resume --user-done         用户亲自操作后的证据复核，不重放
  --ext resume --skip              用户明确跳过登录阻塞任务，随后 keep
  --ext task start --kind workflow --authorized --goal <目标> --total <步骤数> --timeout 3600
  --ext task preflight            只读检查可见代码编辑器；不写入、不运行、不提交
  --ext task start --kind coding  代码输入上下文；读回不代表代码已执行或业务验证通过
  --ext task watch --timeout 5 --beat 1  只读监听，窗口结束不结束长任务
  --ext task checkpoint --step <步骤> --contains <实际身份文本> --name <目标> --role <角色>
  --ext task complete --contains <最终页面文本>  验证 workflow 声明断言，不执行提交
  --ext task ready --contains <最终页面文本>  核验进度后保留页面等待用户操作
  --ext task status | task cancel   查看进度或显式取消，不关闭页面
  --ext task interrupt --contains <结束页面文本>  保留未完成进度，不标为成功

标签页（默认后台运行，不抢浏览器焦点）
  --ext --current map             用户明确要求的当前标签页，不新开
  --ext tab new [url]             新建工具自己的后台标签页
  --ext tab list | tab use <id> | --tab <id>
  --ext tab close <id>            仅允许关闭明确的工具自有页
  --ext keep                     反馈结果，保留页面并解除调试附加
  --ext done                     按所有权清理临时页；用户当前页/等待人工步骤时保留

诊断与高级模式
  probe --json                   系统浏览器安装信息及扩展连接状态
  doctor --json --timeout 10      只读握手自检，不访问网站、不创建标签页
  boot [--profile <名称>]         拉起日常浏览器，不安装扩展
  --ext                          推荐扩展传输，复用日常浏览器登录态
  --auto                         自动发现可用传输；无扩展时不可假装复用登录态
  --attach <port>                显式连接已有 CDP 调试端口
  serve | stop                   显式常驻模式，stop 不关闭浏览器
  AV_CHROME / AV_USER_DATA_DIR / AV_BRIDGE_PORT / AV_STATE

付款、扣费、删除、敏感提交及不可逆动作默认等待明确用户授权。
needs_user_action 可选择单次授权、用户亲自操作或取消；授权绑定原操作和页面，5分钟过期。
needs_agent_review 要重读地图分析，不代表已获敏感操作授权。
`);
    return;
  }

  if (cmd === 'stop') {
    if (IN_DAEMON) { setTimeout(() => shutdown(0), 200); emit('stopping daemon (browser left intact)'); }
    else emit('no daemon running');
    return;
  }
  if (cmd === 'keep' || cmd === 'done' || cmd === 'close') {
    await finish(cmd === 'keep' ? 'keep' : 'done');
    return;
  }

  if (cmd === 'probe') {
    const r = await discoverBrowsers();
    if (flags.json) return emit(JSON.stringify(r, null, 2));
    const main = r.desktop_main;
    emit('# 浏览器盘点  chrome 根进程 ' + r.chrome_root_processes + ' 个');
    emit('# 动态探测: exe=' + r.install.exe + '  ← ' + r.install.exe_source);
    emit('#            user_data_dir=' + r.install.user_data_dir + '  (LOCALAPPDATA=' + r.install.localappdata + ')');
    for (const b of r.browsers) {
      emit('#  pid=' + b.pid + '  ' + b.kind + '  cdp=' + (b.cdp_port || 'none') +
           '  attachable=' + b.attachable + '  ' + (b.title || '').slice(0, 46));
      emit('#    profile=' + b.profile);
      emit('#    ' + b.why);
    }
    if (main && !main.attachable) {
      emit('# 桌面主浏览器 (pid ' + main.pid + ') 不可连接：' + main.why);
    }
    const eb = r.ext_bridge;
    emit('# 自有扩展桥: 127.0.0.1:' + eb.port + ' installed=' + eb.installed +
         (eb.installed ? ' ext=' + eb.extension + ' v' + eb.version + ' attached=' + eb.attached.length : ' → 在 chrome://extensions 加载 agentviews/bridge-ext'));
    emit('#   ' + eb.role);
    emit('# 结构: ' + r.note);
    emit('# 可复用: ' + (r.recommend
      ? (r.recommend.mode === 'ext' ? '自有扩展桥 (--ext, 直连桌面主浏览器, ' + r.recommend.pages + ' tabs)' : 'port ' + r.recommend.port + ' (' + r.recommend.source + ', ' + r.recommend.browser + ', ' + r.recommend.pages + ' tabs)')
      : '无 → --auto 会新建独立窗口'));
    for (const a of r.advice) emit('# 建议: ' + a);
    return;
  }

  if (cmd === 'tab') {
    const sub = positional[0] || 'list';
    await markBaseline().catch(() => {});
    const t = tabs();
    if (sub === 'new') {
      const tab = await createTab(positional[1]);
      if (!tab.ok && tab.status === 'needs_user_action') { emit(JSON.stringify(tab, null, 2)); return; }
      const pages = await listPages();
      emit(JSON.stringify({ action: 'new', id: tab.id, index: pages.findIndex(p => p.id === tab.id) + 1,
        url: tab.url || 'about:blank', curr: tab.id, owned: t.owned.length }, null, 2));
      return;
    }
    if (sub === 'use') {
      if (t.pending_user_action) throw new Error('等待用户完成操作期间不能切换任务标签页');
      const spec = positional[1];
      if (!spec) throw new Error('tab use 需要 id 或 #序号（tab list 可查）');
      const id = await resolveTabId(spec);
      if (!id) throw new Error('找不到标签页: ' + spec);
      if (t.user_current && id !== t.user_current) throw new Error('当前标签页任务不能切到其他页面');
      if (t.preserved.includes(id) && id !== t.user_current) throw new Error('该页面已保留给用户；需要用户明确指定当前标签页才能操作');
      if (isAttach() && t.baseline.includes(id) && id !== t.user_current)
        throw new Error('拒绝切换：这是用户的标签页；agentviews 只在自己开的 tab 里活动。用 tab new 开一个');
      if (!t.owned.includes(id) && id !== t.user_current) throw new Error('拒绝操作未获授权的用户标签页；需要用户明确指定当前标签页');
      if (id !== t.user_current) t.user_current = null;
      t.curr = id; saveTabs(); CURR = id;
      const p = (await listPages()).find(x => x.id === id);
      emit(JSON.stringify({ action: 'use', id, url: p ? p.url : null, owned: t.owned.length }, null, 2));
      return;
    }
    if (sub === 'close') {
      const id = await resolveTabId(positional[1] || t.curr);
      if (!id) throw new Error('找不到要关的标签页');
      if (t.preserved.includes(id)) throw new Error('拒绝关闭：该标签页已经保留给用户');
      if (t.user_current === id || (t.pending_user_action && t.pending_user_action.tab === id)) throw new Error('拒绝关闭：当前用户任务或等待人工操作的标签页必须保留');
      if (t.baseline.includes(id)) throw new Error('拒绝关闭：这是用户的标签页（baseline 永久保护）');
      if (isAttach() && !t.owned.includes(id)) throw new Error('拒绝关闭：不是 agentviews 开的标签页');
      await httpJson('/json/close/' + id).catch(() => {});
      await sleep(200);
      const gone = !(await listPages()).some(p => p.id === id);
      if (gone) {
        t.owned = t.owned.filter(x => x !== id);
        if (t.curr === id) t.curr = null;
        saveTabs();
      }
      emit(JSON.stringify({ action: 'close', id, closed: gone, user_tabs_untouched: true }, null, 2));
      return;
    }
    const pages = await listPages();
    emit(JSON.stringify({
      browser: browserLabel(), curr: t.curr, owned: t.owned.length, baseline: t.baseline.length,
      tabs: pages.map((p, i) => ({ index: i + 1, id: p.id, url: (p.url || '').slice(0, 100),
        title: (p.title || '').slice(0, 50), curr: p.id === t.curr,
        mine: t.owned.includes(p.id) && !t.preserved.includes(p.id), user: t.baseline.includes(p.id) || t.preserved.includes(p.id) }))
    }, null, 2));
    return;
  }

  if (cmd === 'pages') {
    const list = await listPages();
    if (isAttach()) await markBaseline();
    const t = isAttach() ? tabs() : null;
    if (flags.prune) {
      let closed;
      if (isAttach()) {

        closed = await closeOwned(true);
      } else {
        const keep = CURR || (await pageTarget()).id;
        closed = 0;
        for (const x of list) {
          if (x.id === keep) continue;
          try { await httpJson('/json/close/' + x.id); closed++; } catch {  }
        }
        CURR = keep;
      }
      emit(JSON.stringify({ before: list.length, closed, mode: isAttach() ? 'attach-owned-only' : 'standalone', kept_curr: isAttach() ? t.curr : CURR }, null, 2));
      return;
    }
    const cur = isAttach() ? t.curr : CURR;
    emit(JSON.stringify({
      browser: browserLabel(),
      curr: cur,
      baseline: isAttach() ? t.baseline.length : null,
      owned: isAttach() ? t.owned.length : null,
      tabs: list.map(x => ({ id: x.id, url: (x.url || '').slice(0, 100), active: x.id === cur, mine: isAttach() ? t.owned.includes(x.id) : null, user: isAttach() ? t.baseline.includes(x.id) : null }))
    }, null, 2));
    return;
  }

  if (cmd === 'open') {
    if (tabs().pending_user_action) { emit(JSON.stringify(tabs().pending_user_action, null, 2)); return; }
    const permission = validateNavigation(positional[0] || '');
    if (!permission.ok) { emit(JSON.stringify(permission, null, 2)); return; }
  }
  if (cdpIn && (cdpIn.closed || cdpIn.__tabId !== tabs().curr)) { cdpIn.dispose?.(); GWS?.close(); cdpIn = null; }
  const cdp = cdpIn || (await connect()).cdp;
  if (IN_DAEMON) ACTIVE_CDP = cdp;

  if (cmd === 'open') {

    const url = positional[0];
    if (!url) throw new Error('需要 URL');
    await goto(cdp, url);
    const stats = await ensureAv(cdp);
    if (flags.json) return emit(JSON.stringify(stats, null, 2));
    const title = await evalJs(cdp, 'document.title', false);
    emit(`# ${title}\n# ${url}\n# ${human(stats)}\n`);
    emit(await evalJs(cdp, 'window.__av.view', false));
    return;
  }

  await ensureAv(cdp, { refresh: ['map', 'view', 'find', 'observe', 'verify'].includes(cmd) });
  if (tabs().pending_user_action && !(cmd === 'act' && (flags.confirm || flags['user-confirmed'])) && !['task', 'resume', 'view', 'map', 'find', 'verify', 'eval', 'shot', 'login-check', 'login-wait', 'login-watch', 'read', 'observe', 'audit'].includes(cmd)) {
    emit(JSON.stringify(tabs().pending_user_action, null, 2)); return;
  }

  if (cmd === 'shot') {

    const out = positional[0] || 'shot.png';
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(out, Buffer.from(r.data, 'base64'));
    emit(out);
    return;
  }

  const context = { cdp, flags, positional, emit, evalJs, MAP_SRC, COLLECT_SRC, ensureAv, tabs, saveTabs, CURR, listPages, agentRecovery, rememberHandoff, loginHandoff, loginProbe, dispatchSearchEnter, goto, sleep, dbg, human, waitStable, capabilityMap, writeFileSync, isAttach, browserLabel, watchLogin };
  const handlers = { ...createReadCommands(context), ...createActionCommands(context), ...createLoginCommands(context), ...createTaskCommands(context) };
  if (handlers[cmd]) { await handlers[cmd](); return; }
  throw new Error('未知命令: ' + cmd);
}

async function runCommand(cdp) {
  if (!cmd || ['init', 'boot', 'help', 'probe', 'doctor', 'stop'].includes(cmd)) return main(cdp);
  if (cmd === 'watch' && ['status', 'poll', 'stop', undefined].includes(positional[0])) return main(cdp);
  const release = await acquireSessionLock(stateFile());
  const watchedRead = cmd === 'observe' && !!flags['watch-id'];
  const interruptRead = () => { GWS?.close(); BRIDGE?.close(); };
  if (watchedRead) { process.on('SIGTERM', interruptRead); process.on('SIGINT', interruptRead); }
  try { taskState.reload(); return await main(cdp); }
  catch (error) {
    if (ACTIVE_CDP && (ACTIVE_CDP.closed || /context|connection|socket|detached|target closed/i.test(error.message))) {
      ACTIVE_CDP.dispose?.(); GWS?.close(); ACTIVE_CDP = null;
    }
    if (isLongTaskOpen(tabs().long_task)) { recordLongTaskResult(tabs().long_task, { ok: false, reason: 'command_error' }); saveTabs(); }
    throw error;
  }
  finally {
    if (watchedRead) { process.removeListener('SIGTERM', interruptRead); process.removeListener('SIGINT', interruptRead); }
    release();
  }
}

async function serve() {
  IN_DAEMON = true;
  if (flags.ext || process.env.AV_EXT === '1') await enableExt();
  else if (flags.auto || process.env.AV_AUTO === '1') await autoAttach();
  resolveAttach();
  const mode = isExt() ? 'ext' : isAttach() ? 'attach' : 'standalone';
  const identity = { mode, endpoint: isExt() ? BRIDGE_PORT : curPort(), state: resolve(stateFile()) };
  const authentication = new DaemonAuthenticator(daemonToken());
  const queue = new CommandQueue({ idleMs: process.env.AV_IDLE_MS === '0' ? 0 : Number(process.env.AV_IDLE_MS) || 120000,
    onIdle: () => shutdown(0) });
  const server = createServer((request, response) => {
    const respond = (status, value) => authentication.respond(request, response, status, value);
    if (request.headers.origin || !/^127\.0\.0\.1(?::\d+)?$/.test(request.headers.host || '')) {
      respond(403, { ok: false, error: 'forbidden' }); return;
    }
    if (request.method === 'GET' && request.url === '/status') {
      if (!authentication.authorize(request)) { respond(403, { ok: false, error: 'daemon authentication failed' }); return; }
      respond(200, { product: 'agentviews', identity, state_routing: true }); return;
    }
    if (request.method !== 'POST' || request.url !== '/cmd') { respond(404, { ok: false }); return; }
    if (queue.pending >= 64) { respond(429, { ok: false, error: 'daemon queue is full' }); return; }
    queue.run(async () => {
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 1 << 20) throw new Error('daemon request too large');
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        if (!authentication.authorize(request, body)) { respond(403, { ok: false, error: 'daemon authentication failed' }); return; }
        const payload = JSON.parse(body);
        if (!payload || payload.identity?.mode !== identity.mode || payload.identity?.endpoint !== identity.endpoint
          || typeof payload.identity?.state !== 'string' || !Array.isArray(payload.argv) || payload.argv.length > 128
          || !payload.argv.every(argument => typeof argument === 'string')) throw new Error('invalid daemon request or transport mismatch');
        ({ cmd, flags, positional } = parse(payload.argv));
        flags.state = payload.identity.state;
        taskState.reload();
        if (ACTIVE_CDP && (ACTIVE_CDP.closed || ACTIVE_CDP.__tabId !== tabs().curr)) { ACTIVE_CDP.dispose?.(); GWS?.close(); ACTIVE_CDP = null; }
        await runCommand(ACTIVE_CDP);
        respond(200, { ok: true, out: [...OUT] });
      } catch (error) { respond(200, { ok: false, error: error.message }); }
    }).catch(error => respond(503, { ok: false, error: error.message }));
  });
  server.requestTimeout = 20000;
  server.once('close', () => queue.close());
  DAEMON_SERVER = server;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(DAEMON, '127.0.0.1', resolve); });
  console.error('[av] daemon on 127.0.0.1:' + DAEMON);
  await new Promise(() => {});
}

function daemonToken() {
  if (process.env.AV_DAEMON_TOKEN) return process.env.AV_DAEMON_TOKEN;
  if (process.env.AV_BRIDGE_TOKEN) return process.env.AV_BRIDGE_TOKEN;
  return readBridgeToken(pairingRuntime);
}

async function daemonCall(argv) {
  const transport = flags.ext || process.env.AV_EXT === '1' ? 'ext' : flags.attach || process.env.AV_ATTACH_PORT ? 'attach' : 'standalone';
  const identity = { mode: transport, endpoint: transport === 'ext' ? BRIDGE_PORT : Number(flags.attach || process.env.AV_ATTACH_PORT || PORT), state: resolve(stateFile()) };
  let status;
  let token;
  try {
    token = daemonToken();
    status = await daemonRequest(token, 'http://127.0.0.1:' + DAEMON + '/status');
  } catch { return null; }
  if (status.product !== 'agentviews' || status.identity?.mode !== identity.mode || status.identity?.endpoint !== identity.endpoint
    || !status.state_routing && status.identity?.state !== identity.state) return null;
  try {
    return await daemonRequest(token, 'http://127.0.0.1:' + DAEMON + '/cmd', { method: 'POST',
      body: JSON.stringify({ argv, identity }), timeoutMs: 1900000 });
  } catch { return { ok: false, error: 'daemon 请求结果未知；停止操作，不在另一个进程重放' }; }
}

if (cmd === 'serve') {
  serve().catch(e => { console.error('ERR', e.message); try { BRIDGE && BRIDGE.close(); } catch {} process.exit(1); });
} else {
  (async () => {

    let forwarded = false;
    try {
      if (['boot', 'init', 'help', 'doctor'].includes(cmd) || cmd === 'watch' && ['status', 'poll', 'stop', undefined].includes(positional[0])) throw new Error('local only');
      const r = await daemonCall(argv0);
      if (r) {
        forwarded = true;
        if (r.ok) { if (r.out.length) console.log(r.out.join('\n')); }
        else { console.error('ERR', r.error); process.exitCode = 1; }
      }
    } catch {  }
    if (forwarded) { await sleep(50); process.exit(process.exitCode || 0); }
    await runCommand();
    if (OUT.length) console.log(OUT.join('\n'));
    try { GWS && GWS.close(); } catch {  }
    try { BRIDGE && BRIDGE.close(); } catch {  }
    await sleep(80);
    process.exit(0);
  })().catch(async e => {
    console.error('ERR', e.message);

    try { GWS && GWS.close(); } catch {  }
    try { BRIDGE && BRIDGE.close(); } catch {  }
    await sleep(120);
    process.exit(1);
  });
}
