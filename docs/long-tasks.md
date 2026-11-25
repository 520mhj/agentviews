# 监听、恢复与任务状态

目录：[通用监听](#通用监听) · [恢复](#恢复原会话) · [任务验证](#任务验证) · [限制](#限制与收尾)

AVS 保存浏览器观察和验证线索；任务规划、业务推理与场景判断由调用方 Agent 完成。**持续观察不是持续推理，进程存活也不是业务成功。**

## 通用监听

Agent 先按用户要求选择目标：新 URL 使用工具自己的后台页；用户明确指定当前页时仅调用一次 `--ext --current map`。随后保持同一 `--state` / `AV_STATE`。

```bash
avs --ext watch start --timeout 3600 --beat 1
avs watch status
avs watch poll --after 0 --timeout 5
```

- `start` 启动独立只读采样进程；期限 1–28800 秒，采样间隔 0.25–10 秒。
- `poll` 等待窗口 0–30 秒；返回事件、`next_cursor` 和 `gap`，不消费或删除事件。
- 每次下一次 poll 使用返回的游标。需要原目标的新鲜内容时增加 `--snapshot`，或单独 `observe/read`，不要用变化事件推断当前控件身份。
- 只监听原页；活动窗口或标签变化不改变目标。监听期间不导航、新开、切换或关闭任务页。
- `needs_user_action` 不会因为监听页面变化就解除。有确认请求时由用户选择单次授权执行、亲自操作或取消；用户亲自完成后仍由 `resume --user-done` 复核。

CLI/MCP 回合结束后采样仍可继续。监听事件独立于模型上下文，不将宿主断开当作“任务完成”。

## 恢复原会话

`start/status/poll` 返回真实 `state_path`、监听 ID 和游标。恢复时复用这个状态路径，不再次选择活动页：

```bash
avs --state "<此前返回的 state_path>" watch status
avs --state "<此前返回的 state_path>" watch poll --watch-id "<此前的 id>" --after 12
avs --ext --state "<此前返回的 state_path>" watch resume
```

路径、ID 和游标都是示意，必须使用实际返回值。`resume` 只重启不可用的采样进程，保留 ID、截止时间和事件游标；不会延长期限、换页或重放动作。已经停止、过期或会话改变的监听不能假装自动恢复。

MCP 使用 `av_watch` 的 `operation`、`state_path`、`watch_id`、`after` 等价参数。新的 MCP 会话默认隔离；需要继续操作原任务时，把同一个状态路径配置为 `AV_STATE`，不要把监听的另一个路径误当成当前操作上下文。

事件最多保留 128 条，类型包括页面变化、读取失败、恢复、停止、期限结束和目标/会话改变。文件默认权限为私有，只保存摘要、身份、时间和事件类型；不保存原始正文、表单内容、截图、URL 参数或密码。

| 状态 | 含义 |
| --- | --- |
| `starting` | 元数据已建立，采样进程正在接入 |
| `running` | 已读取原目标，继续只读采样 |
| `recovering` | 临时读取失败，继续仅重试读取 |
| `stopped` / `expired` | 已停止或期限结束 |
| `target_lost` / `target_changed` / `session_changed` | 原授权上下文不可继续，不选择替代目标 |

`worker_alive` 只说明本机进程与近期心跳状态；是否取到新页面还应检查 `last_observed_at`。不因进程存在就宣布观察有效。

## 任务验证

监听并不强制任务步骤。需要保存多步验证时，Agent 可以声明自己的任务目标、步骤数和期限：

```bash
avs --ext task start --kind workflow --authorized --goal "<用户授权的目标>" --total 2 --timeout 1800
avs --ext task checkpoint --step 1 --contains "<实际步骤文本>" --name "<当前唯一目标>" --role heading
avs --ext task status
```

checkpoint 使用新鲜语义观察，保存已验证步骤和证据摘要；目标角色、文字和数量均由实际任务决定，不照抄示例。原生控件还可断言 `checked/selected/value`；一组目标使用 `choices` 完整验证。

- `task watch` 是单次有界只读窗口，不等于独立 `watch start` 服务。
- `task complete --contains ...` 只完成通用 workflow 的声明页面断言；存在人工等待、未验证步骤或失败断言时拒绝。它不执行外部提交，也不证明未观察到的业务结果。
- `task ready` 在所有步骤和最终断言通过后保留页面，等待用户亲自完成需要人工操作的步骤。
- `task submitted --user-done --contains ...` 只在用户明确完成反馈后验证回执，绝不点击提交。
- `task cancel` 取消任务并撤销待执行确认，不关闭页面、不提交、不清空待核验的用户操作。外部中断用明确页面断言记录 `task interrupt`。

任务状态区分 active、recovering、verifying、waiting_user、awaiting_submission、completed 及明确的终止状态。CLI 退出成功、事件派发成功和页面断言通过均不等同于完整业务正确性。

## 限制与收尾

```bash
avs watch stop
avs --ext keep
```

`stop` 停止后续采样，不关闭页面；`keep/done` 会先停止当前上下文的监听，再执行所有权收尾。需要跨 Agent 回合继续观察时，只反馈 `state_path`、ID 和游标，不调用 `keep/done`；结束回合不是结束整个浏览器任务。需要等待页面变化时不要把 `keep` 当作继续监听的心跳命令。

AVS 不包含模型唤醒服务或宿主 Agent 调度接口。Agent 需要按自己环境的工具循环或明确的调度机制继续推理。系统休眠、资源冻结、进程强杀、状态损坏、遗留任务锁、过短暂的页面变化及不支持的子文档仍可能导致观察缺口；不能承诺不中断或从摘要重建丢失的正文。
