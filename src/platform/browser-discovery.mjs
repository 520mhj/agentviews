import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

const PRODUCTS = [
  { name: 'chrome', app: 'Google Chrome', binary: 'Google Chrome', windows: 'Google/Chrome', linux: 'google-chrome', commands: ['google-chrome', 'google-chrome-stable'], config: 'google-chrome' },
  { name: 'edge', app: 'Microsoft Edge', binary: 'Microsoft Edge', windows: 'Microsoft/Edge', linux: 'microsoft-edge', commands: ['microsoft-edge', 'microsoft-edge-stable'], config: 'microsoft-edge' },
  { name: 'brave', app: 'Brave Browser', binary: 'Brave Browser', windows: 'BraveSoftware/Brave-Browser', linux: 'brave-browser', commands: ['brave-browser', 'brave'], config: 'BraveSoftware/Brave-Browser' },
  { name: 'chromium', app: 'Chromium', binary: 'Chromium', windows: 'Chromium', linux: 'chromium', commands: ['chromium', 'chromium-browser'], config: 'chromium' },
  { name: 'chrome-canary', app: 'Google Chrome Canary', binary: 'Google Chrome Canary', windows: 'Google/Chrome SxS', commands: ['google-chrome-unstable'], config: 'google-chrome-unstable' },
];

function productFor(exe) {
  const value = String(exe || '').toLowerCase();
  if (/brave/.test(value)) return PRODUCTS[2];
  if (/edge|msedge/.test(value)) return PRODUCTS[1];
  if (/chromium/.test(value)) return PRODUCTS[3];
  if (/canary|chrome sxs|chrome-unstable/.test(value)) return PRODUCTS[4];
  return PRODUCTS[0];
}

export function detectBrowsers(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || homedir();
  const pathApi = platform === 'win32' ? win32 : { join };
  const present = options.exists || existsSync;
  const execute = options.exec || execFileSync;
  const found = [];
  const seen = new Set();
  const add = (exe, source, product = productFor(exe)) => {
    if (!exe || !present(exe) || seen.has(exe)) return;
    seen.add(exe);
    found.push({ exe, source, product: product.name });
  };
  if (env.AV_CHROME) {
    add(env.AV_CHROME, 'AV_CHROME');
    return found;
  }
  for (const product of PRODUCTS) {
    if (platform === 'win32') {
      const binary = product.name === 'edge' ? 'msedge.exe' : product.name === 'brave' ? 'brave.exe' : 'chrome.exe';
      for (const hive of ['HKCU', 'HKLM']) {
        const key = hive + '\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + binary;
        try {
          const output = execute('reg', ['query', key, '/ve'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
          const match = String(output).match(/REG_(?:EXPAND_)?SZ\s+(.+\.exe)\s*$/im);
          if (match) add(match[1].trim().replace(/%([^%]+)%/g, (matchText, name) => env[name] || matchText), 'registry App Paths', productFor(match[1]));
        } catch {}
      }
      const local = env.LOCALAPPDATA || pathApi.join(env.USERPROFILE || home, 'AppData', 'Local');
      for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], local].filter(Boolean)) {
        add(pathApi.join(root, ...product.windows.split('/'), 'Application', binary), 'Windows installation', product);
      }
      try {
        const output = execute('where.exe', [binary], { encoding: 'utf8', timeout: 4000, windowsHide: true });
        for (const candidate of String(output).trim().split(/\r?\n/)) add(candidate.trim(), 'PATH', productFor(candidate));
      } catch {}
    } else if (platform === 'darwin') {
      for (const root of ['/Applications', join(home, 'Applications')]) {
        add(join(root, product.app + '.app', 'Contents', 'MacOS', product.binary), 'macOS application bundle', product);
      }
      try {
        const output = execute('mdfind', ['kMDItemFSName == "' + product.app + '.app"'], { encoding: 'utf8', timeout: 4000 });
        for (const bundle of String(output).trim().split(/\r?\n/)) {
          if (bundle.endsWith('.app')) add(join(bundle, 'Contents', 'MacOS', product.binary), 'macOS Spotlight', product);
        }
      } catch {}
    } else if (platform === 'linux') {
      for (const command of product.commands) {
        for (const root of (env.PATH || '').split(':').filter(Boolean)) add(join(root, command), 'PATH', product);
        for (const root of ['/usr/bin', '/usr/local/bin', '/snap/bin']) add(join(root, command), 'Linux installation', product);
      }
      if (product.linux) add(join('/opt', product.linux, product.linux), 'Linux /opt installation', product);
      if (product.name === 'chrome') add('/opt/google/chrome/chrome', 'Linux /opt installation', product);
    }
  }
  return found;
}

export function chromeExe(options) {
  return detectBrowsers(options)[0] || { exe: null, source: 'not-found', product: null };
}

export function findUserDataDir(exe, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || homedir();
  if (env.AV_USER_DATA_DIR) return env.AV_USER_DATA_DIR;
  const product = productFor(exe);
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || win32.join(env.USERPROFILE || home, 'AppData', 'Local');
    return win32.join(local, ...product.windows.split('/'), 'User Data');
  }
  if (platform === 'darwin') {
    const config = product.name === 'chrome' ? ['Google', 'Chrome']
      : product.name === 'chrome-canary' ? ['Google', 'Chrome Canary']
      : product.name === 'edge' ? ['Microsoft Edge']
      : product.name === 'brave' ? ['BraveSoftware', 'Brave-Browser'] : ['Chromium'];
    return join(home, 'Library', 'Application Support', ...config);
  }
  if (platform === 'linux') return join(env.XDG_CONFIG_HOME || join(home, '.config'), product.config);
  return null;
}

export function applicationDataDir(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || homedir();
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'agentviews');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'agentviews');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'agentviews');
}

export function describeInstall(options = {}) {
  const browsers = detectBrowsers(options);
  const selected = browsers[0] || { exe: null, source: 'not-found', product: null };
  const env = options.env || process.env;
  return {
    platform: options.platform || process.platform,
    product: selected.product,
    exe: selected.exe,
    exe_source: selected.source,
    user_data_dir: selected.exe ? findUserDataDir(selected.exe, options) : null,
    localappdata: env.LOCALAPPDATA || null,
    browsers,
    overrides: { AV_CHROME: env.AV_CHROME || null, AV_USER_DATA_DIR: env.AV_USER_DATA_DIR || null },
    unsupported: 'Safari and Firefox do not expose the Chromium extension debugger transport.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(describeInstall(), null, 2));
}
