# SESSION MEMORY

## 上一步实际完成了什么
- 已完成一批 agent/前后端能力：运行态插入与 queue 落库修复、工具参数预检静默修复、运行态面板与消息统计收敛、Markdown 摘要记忆迁移、压缩期间禁插入、运行中会话旋转圈、AI 互博后台运行、浏览器工具收敛与 `browser_command`、skills UI 元数据与 prompt 收敛。
- 已在共享 workplace system prompt 中加入 `你是 YYZ_CLAW，一个通用智能助手。` 和用户 home 路径；主智能体、子智能体、remote-control 都通过同一条 workplace prompt 注入。
- 已隐藏子智能体会话里的 `Developer Prompt` 前端入口；子智能体没有主会话那种可编辑 developerPrompt，真实提示词来自 agent type definition。
- 已将主 chat 的自由 `Developer Prompt` 产品入口替换为 Agent 身份系统：主会话选择 `personaId`，运行时解析 persona prompt 注入主智能体；子智能体不允许身份，remote-control 暂不接入。
- Agent 身份是纯资产驱动且单身份单目录：`.yyz/personas/<personaId>/persona.json` 是身份定义，同目录 `avatar.svg|avatar.png` 是头像；目录名就是唯一 ID，现有默认身份目录已改成身份名称，`persona.json` 不再保存 `id`；后端不会自动 seed，目录里有什么就显示什么，删了就没了；聊天入口会拒绝无效 personaId 回写，避免旧前端状态把老 slug 写回库；编辑身份名称时目录会同步 rename，并批量迁移会话和 remote config 里的旧 personaId。
- Remote Control 已复用同一套 Agent 身份：配置保存 `personaId`，运行时通过 `PersonaStore.resolvePrompt()` 注入 `personaPrompt`；remote UI 不再展示自由 developerPrompt，保存时会清空 legacy developerPrompt，runtime 也不再注入 legacy developerPrompt。
- 新增 `AGENT_IDEAS.md`，单独记录和 skills 无关的 agent 趣味化创意。
- 自动化已翻新为“任务模板 + 会话绑定”：模板只保存名称和自动发送的 user prompt；绑定保存 `conversationId`、`timeOfDay`、`enabled`、运行状态和下次执行时间。一个模板可绑定多个会话，一个会话最多一个绑定。旧的独立 automation-chat / automation histories 前端入口和 API 已移除。
- 自动化触发会向已绑定普通会话追加正常 `role: "user"` 消息，再走 `runConversationById`，因此会复用普通 chat 的压缩、运行、落库和 SSE 广播路径；消息 meta 只标识自动化来源，不改变消息角色。
- Chat 历史列表会对已绑定自动化的普通会话显示闹钟标记；当前会话头部新增“自动化”按钮，可直接选择模板、时间、启停、绑定/解绑；自动化面板负责管理模板并预览所有已绑定会话，点击会话直接跳回普通 Chat 详情页。
- 前端已加入全局定制提醒系统：`GlobalFeedbackHost` + `shared/feedback.js`。所有原生 `window.alert/confirm` 调用已替换为 `notify()` toast 或 `confirmAction()` 自定义确认弹层，避免浏览器顶部原生提醒条。
- 默认 Agent 身份 `YYZ_CLAW 默认` 现在有启动自愈：`PersonaStore.ensureDefaultPersona()` 会在服务启动时补回 `.yyz/personas/YYZ_CLAW 默认/persona.json` 和 `avatar.svg`；其它身份仍然是普通资产，删了不会自动恢复。
- Remote Control 已合并回普通 Chat：remote 配置只保存 `activeProviderKey` 和唯一 `targetConversationId`，IM 入站消息会追加为绑定会话的普通 `role: "user"` 消息，不写 `kind`，随后后台走 `ConversationAgentRuntimeService.runConversationById()`，因此复用普通压缩、落库、身份、skills、SSE 广播与审批流程。
- Remote 入站消息内容首行会追加轻量标识 `[远程消息]`，让模型知道来源；不要加复杂 `id/chat_id/provider` 结构到消息内容里，通用回发路由仍只放在运行态 `executionContext.remoteContext`。
- Remote 的来源信息只存在本轮 `executionContext.remoteContext`，不进消息内容和持久化消息 meta；assistant 每次 `assistant_message_end` 会按入站 `replyTarget` 自动回发来源方。
- `send_message` / `send_file` 已移动到普通 `backend/src/services/tools/`，但通过工具级 `isAvailable(executionContext)` 只在 remote 来源轮次暴露；tool schema 不再包含 `target/messageId/chatId/userId`，模型只能决定发送内容，不能决定收件人。
- 已删除 backend 下 remote 独立 history、remote hook、remote runtime hook、remote 专属 tools 和 remote recorder；保留 remote API/config/provider/ingest/runtime 作为通用 IM 通道层。`REMOTE_CONTROL_CONFIG_FILE` 改到 `config/remote-control.json`，不再读取项目根 `integrations/remote-control/config.json`。
- Remote 前端面板的 Provider 和“远程接收会话”已替换为定制 `RemoteSelect` 下拉，不再使用原生 select；会话菜单显示标题、预览和最近时间，Provider 菜单显示状态 badge。
- 新增“界面背景”板块：背景资产保存在 `.yyz/backgrounds`，支持 png/jpg/jpeg/webp/gif/avif/svg 上传、选择、删除；当前配置写入 `.yyz/backgrounds/settings.json`。启用背景后背景图保持清晰不虚化，App 外壳和各模块卡片/表单/弹层通过同一个 `--app-surface-opacity` 透明度显示背景；已下载 `coastal-night.jpg`、`forest-light.jpg`、`soft-valley.jpg` 三张普通内置资产。

