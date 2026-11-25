import './config.js';
import { authenticatedFetch } from './auth.js';

const DEFAULT_PORT = 9335;
const SS_KEY = 'avAttached';
const OWNED_KEY = 'avOwnedTabs';
const SESSION_KEY = 'avBrowserSession';
const UNCERTAIN_KEY = 'avUncertainTabs';
const CONFIG = globalThis.__AV_BRIDGE_CONFIG || {};
const TOKEN = CONFIG.token;
let PORT = Number(CONFIG.port) || DEFAULT_PORT;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let stateTail = Promise.resolve();
const pendingAttaches = new Map();
const pendingDetaches = new Map();

function withSessionState(operation) {
  const pending = stateTail.then(operation);
  stateTail = pending.catch(() => {});
  return pending;
}

async function sessionAttached() {
  const state = await chrome.storage.session.get({ [SS_KEY]: [] });
  return new Set(Array.isArray(state[SS_KEY]) ? state[SS_KEY] : []);
}

async function sessionSet(set) {
  await chrome.storage.session.set({ [SS_KEY]: [...set] });
}

async function ownedTabs() {
  const state = await chrome.storage.session.get({ [OWNED_KEY]: [] });
  return new Set(Array.isArray(state[OWNED_KEY]) ? state[OWNED_KEY] : []);
}

async function uncertainTabs() {
  const state = await chrome.storage.session.get({ [UNCERTAIN_KEY]: [] });
  return new Set(Array.isArray(state[UNCERTAIN_KEY]) ? state[UNCERTAIN_KEY] : []);
}

async function browserSession() {
  const state = await chrome.storage.session.get({ [SESSION_KEY]: null });
  if (typeof state[SESSION_KEY] === 'string' && /^[0-9a-f-]{36}$/i.test(state[SESSION_KEY])) return state[SESSION_KEY];
  const identity = crypto.randomUUID();
  await chrome.storage.session.set({ [SESSION_KEY]: identity });
  return identity;
}

chrome.storage.local.get({ bridgePort: PORT }, state => {
  PORT = Number(state.bridgePort) || DEFAULT_PORT;
  loop();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.bridgePort) PORT = Number(changes.bridgePort.newValue) || DEFAULT_PORT;
});

chrome.alarms.create('av-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'av-keepalive') loop(); });

let running = false;
async function loop() {
  if (running || typeof TOKEN !== 'string' || !/^[a-f0-9]{64}$/i.test(TOKEN)) return;
  running = true;
  try {
    const session = await withSessionState(browserSession);
    while (true) {
      const port = PORT;
      try {
        const job = await authenticatedFetch('/pull', { token: TOKEN, port, session, timeoutMs: 25000 });
        if (!job || !job.id) { await sleep(30); continue; }
        if (typeof job.id !== 'string' || typeof job.op !== 'string'
          || !isRecord(job.args) || !Number.isFinite(job.expires_at)) {
          await sleep(100); continue;
        }
        const out = { id: job.id, ok: true, result: null };
        try {
          if (Date.now() >= job.expires_at) throw new Error('job expired before dispatch; no operation executed');
          out.result = await run(job.op, job.args, job.expires_at);
        } catch (error) {
          out.ok = false;
          out.error = error instanceof Error ? error.message : String(error);
        }
        await authenticatedFetch('/push', { token: TOKEN, port, session, method: 'POST', body: JSON.stringify(out), timeoutMs: 5000 });
      } catch {
        await sleep(250);
      }
    }
  } finally {
    running = false;
  }
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function tabNumber(value) {
  const tabId = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(tabId) || tabId <= 0) throw new Error('invalid tabId');
  return tabId;
}

function tabJson(tab) {
  if (!tab || !Number.isSafeInteger(tab.id)) throw new Error('invalid Chrome tab response');
  return {
    id: String(tab.id), type: 'page', url: tab.url || '', title: tab.title || '',
    windowId: tab.windowId, active: !!tab.active,
    webSocketDebuggerUrl: 'av-ext://' + tab.id,
  };
}

async function debuggerCall(tabId, operation, label, timeoutMs = 20000) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(label + ' timed out; dispatched outcome is unknown; cleanup is required');
          error.code = 'AV_OPERATION_TIMEOUT';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error && error.code === 'AV_OPERATION_TIMEOUT') {
      try {
        const uncertain = await uncertainTabs();
        uncertain.add(String(tabId));
        await chrome.storage.session.set({ [UNCERTAIN_KEY]: [...uncertain] });
      } catch (storageError) { error.message += '; uncertain state could not be saved: ' + String(storageError && storageError.message || storageError); }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function requireFreshJob(expiresAt) {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) throw new Error('job expired before command dispatch; no requested action executed');
  return remaining;
}

async function clearDebuggerState(key) {
  const attached = await sessionAttached();
  attached.delete(key);
  await sessionSet(attached);
  const uncertain = await uncertainTabs();
  uncertain.delete(key);
  await chrome.storage.session.set({ [UNCERTAIN_KEY]: [...uncertain] });
}

