# Chrome Web Store 上架说明（AgentViews CDP Bridge）

> 本扩展是 agentviews 项目（本地、开源、自用的浏览器语义驱动层）的组件。它不是面向普通消费者的数据采集或广告插件，而是一个**本地开发/自动化工具**：让本机 Node 进程通过 Chrome 官方的 `chrome.debugger` API，驱动**用户自己**桌面 Chrome 里的标签页。所有通信只走 `127.0.0.1` 回环，不上传任何数据到外部服务器。

## 这个扩展做什么

1. 装在你日常用的桌面 Chrome（默认 profile）里。
2. 与本机 `node agentviews.mjs --ext` 起的一个 loopback HTTP 桥（`127.0.0.1:9335`）通信。
3. 收到本机请求后，用 `chrome.debugger.attach({tabId}, '1.3')` 附加到**你刚刚让 agentviews 打开的那个标签页**，转发 CDP 命令（`Runtime.evaluate` / `Page.navigate` / `Page.captureScreenshot` / `Input.dispatchMouseEvent` 等），把结果回给本机进程。
4. `done` 时显式 `chrome.debugger.detach()`，只关闭自己开的标签页，绝不碰用户其它标签页或整个浏览器窗口。

agentviews 用这些能力把网页压成约 1300–2700 字符的结构化视图（节点带名字/状态/动作语义），供 Agent 做多步网页操作。这是本项目 `README.md` / `REPORT.md` 记录的研究工具。

## 逐权限理由

| 权限 | 为什么必需 | 具体用途 |
| --- | --- | --- |
| `debugger` | **核心权限**。`chrome.debugger` 官方文档把它定义为 "an alternate transport for Chrome's remote debugging protocol"。桌面主 Chrome 从 Chrome 136 起禁止在默认 user data dir 上开 `--remote-debugging-port`，所以端口 attach 这条路走不通；这个 API 是唯一能在**运行中的、用户已登录的**默认 profile 里拿到 CDP 的官方机制。 | `attach` / `sendCommand` / `detach` / `getTargets`，转发 agentviews 需要的 Runtime/Page/Input/Emulation/DOM 域命令。 |
| `tabs` | 要列出「哪些标签页存在」、新开一个自己拥有的 `about:blank`、任务完成后只关自己开的那个、把 tabId 映射成可调试的目标。没有它就无法实现「绝不关用户标签页」的所有权模型。 | `chrome.tabs.query` / `create` / `remove` / `update` / `get`。只读 URL/标题/id，不读标签页内容。 |
| `storage` | 保存本机桥端口（默认 9335，可在 popup 改）与「已附加的 tabId 集合」。MV3 service worker 会被回收，`chrome.storage.session` 让附加状态在 SW 重启后不丢，避免 "already attached" 误判。 | `chrome.storage.local`（桥端口）、`chrome.storage.session`（avAttached）。不存任何 cookie、页面内容或用户数据。 |
| `alarms` | MV3 service worker 空闲 30s 会被回收。扩展用一个常驻的 `/pull` 长轮询保持活跃，并用一个 30s（MV3 最小周期）的心跳闹钟做兜底唤醒，保证桥不会静默失联。 | `chrome.alarms.create('av-bridge-keepalive', {periodInMinutes: 0.5})`，唤醒后重连 `/pull`。 |
| `host_permissions: http://127.0.0.1/*` | 扩展要 `fetch()` 本机桥的 `/pull` 与 `/push`。**只绑定回环地址**，不是任何公网域名。 | `fetch('http://127.0.0.1:9335/pull')`、`POST /push`。 |
| `host_permissions: http://localhost/*` | 同上，允许本机以 `localhost` 而非 `127.0.0.1` 配置桥端口时的等价形式。 | 同上。 |

## 明确不做的事

- 不请求 `<all_urls>` 内容脚本注入、不请求 `cookies`、不请求 `webRequest`、不请求 `history`、不请求 `downloads`、不请求 `nativeMessaging`。
- 不读取、不导出、不上传任何 cookie、密码、页面文本、截图到**外部**服务器。截图（如 `shot` 命令）只回给本机 `127.0.0.1` 的 agentviews 进程并落在本地磁盘。
- 不向任何第三方域名发请求。唯一的网络目标是 `http://127.0.0.1:<本机端口>/`。
- 不修改用户已有标签页、不关闭浏览器窗口、不改写默认搜索引擎/主页/新标签页。
- 不采集分析、无遥测、无远程配置。

## 数据流向（给审核者）

```
本机 Node 进程 (agentviews.mjs, 127.0.0.1:9335)
      │  HTTP 长轮询 /pull  ←  扩展主动连本机
      │  HTTP /push  →  回 CDP 结果
      ▼
扩展 service worker (本机, 无外部网络)
      │  chrome.debugger.sendCommand({tabId}, …)
      ▼
你自己的桌面 Chrome 标签页 (默认 profile)
```

整条链路里没有任何外部服务器；扩展是**客户端**，本机 Node 进程是**服务端**，方向是「外部无法主动连入浏览器」。

## 用户控制与可见性

- 扩展默认不自动附加任何标签页：只有本机 `agentviews --ext open/act/…` 显式发命令时才 `attach`。
- `chrome.debugger.attach` 会让 Chrome 显示「…正在调试此浏览器」的信息栏，用户随时可见；用户打开 DevTools 会触发 `onDetach`，扩展清理状态并停止附加。
- 用户随时可以在 `chrome://extensions` 停用/卸载扩展，或在 popup 里改桥端口、查看在线状态与已附加数。
- 任务结束 `done` 显式 `detachAll`，避免遗留调试信息栏。

## 安装与使用

见 `README.md`「自有扩展桥（`--ext`，v10）」一节：开 `chrome://extensions` 开发者模式 → 加载已解压的 `bridge-ext/` → 本机跑 `node agentviews.mjs --ext probe` 验收。Chrome 156 起 `--load-extension` 命令行开关已失效，因此必须一次性手动加载（这一动作归用户，工具不代劳）。

## 版本与兼容

- `minimum_chrome_version: "125"`（`chrome.debugger` 的 flat sessions / Promise 形式从 125 起稳定）。
- 开发验证环境：Chrome 156.0.8078.81、Node 24.11.0、Windows 11。