## 下一步打算做什么
- 如继续做趣味化 agent 功能，先看 `AGENT_IDEAS.md`。
- 如继续做工程验证，真实服务下手工联调：中途插入刷新可见、压缩期间插入 409、AI 互博后台轮询、浏览器 command/diagnostic 工具、Markdown 摘要记忆真实写入质量。
- 如继续完善身份系统，优先做真实服务 UI 联调：身份选择是否落库、刷新后是否保持、头像上传 SVG/PNG 是否可读、删除身份目录后是否不再显示。
- 如继续完善自动化系统，优先做真实服务 UI 联调：创建模板、绑定会话、刷新后闹钟标记保持、暂停绑定后手动立即执行、调度触发后消息是否作为普通 user 落库并自动压缩。
- 如继续完善 remote，优先用真实飞书回调联调：选择目标会话、发送飞书消息后是否在 Chat 里普通 user 落库、后台运行圈是否显示、assistant 完整 content 是否自动回飞书、`send_message/send_file` 是否只在 remote 轮次暴露。
- 如继续完善外观系统，可做背景裁剪位置、遮罩强度；不要做背景虚化，不要把背景图片塞数据库，继续走 `.yyz/backgrounds` 资产目录。
- 如新增前端操作提醒，不要再使用 `window.alert/confirm/prompt`；普通提示用 `notify({ tone, title, message })`，危险确认用 `await confirmAction({ title, message, confirmLabel })`。

## 关键约束 / 风险
- 仓库仍是脏工作区，存在用户自己的 `config/config.json` 和 `integrations/remote-control/config.json` 改动，不能回退。
- `.agents/skills/...` 在 git status 中显示大量删除，当前项目本地 `.agents` 目录缺失；不要擅自恢复。
- 之前大量跨前后端改动已通过 `npm run build:backend` / `npm run build:frontend`，但部分能力仍缺真实模型和浏览器手工回归。
- AI 互博实时性粒度是“每个完整 turn 落库后前端轮询看到”，不是 token/SSE 流式；服务进程重启时内存后台任务不会自动恢复。
- 浏览器 `browser_command` 是白名单组合命令，不是任意 JS 执行器；截图工具保存 PNG 文件，视觉判断仍走 `browser_vision`。
- 除默认 `YYZ_CLAW 默认` 外，身份系统不要把其它“内置身份”硬编码进 JS，也不要启动时自动初始化；默认身份允许启动自愈，其它身份只能作为 `.yyz/personas/<personaId>/` 下的普通资产存在。
- 自动化已不兼容旧 `automation_tasks` 单表；`SqliteAutomationTaskStore.initialize()` 会删除旧表并使用 `automation_templates` / `automation_bindings`。不要再恢复旧的 `conversationId` 写在 task 上的模型。
- Remote 不再兼容旧独立 remote history/turn 模型；不要再恢复 `RemoteControlHistoryStore`、`remoteRuntimeHooks` 或 `backend/src/integrations/remote-control/tools`。后续接 Telegram/QQ/微信时只做平台入站解析为统一 `replyTarget`，出站实现统一 `sendMessage({ target, text, file, audio })`。