async function detachTab(tabId, key, label, timeoutMs = 3000) {
  const pending = { settled: false, timedOut: false };
  const operation = Promise.resolve(chrome.debugger.detach({ tabId })).then(result => {
    pending.settled = true;
    return result;
  }, error => { pending.settled = true; throw error; });
  pendingDetaches.set(key, pending);
  try { return await debuggerCall(tabId, operation, label, timeoutMs); }
  catch (error) { pending.timedOut = !!error && error.code === 'AV_OPERATION_TIMEOUT'; throw error; }
  finally {
    if (pending.timedOut) {
      operation.then(() => withSessionState(async () => {
        if (pendingDetaches.get(key) !== pending) return;
        pendingDetaches.delete(key);
        if (!pendingAttaches.has(key)) await clearDebuggerState(key);
      }), () => {
        if (pendingDetaches.get(key) === pending) pendingDetaches.delete(key);
      }).catch(() => {});
    } else if (pendingDetaches.get(key) === pending) pendingDetaches.delete(key);
  }
}

async function compensateLateAttachment(tabId, key, pending) {
  try {
    const attached = await sessionAttached();
    attached.add(key);
    await sessionSet(attached);
    try { await detachTab(tabId, key, 'late debugger attach cleanup'); }
    catch (error) {
      if (!/No tab|not attached|Detached|target closed/i.test(String(error && error.message || error))) throw error;
    }
    await clearDebuggerState(key);
  } finally {
    if (pendingAttaches.get(key) === pending) pendingAttaches.delete(key);
  }
}

async function attachTab(tabId, key, expiresAt) {
  const set = await sessionAttached();
  if (set.has(key)) return;
  const timeoutMs = Math.min(20000, requireFreshJob(expiresAt));
  const pending = { settled: false, timedOut: false };
  const operation = Promise.resolve(chrome.debugger.attach({ tabId }, '1.3')).then(result => {
    pending.settled = true;
    return result;
  }, error => { pending.settled = true; throw error; });
  pendingAttaches.set(key, pending);
  try { await debuggerCall(tabId, operation, 'debugger attach', timeoutMs); }
  catch (error) {
    pending.timedOut = !!error && error.code === 'AV_OPERATION_TIMEOUT';
    if (!/already attached/i.test(String(error && error.message || error))) throw error;
  } finally {
    if (pending.timedOut) {
      operation.then(() => withSessionState(() => compensateLateAttachment(tabId, key, pending)), () => {
        if (pendingAttaches.get(key) === pending) pendingAttaches.delete(key);
      }).catch(() => {});
    } else if (pendingAttaches.get(key) === pending) pendingAttaches.delete(key);
  }
  set.add(key);
  await sessionSet(set);
}

const SAFE_RETRY = new Set(['Runtime.enable', 'Page.enable', 'Page.captureScreenshot', 'DOM.getDocument', 'DOM.getOuterHTML', 'DOM.getBoxModel', 'DOM.getNodeForLocation', 'DOM.getAttributes', 'DOM.getContentQuads']);

async function run(op, args = {}, expiresAt = Infinity) {
  if (!isRecord(args)) throw new Error('invalid operation arguments');
  return withSessionState(() => {
    if (Date.now() >= expiresAt) throw new Error('job expired before dispatch; no operation executed');
    return runOperation(op, args, expiresAt);
  });
}

