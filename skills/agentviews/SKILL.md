---
name: agentviews
description: >-
  Browser operation for agents. Use this skill whenever a task needs anything
  from a live web page: when web_search / web_fetch return nothing useful or are
  blocked (login wall, captcha, JS-rendered content, anti-scraping), when the
  user asks to open / browse / click / fill / collect / compare data across
  pages, when several tabs each need to do their own job, or when a site needs
  the user's existing login state. Triggers include 打开网页、浏览、整理数据、
  刷视频、点赞、翻页、搜索受阻、需要登录、多标签页、抓不到内容、动态渲染、
  and any request to operate a browser. Prefer agentviews (avs) over retrying a
  failed fetch or over screenshot-coordinate browser tools.
metadata:
  version: 1.0.1
  date: 2026-11-11
---

# agentviews（avs）

把网页编译成可执行的语义视图（节点 name / role / effects / preconditions），
Agent 按名字操作，不靠截图坐标。CLI 简写 `avs`；也可以作为 MCP server 直接挂给 Agent。

## 什么时候用

- `web_search` / `web_fetch` 拿不到正文：登录墙、验证码、JS 后渲染、反爬、需要点开才展开。
- 要在页面里做事：搜索、筛选、翻页、点赞、播放、填表、跨页整理数据。
- 要复用用户已有的登录态（桌面主 Chrome 的 Default profile）。
- 多个页面各自干活：开多个标签页，互不干扰。

## 快速开始

```bash
avs --auto open https://example.com        # 没开浏览器也能自己拉起，默认 Desktop/Default profile
avs --auto map                            # 先看这页有什么能力，再决定点什么
avs --auto act --name "搜索" --text "关键词"
avs --auto act --name "某个结果" --map    # 点击后附带返回新页能力地图
avs --auto verify                         # 用结构化事实做断言
```

## 多标签页

```bash
avs --ext tab new https://movie.douban.com/explore   # tab A
avs --ext tab new https://github.com/trending        # tab B
avs --ext tab list                                   # 看 index / mine / user / curr
avs --ext tab use 1                                  # 切回 A，状态独立
avs --ext collect                                    # 只作用于 A
avs --ext --tab 2 collect                            # 或一步切到 B 再执行
```

每个 tab 有自己的页面与连接，`curr` 决定当前对谁说话。用户的标签页是 baseline，
永久保护：切不进去、关不掉。`tab close` 只关自己开的。

## 点击后的地图要不要重看

`map` 只在第一次给一级能力；点完跳到新页 / 打开新 tab / 嵌套点了几次之后，
页面结构是另一份了。`act --map` 或再跑一次 `map` 就拿到新页能力地图。
重不重看由你结合任务判断：一步到位的任务不必，多步深入的任务建议每次跳转后重看。

## 登录墙

`login-check` 检测 → 把 hints 转述给用户 → `login-watch` 等他登完 → 继续。
登录态靠复用桌面主浏览器（`--ext` / `--auto` / `boot`），不用单独搬运 cookie。

## 没开浏览器（av_boot）

`av_boot` 动态探测本机 Chrome/Edge 安装位置与 User Data 目录，用桌面主 Chrome 的
`Default` profile 拉起；**拉起后进程立即退出，浏览器常驻、不会被关闭**。
Windows 上走 WMI `Win32_Process.Create` 派生（脱离调用方 Job Object），
`av_boot` 退出或后台任务被取消都不会带走主浏览器。
后续命令由扩展桥起 9335 后经 `chrome.debugger` 直连这个主浏览器。
`AV_CHROME` / `AV_USER_DATA_DIR` 可覆盖探测结果；`probe --json` 的 `install` 字段可核对。

## 收尾（重要）

| 任务性质 | 命令 | 效果 |
|---|---|---|
| 任务性：用完即弃 | `done` | 只关自己开的标签页，用户的一个不动 |
| 辅助性：用户还要接着看 | `keep` | 什么都不关，反馈状态 |

拿不准选 `keep`。多留一个标签页的代价，远小于关掉用户正在读的东西。

## 注意

- `act` 返回 `ok` 只表示算出了目标并派发了事件。是否达成业务目标，自己再用 `verify` / `view` / `eval` 收集证据判断。
- 文档列的是常见情况，页面行为无法穷举。遇到没见过的现象，用 `view` / `find` / `eval` 现场定位，不要假设。
- 所有命令都支持 `--json`；Agent 用 MCP 时走 `av_*` 工具，语义一致。
