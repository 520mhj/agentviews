import './config.js';
import { authenticatedFetch } from './auth.js';

const CONFIG = globalThis.__AV_BRIDGE_CONFIG || {};
const find = id => document.getElementById(id);

async function refresh(port) {
  const element = find('state');
  if (typeof CONFIG.token !== 'string' || !/^[a-f0-9]{64}$/i.test(CONFIG.token)) {
    element.textContent = '扩展尚未配对。请运行 init 并加载初始化输出的本机 extension_path，不能直接加载未配置源码目录。';
    return;
  }
  try {
    const state = await chrome.storage.session.get({ avBrowserSession: null });
    if (!state.avBrowserSession) { element.textContent = '扩展正在启动，请稍后重试。'; return; }
    const result = await authenticatedFetch('/ping', { token: CONFIG.token, port, session: state.avBrowserSession, timeoutMs: 1200 });
    const info = result.info || {};
    const extension = result.extension || info.extension;
    const version = result.version || info.version;
    const attached = Array.isArray(result.attached) ? result.attached : [];
    element.textContent = extension
      ? '已鉴别的桥在线 ✓\n扩展 ' + extension + ' / v' + version + '\n端口 ' + port + ' · 已 attach ' + attached.length + ' 个标签页'
      : result.paired ? '已鉴别的桥在线，扩展正在轮询。' : '已鉴别的桥在线，等待扩展轮询。';
  } catch {
    element.textContent = '桥未启动或鉴别失败（' + port + '）。命令结束后桥关闭是正常现象；请运行 init verify 检查配对。';
  }
}

chrome.storage.local.get({ bridgePort: CONFIG.port || 9335 }, state => {
  find('port').value = state.bridgePort || CONFIG.port || 9335;
  refresh(Number(find('port').value));
});

find('save').addEventListener('click', () => {
  const port = Number(find('port').value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    find('state').textContent = '请输入 1 到 65535 之间的整数端口。';
    return;
  }
  chrome.storage.local.set({ bridgePort: port }, () => {
    find('state').textContent = '已保存端口 ' + port + '，CLI 侧请设 AV_BRIDGE_PORT=' + port;
    refresh(port);
  });
});
