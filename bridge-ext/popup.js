const $ = id => document.getElementById(id);

// 说明：这个 popup 只是「桥是否被 CLI 起起来 + 扩展是否在轮询」的随手一看。
// 它连不上是常态 —— agentviews 只在执行命令时临时起桥，命令结束桥就关了。
// 判断安装是否成功请用 CLI：`node agentview.mjs --ext probe`
async function refresh(port) {
  const el = $('state');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(1200) });
    const j = await r.json();
    // /ping 同时给扁平字段和 info 子对象，两种都认，避免结构变动就显示"未安装"。
    const info = j.info || {};
    const extId = j.extension || info.extension;
    const ver = j.version || info.version;
    const attached = j.attached || info.attached || [];
    if (extId) {
      el.textContent = `桥在线 ✓\n扩展 ${extId} / v${ver}\n端口 ${port} · 已 attach ${attached.length} 个标签页`;
    } else if (j.paired) {
      el.textContent = `桥在 ${port}，已有扩展在轮询（尚未取到扩展身份）`;
    } else {
      el.textContent = `桥在 ${port}，但还没有扩展轮询。\n若 CLI 正在跑命令，等一两秒再点"保存并重试"。`;
    }
  } catch {
    el.textContent = `桥未启动（${port}）。这是正常的：agentviews 只在执行命令时临时起桥。\n要验证安装请跑：node agentview.mjs --ext probe`;
  }
}

chrome.storage.local.get({ bridgePort: 9335 }, s => {
  $('port').value = s.bridgePort || 9335;
  refresh(Number(s.bridgePort) || 9335);
});

$('save').addEventListener('click', () => {
  const p = Number($('port').value) || 9335;
  chrome.storage.local.set({ bridgePort: p }, () => {
    $('state').textContent = `已保存端口 ${p}，CLI 侧请设 AV_BRIDGE_PORT=${p}`;
    refresh(p);
  });
});
