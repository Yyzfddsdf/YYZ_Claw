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
- 外部运行态路径已统一迁入 `.yyz` 分区：模型缓存 `.yyz/models`、配置 `.yyz/config`、历史库 `.yyz/history`、飞书配置 `.yyz/integrations/feishu`、长期记忆库 `.yyz/memory.sqlite`。根目录旧 `config/`、`History/`、`models/`、`integrations/`、`memory.sqlite` 已迁移/清理；服务需要从新路径启动。
- 资源根目录已从项目根 `.yyz` 改为跨平台用户主目录 `.yyz`：`os.homedir()/.yyz`，可用 `YYZ_CLAW_HOME` 覆盖；`PROJECT_ROOT` 仍只代表当前代码工作区/终端启动目录。启动时会执行非覆盖迁移：如果用户主目录 `.yyz` 不存在而项目根旧 `.yyz` 存在，则复制旧资源到用户主目录。
- `active-scene` / 会话农场已重做为最终收敛版：左侧导航入口恢复，背景只使用用户放到根目录后复制进模块的 `frontend/src/modules/active-scene/assets/farm-background.png`，不再拼 tile、不再用带水印/固定人物的 sample 图；小人使用 Cozy People free 派生的 6 套 GIF 角色变体（berry/blue/green/gold/violet/mint，左右各一张），按会话 ID 稳定分配到背景工位上移动/干活，点击小人跳转对应会话。`service.js` 已增加 `.gif` esbuild loader。
- `active-scene` 道具已替换为真实像素资产：`prop-broom.png` 使用 Galinda's Broom 完整扫把帧，`prop-feed.png` / `prop-harvest.png` / `prop-carry.png` 使用 Farming Set 裁成的喂食、收菜、搬运物件；CSS 红色占位物已移除。
- `active-scene` 的活跃小人位置分配已改成模块级内存槽位缓存；App 中农场面板改为常驻 mounted，只用 `visibility/pointer-events/opacity` 隐藏，不再条件卸载，因此不刷新页面时切出再进入农场不会重置 DOM/CSS 动画。超过 6 个基础工位后按 lane/ring 偏移扩展，避免完全重叠。
- `service.js` 的前端构建已改成每次先清空 `frontend/dist` 再重新生成，避免 esbuild `outfile` 模式把旧 hash 图片长期残留在 dist；当前 dist 图片只保留实际被引用的会话农场背景、角色、女巫和道具资产。
- Chat 的旧会话级 Fork 入口已移除，改为消息级操作：每条普通可复现消息可点分支图标创建只包含该消息及之前上下文的新 fork 会话；assistant 消息显示圆形箭头重跑图标，渲染时直接锚定它前一条普通 user，点击后删除该 user 后续并重新生成；user 消息显示铅笔编辑图标，发送编辑后会用编辑后的 user 作为最新起点，删除其后的 assistant/tool 并重新运行。子智能体会话、runtime hook、调度提示、压缩摘要、内部 tool image 不提供消息级分支/重跑。编辑/重跑的截断保存必须走 `replaceMessages: true`，否则后端 `mergeConversation()` 会把旧 assistant/tool 合回去。
- 新增全局右上角“工作区”抽屉，不占侧边栏导航：前端用 Monaco Editor 做文件编辑、xterm.js 做终端 UI；后端新增 `/api/workspace` 文件树/读写接口，并用 `node-pty` 接真 PTY websocket `/api/workspace/terminal`，终端固定从 `D:\Work\YYZ_Claw` 启动。编辑器已改成 VSCode 风格顶部文件 tabs，dirty 圆点显示未保存状态，保存只走 `Ctrl+S`，不再放保存按钮；终端退格/方向键由 PTY 支持，不再是普通 pipe 假终端。
- 工作区终端 tab 已支持多个独立 PTY，并加载用户 PowerShell profile，不使用 `-NoProfile`，因此 conda/base 初始化应跟本机 PowerShell 一致；终端 tab 名不再是编号，默认显示 shell 名，回车执行命令时会先按输入命令更新为 `python`/`conda`/`npm`/`node` 等进程名，后台 Win32 子进程轮询作为兜底。
- 新增开发期 Electron 壳：`npm run electron:dev` 启动 `electron/main.cjs`，主进程拉起 `service.js` 后端，主窗口加载本地服务；主窗口关闭时隐藏到托盘，不退出后端进程；托盘菜单支持显示主窗口、打开工作区、退出；工作区按钮触发 `/workspace-window` 时由 Electron `setWindowOpenHandler` 创建独立 `BrowserWindow`，不是浏览器弹窗。

## 下一步打算做什么
- 如继续做趣味化 agent 功能，先看 `AGENT_IDEAS.md`。
- 如继续做工程验证，真实服务下手工联调：中途插入刷新可见、压缩期间插入 409、AI 互博后台轮询、浏览器 command/diagnostic 工具、Markdown 摘要记忆真实写入质量。
- 如继续完善身份系统，优先做真实服务 UI 联调：身份选择是否落库、刷新后是否保持、头像上传 SVG/PNG 是否可读、删除身份目录后是否不再显示。
- 如继续完善自动化系统，优先做真实服务 UI 联调：创建模板、绑定会话、刷新后闹钟标记保持、暂停绑定后手动立即执行、调度触发后消息是否作为普通 user 落库并自动压缩。
- 如继续完善 remote，优先用真实飞书回调联调：选择目标会话、发送飞书消息后是否在 Chat 里普通 user 落库、后台运行圈是否显示、assistant 完整 content 是否自动回飞书、`send_message/send_file` 是否只在 remote 轮次暴露。
- 如继续完善外观系统，可做背景裁剪位置、遮罩强度；不要做背景虚化，不要把背景图片塞数据库，继续走 `.yyz/backgrounds` 资产目录。
- 如继续完善会话农场，不要再生成地图或拼 tile；只在现有用户背景图上调整小人坐标、尺寸、工位动作和 UI。临时下载缓存 `.yyz/tmp/cozy-assets`、`active-scene-downloads`、`itch-extern.min.js` 已清理。
- 如继续完善消息级分支/重跑，重点做真实服务手工联调：从 assistant/tool/user 消息分支后刷新仍只有截断历史；从中间 user 重跑后后续消息确实删除并重新生成；运行中/压缩中/审批中按钮不可用。
- 如继续完善工作区抽屉，优先做真实浏览器手工联调：打开多个文件的 tab 切换、dirty 圆点、`Ctrl+S` 保存、终端退格/方向键/命令输出、终端窗口 resize 是否稳定。
- 如继续做 Electron 打包，基于当前 `electron/main.cjs` 加 icon、安装包配置和后端进程退出清理；当前只是开发启动壳，未做 installer/build 配置。
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
