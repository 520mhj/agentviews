#!/usr/bin/env node
/**
 * agentviews v1.0.1 — 动态探测本机浏览器可执行文件与 User Data 目录。
 *
 * 为什么独立成模块：安装盘符 / 目录人人不同，硬编码几个绝对路径在别人机器上
 * 必然失效。这里按「显式环境变量 → 注册表 App Paths → 环境变量动态拼路径 → PATH」
 * 逐级探测，User Data 按浏览器产品（Chrome/Edge）+ LOCALAPPDATA 推导，全程不写死盘符。
 *
 * 探测结果在进程内缓存一次；Chrome / Edge 谁先命中就用谁。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOCALAPP = process.env.LOCALAPPDATA
  || join(process.env.USERPROFILE || '', 'AppData', 'Local');

let CACHED = null;

function fromRegistry() {
  // App Paths 是安装程序写下的权威位置，能覆盖自定义安装盘符 / 非默认目录。
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
  ];
  for (const key of keys) {
    try {
      const txt = execFileSync('reg', ['query', key, '/ve'],
        { encoding: 'utf8', timeout: 4000, windowsHide: true });
      const m = String(txt).match(/REG_SZ\s+(.+\.exe\b)/i);
      const p = m && m[1].trim();
      if (p && existsSync(p)) return { exe: p, source: 'registry App Paths: ' + key };
    } catch { /* 该键不存在或 reg 不可用，继续下一级 */ }
  }
  return null;
}

function fromEnvPaths() {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
    LOCALAPP,
  ].filter(Boolean);
  const rels = [
    join('Google', 'Chrome', 'Application', 'chrome.exe'),
    join('Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join('Google', 'Chrome SxS', 'Application', 'chrome.exe'),
  ];
  for (const root of roots) {
    for (const rel of rels) {
      const p = join(root, rel);
      if (existsSync(p)) return { exe: p, source: 'env path: ' + p };
    }
  }
  return null;
}

function fromPath() {
  for (const name of ['chrome.exe', 'msedge.exe']) {
    try {
      const txt = execFileSync('where.exe', [name],
        { encoding: 'utf8', timeout: 4000, windowsHide: true });
      const p = String(txt).split(/\r?\n/).map(s => s.trim()).find(s => /\.exe$/i.test(s));
      if (p && existsSync(p)) return { exe: p, source: 'PATH (where.exe): ' + p };
    } catch { /* 不在 PATH */ }
  }
  return null;
}

/** 返回 { exe, source }；找不到时 exe=null。结果进程内缓存。 */
export function chromeExe() {
  if (CACHED) return CACHED;
  if (process.env.AV_CHROME) {
    CACHED = { exe: process.env.AV_CHROME, source: 'AV_CHROME' };
    return CACHED;
  }
  CACHED = fromRegistry() || fromEnvPaths() || fromPath() || { exe: null, source: 'not-found' };
  return CACHED;
}

/** User Data 目录：显式覆盖 > 按 exe 判 Chrome/Edge 动态拼 LOCALAPPDATA。 */
export function findUserDataDir(exe) {
  if (process.env.AV_USER_DATA_DIR) return process.env.AV_USER_DATA_DIR;
  const e = String(exe || '').toLowerCase();
  if (/edge|msedge/.test(e)) return join(LOCALAPP, 'Microsoft', 'Edge', 'User Data');
  return join(LOCALAPP, 'Google', 'Chrome', 'User Data');
}

/** 给 boot / probe 用：一次列出探测依据，便于核对是不是自己装的那套浏览器。 */
export function describeInstall() {
  const f = chromeExe();
  return {
    exe: f.exe,
    exe_source: f.source,
    user_data_dir: findUserDataDir(f.exe),
    localappdata: LOCALAPP,
    overrides: {
      AV_CHROME: process.env.AV_CHROME || null,
      AV_USER_DATA_DIR: process.env.AV_USER_DATA_DIR || null,
    },
  };
}

// 直接 `node chrome-detect.mjs` 时打印探测结果，方便人工核对。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(describeInstall(), null, 2));
}
