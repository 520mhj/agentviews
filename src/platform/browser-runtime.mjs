import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function createBrowserRuntime({ install, defaultUserDataDir, HOST_STATE, BRIDGE_PORT, extPing, getBridge, dbg = () => {}, platform = process.platform, exec = execFileSync, read = readFileSync }) {
  function flagVal(command, name) {
    const match = command.match(new RegExp('(?:^|\\s)--' + name + '=(?:"([^"]+)"|(.+?)(?=\\s+(?:--[^\\s]+|(?:https?|file|about|chrome|edge):)|$))'));
    return match ? (match[1] || match[2] || '').trim() : '';
  }

  const normPath = p => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

  function chromeRoots() {
    const roots = [];
    try {
      const windows = platform === 'win32';
      const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|msedge|brave|chromium)\\.exe$' -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.ProcessId.ToString() + [char]1 + '' + [char]1 + $_.CommandLine }";
      const output = windows
        ? exec('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 9000, windowsHide: true })
        : exec('ps', ['-ww', '-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000 });
      for (const line of String(output).split(/\r?\n/)) {
        const fields = windows ? line.split('\u0001') : (line.trim().match(/^(\d+)\s+(.+)$/) || []).slice(1);
        const command = windows ? fields.slice(2).join('\u0001') : fields[1];
        if (!command || /--type=/.test(command) || !/^(?:"?[^"]*[/\\])?(?:Google Chrome(?: Canary)?|Microsoft Edge|Brave Browser|Chromium|google-chrome(?:-stable|-unstable)?|chrome|chromium(?:-browser)?|msedge|brave(?:-browser)?|microsoft-edge(?:-stable)?)(?:\.exe)?(?:"|\s|$)/i.test(command)) continue;
        let userDataDir = flagVal(command, 'user-data-dir');
        if (platform === 'linux') {
          try {
            const argumentsList = read('/proc/' + fields[0] + '/cmdline', 'utf8').split('\0');
            const argument = argumentsList.find(value => value.startsWith('--user-data-dir='));
            if (argument) userDataDir = argument.slice('--user-data-dir='.length);
          } catch {}
        }
        const match = command.match(/--remote-debugging-port=(\d+)/);
        roots.push({ pid: Number(fields[0]), title: windows ? fields[1] : '', cmd: command,
          ud: userDataDir, debugPort: match ? Number(match[1]) : null });
      }
    } catch (error) { dbg('browser process discovery', error.message); }
    return roots;
  }

  function dtaPort(ud) {
    if (!ud) return 0;
    try { return Number(read(join(ud, 'DevToolsActivePort'), 'utf8').trim().split(/\s+/)[0]) || 0; }
    catch { return 0; }
  }

  async function probePort(port, ms = 900) {
    if (!port) return { port, alive: false };
    try {
      const opt = { signal: AbortSignal.timeout(ms) };
      const v = await (await fetch('http://127.0.0.1:' + port + '/json/version', opt)).json();
      const l = await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(ms) })).json();
      const pages = l.filter(t => t.type === 'page');
      return { port, alive: true, browser: v.Browser, pages: pages.length,
               titles: pages.map(p => (p.title || '').slice(0, 48)).slice(0, 6) };
    } catch { return { port, alive: false }; }
  }

  async function discoverBrowsers() {
    const roots = chromeRoots();
    const candidates = [], seen = new Set();
    const add = async (port, source, extra = {}) => {
      if (!port || seen.has(port)) return;
      seen.add(port);
      const p = await probePort(port);
      candidates.push({ source, ...extra, ...p });
    };

    let hostPort = 0;
    try { hostPort = Number(JSON.parse(read(HOST_STATE, 'utf8')).port) || 0; } catch {}
    if (hostPort) await add(hostPort, 'host-state.json', { kind: 'host-managed', reusable: true });

    const explicit = Number(process.env.AV_ATTACH_PORT || 0);
    if (explicit) await add(explicit, 'AV_ATTACH_PORT', { kind: 'explicit', reusable: true });

    const browsers = [];
    for (const r of roots) {
      const isDefault = !r.ud || normPath(r.ud) === normPath(defaultUserDataDir());

      const item = {
        pid: r.pid,
        kind: isDefault ? 'desktop-main' : 'isolated-profile',
        title: r.title,
        profile: r.ud || '(default: ' + defaultUserDataDir() + ')',
        debug_flag: r.debugPort === null ? 'none' : (r.debugPort === 0 ? 'random → DevToolsActivePort' : String(r.debugPort)),
        cdp_port: (r.debugPort === 0 || r.debugPort === null) ? dtaPort(r.ud) : r.debugPort,
        attachable: false,
        why: ''
      };
      if (item.cdp_port) {
        await add(item.cdp_port, 'chrome-process:' + r.pid, { kind: item.kind, pid: r.pid, profile: item.profile });
      }
      browsers.push(item);
    }

    for (const b of browsers) {
      const c = candidates.find(x => x.port === b.cdp_port);
      if (c && c.alive) {
        b.attachable = true;
        b.why = 'CDP 端口 ' + b.cdp_port + ' 可达';
      } else if (b.kind === 'desktop-main') {
        b.why = '没有 --remote-debugging-port；Chrome 136+ 禁止在默认 user data dir 上开远程调试，且 CDP 端口只能在进程启动时开启，运行中的浏览器无法事后追加';
      } else {
        b.why = '未发现可用 CDP 端口';
      }
    }
    const alive = candidates.filter(c => c.alive);

    const extBridge = await extPing(1200);
    const cdpRecommend = alive[0] || null;
    const extPages = extBridge ? (await getBridge().job('tabs.list', {}, 1200).catch(() => [])).length : 0;
    const recommend = extBridge
      ? { mode: 'ext', port: BRIDGE_PORT, source: 'av-bridge-ext', kind: 'desktop-main-chrome', browser: 'desktop Chrome (same profile)', pages: extPages }
      : (cdpRecommend ? { mode: 'cdp', port: cdpRecommend.port, source: cdpRecommend.source, kind: cdpRecommend.kind, browser: cdpRecommend.browser, pages: cdpRecommend.pages } : null);
    return {
      chrome_root_processes: roots.length,
      install: install(),
      default_profile: defaultUserDataDir(),
      desktop_main: browsers.find(b => b.kind === 'desktop-main') || null,
      browsers,
      candidates,
      ext_bridge: {
        port: BRIDGE_PORT,
        installed: !!extBridge,
        extension: extBridge ? extBridge.extension : null,
        version: extBridge ? extBridge.version : null,
        attached: extBridge ? extBridge.attached : [],
        role: 'agentviews 自有 CDP 传输：chrome.debugger API 直接驱动桌面主 Chrome 的标签页，cookies/登录态/窗口天然复用'
      },
      recommend,
      advice: [
        '推荐：在 chrome://extensions 加载 agentviews/bridge-ext 一次，之后用 --ext 或 --auto 直连桌面主浏览器，无需重启、无需 --remote-debugging-port',
        '兼容路径：--attach <port> 或 AV_ATTACH_PORT=<port> 连任意已开调试端口的 Chrome',
        '运行期开关：Chrome 156 可在 chrome://inspect/#remote-debugging 勾选「Allow remote debugging for this browser instance」后连默认 profile；需每会话允许一次并显示自动化横幅'
      ],
      note: 'agentviews 的 CDP 传输来自自有 MV3 扩展（bridge-ext + chrome.debugger），直接驱动桌面主浏览器的标签页，不需要调试端口'
    };
  }

  return { chromeRoots, discoverBrowsers };
}