async function runOperation(op, args, expiresAt) {
  requireFreshJob(expiresAt);
  if (op === 'ping') {
    return {
      extension: chrome.runtime.id, version: chrome.runtime.getManifest().version,
      session_id: await browserSession(), chrome: navigator.userAgent, bridge_port: PORT,
      attached: [...(await sessionAttached())], uncertain_tabs: [...new Set([...(await uncertainTabs()), ...pendingAttaches.keys(), ...pendingDetaches.keys()])],
    };
  }
  if (!['debugger.detachAll', 'tabs.preserve'].includes(op) && ((await uncertainTabs()).size || pendingAttaches.size || pendingDetaches.size)) {
    throw new Error('Previous debugger operation has unknown outcome; run debugger.detachAll before further operations');
  }
  if (op === 'tabs.list') return (await chrome.tabs.query({})).map(tabJson);
  if (op === 'tabs.current') {
    const selected = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!selected.length) throw new Error('没有当前选择的浏览器标签页');
    const owned = await ownedTabs();
    owned.delete(String(selected[0].id));
    await chrome.storage.session.set({ [OWNED_KEY]: [...owned] });
    return tabJson(selected[0]);
  }
  if (op === 'tabs.create') {
    if (args.url !== undefined && typeof args.url !== 'string') throw new Error('invalid tab URL');
    requireFreshJob(expiresAt);
    const tab = await chrome.tabs.create({ url: args.url || 'about:blank', active: false });
    await chrome.tabs.update(tab.id, { muted: true });
    const owned = await ownedTabs();
    owned.add(String(tab.id));
    await chrome.storage.session.set({ [OWNED_KEY]: [...owned] });
    return tabJson(tab);
  }
  if (op === 'tabs.close') {
    const tabId = tabNumber(args.tabId);
    const owned = await ownedTabs();
    if (!owned.has(String(tabId))) throw new Error('拒绝关闭用户标签页：扩展未记录该标签页的工具所有权');
    requireFreshJob(expiresAt);
    await chrome.tabs.remove(tabId);
    owned.delete(String(tabId));
    await chrome.storage.session.set({ [OWNED_KEY]: [...owned] });
    const set = await sessionAttached();
    set.delete(String(tabId));
    await sessionSet(set);
    return { closed: true };
  }
  if (op === 'tabs.preserve') {
    if (!Array.isArray(args.tabIds) || args.tabIds.length > 1024) throw new Error('invalid tabIds');
    const keys = args.tabIds.map(value => String(tabNumber(value)));
    const owned = await ownedTabs();
    for (const key of keys) owned.delete(key);
    await chrome.storage.session.set({ [OWNED_KEY]: [...owned] });
    return { preserved: true };
  }
  if (op === 'tabs.update') {
    if (typeof args.url !== 'string') throw new Error('invalid tab URL');
    requireFreshJob(expiresAt);
    return tabJson(await chrome.tabs.update(tabNumber(args.tabId), { url: args.url }));
  }
  if (op === 'debugger.send') {
    const tabId = tabNumber(args.tabId);
    const key = String(tabId);
    if (typeof args.method !== 'string' || !/^[A-Za-z]+\.[A-Za-z][A-Za-z0-9]*$/.test(args.method)
      || (args.params !== undefined && !isRecord(args.params))) throw new Error('invalid debugger command');
    await attachTab(tabId, key, expiresAt);
    const params = { ...(args.params || {}) };
    if (args.method === 'Runtime.evaluate') {
      params.timeout = Number.isFinite(params.timeout) && params.timeout > 0 ? Math.min(params.timeout, 19000) : 19000;
    }
    const send = () => {
      const timeoutMs = Math.min(20000, requireFreshJob(expiresAt));
      return debuggerCall(tabId, chrome.debugger.sendCommand({ tabId }, args.method, params), args.method, timeoutMs);
    };
    try { return await send(); }
    catch (error) {
      if (!/No tab|not attached|Detached|target closed/i.test(String(error && error.message || error)) || !SAFE_RETRY.has(args.method)) throw error;
      const set = await sessionAttached();
      set.delete(key);
      await sessionSet(set);
      await attachTab(tabId, key, expiresAt);
      return send();
    }
  }
  if (op === 'debugger.detachAll') {
    const attached = await sessionAttached();
    const uncertain = await uncertainTabs();
    if (args.tabIds !== undefined && (!Array.isArray(args.tabIds) || args.tabIds.length > 1024)) throw new Error('invalid cleanup tabIds');
    const requested = args.tabIds === undefined ? null : new Set(args.tabIds.map(value => String(tabNumber(value))));
    const keys = new Set([...attached, ...uncertain, ...pendingAttaches.keys(), ...pendingDetaches.keys()].filter(key => !requested || requested.has(key)));
    let detached = 0;
    const failures = [];
    for (const key of keys) {
      if (pendingAttaches.get(key) && !pendingAttaches.get(key).settled) { failures.push(key); continue; }
      if (pendingDetaches.get(key) && !pendingDetaches.get(key).settled) { failures.push(key); continue; }
      try {
        const timeoutMs = Math.min(3000, requireFreshJob(expiresAt));
        await detachTab(Number(key), key, 'debugger detach', timeoutMs);
        detached++;
      } catch (error) {
        if (!/No tab|not attached|Detached|target closed/i.test(String(error && error.message || error))) {
          failures.push(key);
          continue;
        }
      }
      attached.delete(key);
      uncertain.delete(key);
    }
    await sessionSet(attached);
    const latest = await uncertainTabs();
    for (const key of keys) if (!failures.includes(key)) latest.delete(key);
    await chrome.storage.session.set({ [UNCERTAIN_KEY]: [...latest] });
    if (failures.length) throw new Error('debugger cleanup incomplete for tabs: ' + failures.join(','));
    return { detached };
  }
  throw new Error('unknown op: ' + op);
}

chrome.debugger.onDetach.addListener(source => {
  withSessionState(async () => {
    if (!source || source.tabId == null) return;
    const set = await sessionAttached();
    set.delete(String(source.tabId));
    await sessionSet(set);
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(tabId => {
  withSessionState(async () => {
    const key = String(tabId);
    const owned = await ownedTabs();
    owned.delete(key);
    await chrome.storage.session.set({ [OWNED_KEY]: [...owned] });
    const attached = await sessionAttached();
    attached.delete(key);
    await sessionSet(attached);
    const uncertain = await uncertainTabs();
    uncertain.delete(key);
    await chrome.storage.session.set({ [UNCERTAIN_KEY]: [...uncertain] });
  }).catch(() => {});
});
