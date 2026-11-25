# Agent 接入与安装目录

优先 CLI + Skill，需要 MCP 的客户端使用同一运行时的 MCP 接口。两个入口共享语义契约与单次用户确认机制，不需要内置模型、API key 或站点任务模板。

## Skill 分发

初始化默认安装通用目录及本机已经存在的 Agent 配置目录，可使用 `--agents all` 或按名称显式选择。已有非本工具管理的同名目录会报冲突，不默默覆盖。

| 名称 | 用户级技能目录 |
| --- | --- |
| universal | `~/.agents/skills/agentviews` |
| codex | `$CODEX_HOME/skills/agentviews`，默认 `~/.codex/skills/agentviews` |
| claude | `$CLAUDE_CONFIG_DIR/skills/agentviews`，默认 `~/.claude/skills/agentviews` |
| cursor | `~/.cursor/skills/agentviews` |
| copilot | `~/.copilot/skills/agentviews` |
| gemini | `~/.gemini/skills/agentviews` |
| opencode | `$XDG_CONFIG_HOME/opencode/skills/agentviews`，默认 `~/.config/opencode/skills/agentviews` |
| cline | `~/.cline/skills/agentviews` |
| roo | `~/.roo/skills/agentviews` |
| windsurf | `~/.codeium/windsurf/skills/agentviews` |
| antigravity | `~/.gemini/config/skills/agentviews` |

目录适配不保证任意客户端版本都会自动发现技能。需要按 Agent 自身机制刷新/加载；不支持技能的客户端可使用 MCP。

runner 从自己的 `scripts/tool-path.json` 定位已安装运行时，不依赖当前目录、npm 全局安装或下载缓存。源码中的 runner 可相对定位仓库。

## 系统运行目录

| 系统 | 默认位置 |
| --- | --- |
| macOS | `~/Library/Application Support/agentviews` |
| Windows | `%LOCALAPPDATA%/agentviews` |
| Linux | `$XDG_DATA_HOME/agentviews`，默认 `~/.local/share/agentviews` |

`--install-dir` 可以指定仓库之外的持久目录。通过该运行时验证时沿用原目录与配对，不要求再次下载。源扩展配置不能替代初始化返回的实际 `extension_path`。

## MCP

初始化生成 `mcp-config.json` 并返回实际路径。由 Agent 按客户端要求合并到现有配置，不整文件覆盖。生成的本机绝对路径属于用户安装，不提交到 GitHub。

MCP 默认扩展传输，不静默切换到无登录态的独立浏览器。每个 stdio 会话默认有独立状态；需要显式继续原任务时配置 `AV_STATE` 为原 `state_path`。

常用工具：`av_current`、`av_observe`、`av_read`、`av_map`、`av_act`、`av_verify`、`av_watch`、`av_task`、`av_resume`、`av_keep`。

实际参数以客户端 `tools/list` 返回的 schema 为准，不从 CLI 的 flag 名称猜 MCP 字段。常见对应关系：

| 工具 | 参数示意 |
| --- | --- |
| `av_current` | 无参数；仅用户明确指定当前页时调用 |
| `av_observe` | `full: false, max: 40` |
| `av_read` | `name: "当前唯一目标", max: 50000`，或使用当前快照 ID |
| `av_watch` | `operation: "start"`；poll 使用 `after/watch_id/state_path` |
| `av_resume` | 用户明确完成后 `user_done: true`；明确跳过登录为 `user_skip: true` |

名字、路径和游标均使用实际返回值。需要跨回合持续观察时不调用 `av_keep/av_done`，因为它们会停止当前监听；真正结束整个任务时才收尾。

## 初始化验收

自动/手动流程都必须实际验证扩展并新开后台页后才报告 ready。待导入、鉴别失败或新开页失败不是成功。手动流程不能替换为自动加载；用户导入后的验证通过已安装 runner 执行。

诊断先使用 `doctor`，不以访问业务页面、点击或提交验证连接。扩展 popup 的临时离线提示仅反映本机桥当时是否运行；以实际握手结果为准。

[操作确认](authorization.md) · [操作规则](../skills/agentviews/SKILL.md)
