const $ = id => document.getElementById(id);

async function refresh(port) {
  const el = $('state');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(1200) });
    const j = await r.json();
    el.textContent = j.extension
      ? `在线 ✓ 扩展 ${j.extension} / v${j.version}\n桥端口 ${port}，已 attach ${j.attached.length} 个标签页`
      : `桥在 ${port}，但尚无扩展轮询记录（CLI 侧桥已启动）`;
  } catch {
    el.textContent = `桥未启动（${port}）。这是正常的：agentview 只在执行命令时临时起桥。`;
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
