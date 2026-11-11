// AgentViews CDP Bridge — MV3 service worker (v10)
// chrome.debugger API 是 CDP 的 alternate transport。扩展挂在用户日常桌面 Chrome，
// 被驱动的 tab 就在主浏览器窗口里 → cookies / 登录态 / 窗口天然复用，
// 不需要 --remote-debugging-port、不需要重启浏览器、不需要搬运 cookie。
// 与 CLI 的临时桥（127.0.0.1:AV_BRIDGE_PORT，默认 9335）用 HTTP 长轮询通信。

const DEFAULT_PORT = 9335;
const SS_KEY = 'avAttached';
let PORT = DEFAULT_PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 附加状态放 session storage：MV3 SW 会被回收，模块级 Set 会丢，
// 但 Chrome 侧的 debugger attachment 还在 → 重启后重试 attach 会报 already attached。
async function sessionAttached() {
  const s = await chrome.storage.session.get({ [SS_KEY]: [] });
  return new Set(s[SS_KEY] || []);
}
async function sessionSet(set) {
  await chrome.storage.session.set({ [SS_KEY]: [...set] });
}

chrome.storage.local.get({ bridgePort: DEFAULT_PORT }, s => {
  PORT = Number(s.bridgePort) || DEFAULT_PORT;
  chrome.storage.local.onChanged.addListener(ch => {
    if (ch.bridgePort) PORT = Number(ch.bridgePort.newValue) || DEFAULT_PORT;
  });
  loop();
});

// 常驻的 pending /pull fetch 会保持 SW 活跃；alarm 是被回收后的兜底唤醒。
try {
  chrome.alarms.create('av-keepalive', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener(a => { if (a.name === 'av-keepalive') loop(); });
} catch { /* alarms 不可用时只靠长轮询 */ }

let running = false;
async function loop() {
  if (running) return;
  running = true;
  while (true) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/pull', { signal: AbortSignal.timeout(25000) });
      if (!r.ok) { await sleep(200); continue; }
      const job = await r.json();
      if (!job || !job.id) { await sleep(30); continue; }
      const out = { id: job.id, ok: true, result: null };
      try { out.result = await run(job.op, job.args || {}); }
      catch (e) { out.ok = false; out.error = (e && e.message) ? e.message : String(e); }
      await fetch('http://127.0.0.1:' + PORT + '/push', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out)
      }).catch(() => {});
    } catch {
      // 桥没起（命令进程还没启动）或刚退出：稍等重连，不报错、不退出循环。
      await sleep(250);
    }
  }
}

function tabJson(t) {
  return {
    id: String(t.id), type: 'page', url: t.url || '', title: t.title || '',
    windowId: t.windowId, active: !!t.active,
    webSocketDebuggerUrl: 'av-ext://' + t.id   // ext 模式不会真的去连它
  };
}

async function attachTab(tabId, key) {
  const set = await sessionAttached();
  if (set.has(key)) return;
  try { await chrome.debugger.attach({ tabId }, '1.3'); }
  catch (e) {
    // SW 重启但 Chrome 侧仍挂着附加时会报这个，不算错。
    if (!/already attached|another debugger/i.test(String((e && e.message) || e))) throw e;
  }
  set.add(key);
  await sessionSet(set);
}

async function run(op, a) {
  if (op === 'ping') {
    return {
      extension: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      chrome: navigator.userAgent,
      bridge_port: PORT,
      attached: [...(await sessionAttached())]
    };
  }

  // ── browser 级操作：替代 CDP 的 /json/list、/json/new、/json/close ──
  if (op === 'tabs.list') return (await chrome.tabs.query({})).map(tabJson);
  if (op === 'tabs.create') return tabJson(await chrome.tabs.create({ url: a.url || 'about:blank', active: false }));
  if (op === 'tabs.close') {
    await chrome.tabs.remove(Number(a.tabId));
    const set = await sessionAttached(); set.delete(String(a.tabId)); await sessionSet(set);
    return { closed: true };
  }
  if (op === 'tabs.update') return tabJson(await chrome.tabs.update(Number(a.tabId), { url: a.url }));

  // ── CDP 传输：chrome.debugger.sendCommand 直接返回 CDP result ──
  // 允许域覆盖 agentviews 用到的全部命令：Runtime / Page / Input / Emulation /
  // DOM / Network / Target / Storage ...（官方 Restricted domains 列表）
  if (op === 'debugger.send') {
    const tabId = Number(a.tabId), key = String(tabId);
    await attachTab(tabId, key);
    try {
      return await chrome.debugger.sendCommand({ tabId }, a.method, a.params || {});
    } catch (e) {
      // 用户打开 DevTools 抢走调试者 / target 关闭 → 清标记，重连一次再试。
      const set = await sessionAttached(); set.delete(key); await sessionSet(set);
      try { await chrome.debugger.attach({ tabId }, '1.3'); }
      catch (e2) { if (!/already attached|another debugger/i.test(String((e2 && e2.message) || e2))) throw e; }
      const set2 = await sessionAttached(); set2.add(key); await sessionSet(set2);
      return await chrome.debugger.sendCommand({ tabId }, a.method, a.params || {});
    }
  }

  // done / stop 时显式 detach：attach 会在所有 Chrome 窗口显示「…正在调试此浏览器」
  // 信息栏，orphaned attachment 会让它永不消失（已查证的公开 bug）。
  if (op === 'debugger.detachAll') {
    const set = await sessionAttached();
    let n = 0;
    for (const key of [...set]) {
      try { await chrome.debugger.detach({ tabId: Number(key) }); n++; } catch { /* 已断 */ }
      set.delete(key);
    }
    await sessionSet(set);
    return { detached: n };
  }

  throw new Error('unknown op: ' + op);
}

chrome.debugger.onDetach.addListener(async source => {
  if (source && source.tabId != null) {
    const set = await sessionAttached(); set.delete(String(source.tabId)); await sessionSet(set);
  }
});
