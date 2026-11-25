import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { ROOT_DIRECTORY } from '../core/paths.mjs';
import { ensureBridgePairing, validateBridgePairing } from './bridge-pairing.mjs';
import { applicationDataDir } from '../platform/browser-discovery.mjs';
import { launchBrowser } from '../platform/browser-launch.mjs';

const HERE = ROOT_DIRECTORY;
const RUNTIME_FILES = [...JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).files, 'package.json'];

export function agentDirectories({ home = homedir(), env = process.env } = {}) {
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  return {
    universal: join(home, '.agents', 'skills'),
    codex: join(env.CODEX_HOME || join(home, '.codex'), 'skills'),
    claude: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills'),
    cursor: join(home, '.cursor', 'skills'),
    copilot: join(home, '.copilot', 'skills'),
    gemini: join(home, '.gemini', 'skills'),
    opencode: join(config, 'opencode', 'skills'),
    windsurf: join(home, '.codeium', 'windsurf', 'skills'),
    cline: join(home, '.cline', 'skills'),
    roo: join(home, '.roo', 'skills'),
    antigravity: join(home, '.gemini', 'config', 'skills'),
  };
}

function assertManaged(destination, marker) {
  if (!existsSync(destination)) return;
  if (lstatSync(destination).isSymbolicLink() || !existsSync(join(destination, marker))) {
    throw new Error('拒绝覆盖已有非 AgentViews 管理目录：' + destination);
  }
}

export function installAgentSkills(options = {}) {
  const home = options.home || homedir();
  const env = options.env || process.env;
  const directories = agentDirectories({ home, env });
  const selection = options.agents || 'auto';
  const names = selection === 'all' ? Object.keys(directories)
    : selection === 'auto' ? Object.keys(directories).filter(name => name === 'universal' || existsSync(dirname(directories[name])))
    : selection.split(',').map(name => name.trim());
  for (const name of names) if (!directories[name]) throw new Error('未知 Agent：' + name);
  const source = realpathSync(options.source || HERE);
  const installedSource = existsSync(join(source, '.agentviews-runtime.json')) && !existsSync(join(source, '.git'));
  const runtime = resolve(options.installDir || (installedSource ? source : applicationDataDir({ home, env, platform: options.platform })));
  const distance = relative(source, runtime);
  if (!installedSource && (!distance || !isAbsolute(distance) && distance !== '..' && !distance.startsWith('..' + sep))) throw new Error('持久化运行目录必须位于源码仓库之外');
  const targets = [...new Set(names.map(name => join(directories[name], 'agentviews')))];
  if (runtime !== source) assertManaged(runtime, '.agentviews-runtime.json');
  for (const target of targets) assertManaged(target, '.agentviews-managed.json');
  const port = env.AV_BRIDGE_PORT === undefined ? undefined : Number(env.AV_BRIDGE_PORT);
  validateBridgePairing(runtime, { port });
  if (runtime !== source) {
    mkdirSync(runtime, { recursive: true });
    for (const entry of RUNTIME_FILES) {
      cpSync(join(source, entry), join(runtime, entry), { recursive: true, dereference: false,
        filter: filename => resolve(filename) !== join(source, 'bridge-ext', 'config.js') });
    }
    writeFileSync(join(runtime, '.agentviews-runtime.json'), JSON.stringify({ name: 'agentviews', source, version: '2.0.0' }), { mode: 0o600 });
  }
  const canonicalRuntime = realpathSync(runtime);
  const pairing = ensureBridgePairing(canonicalRuntime, { port, sourceRoot: installedSource ? undefined : source });
  const mcpConfig = join(canonicalRuntime, 'mcp-config.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { agentviews: {
    command: process.execPath, args: [join(canonicalRuntime, 'mcp.mjs')], env: { AGENTVIEWS_TRANSPORT: 'ext', AV_BRIDGE_PORT: String(pairing.port) },
  } } }, null, 2), { mode: 0o600 });
  for (const target of targets) {
    mkdirSync(join(target, 'scripts'), { recursive: true });
    cpSync(join(runtime, 'skills', 'agentviews', 'SKILL.md'), join(target, 'SKILL.md'));
    cpSync(join(runtime, 'skills', 'agentviews', 'scripts', 'avs.mjs'), join(target, 'scripts', 'avs.mjs'));
    writeFileSync(join(target, 'scripts', 'tool-path.json'), JSON.stringify({ runtime: canonicalRuntime }), { mode: 0o600 });
    writeFileSync(join(target, '.agentviews-managed.json'), JSON.stringify({ name: 'agentviews', runtime }), { mode: 0o600 });
  }
  return { runtime: realpathSync(runtime), extension_path: realpathSync(join(runtime, 'bridge-ext')), installed_skills: targets, mcp_config: mcpConfig, bridge_port: pairing.port };
}

export async function initialize(mode, options) {
  if (!['auto', 'manual', 'verify'].includes(mode)) throw new Error('用法：init auto | init manual | init verify');
  const installed = options.installed;
  if (mode !== 'manual') {
    let extension = await options.ping();
    if (!extension && mode === 'auto' && options.install.exe) {
      const supported = options.install.product === 'chromium' || /chrome for testing|chrome-for-testing/i.test(options.install.exe);
      if (supported) {
        const profile = join(installed.runtime, 'extension-profile');
        await (options.launch || launchBrowser)({ exe: options.install.exe, userDataDir: profile, extension: installed.extension_path });
        extension = await options.ping(12000);
      }
    }
    if (extension && typeof extension.extension === 'string' && extension.session_id) {
      const tab = await options.createTab('about:blank');
      if (!tab || !tab.id) throw new Error('扩展已响应，但未成功创建标签页；初始化未完成');
      return { ...installed, status: 'ready', extension_verified: true, tab,
        message: '初始化完成，可以开始浏览器任务。', browser_focus_required: false };
    }
    if (mode === 'verify') return { ...installed, status: 'needs_extension_import', extension_verified: false,
      message: '扩展尚不可用，不能宣布初始化完成。请确认已导入并启用扩展，再反馈 Agent 验证。' };
  }
  if (options.install.exe && options.openSettings !== false) {
    await (options.launch || launchBrowser)({ exe: options.install.exe, userDataDir: options.install.user_data_dir,
      urls: [options.install.product === 'edge' ? 'edge://extensions' : 'chrome://extensions'] });
  }
  return { ...installed, status: 'needs_extension_import', extension_verified: false,
    automatic_install_supported: false,
    message: '项目和技能已安装。请在扩展管理页开启开发者模式，手动加载 extension_path 指向的目录，然后回复 Agent“已完成导入扩展”。Agent 必须运行 init verify，验证扩展可用并新开标签页后再宣布初始化完成。',
    reason: mode === 'auto' ? '当前浏览器未提供可验证的静默扩展安装方式；不会重启用户浏览器、修改用户配置或绕过浏览器安全策略。' : '等待用户手动导入扩展。',
    next_command: 'node "' + join(installed.runtime, 'agentviews.mjs') + '" init verify',
  };
}
