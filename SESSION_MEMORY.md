# SESSION MEMORY

## 上一步实际完成了什么
- 已完成一批 agent/前后端能力：运行态插入与 queue 落库修复、工具参数预检静默修复、运行态面板与消息统计收敛、Markdown 摘要记忆迁移、压缩期间禁插入、运行中会话旋转圈、AI 互博后台运行、浏览器工具收敛与 `browser_command`、skills UI 元数据与 prompt 收敛。
- 已在共享 workplace system prompt 中加入 `你是 YYZ_CLAW，一个通用智能助手。` 和用户 home 路径；主智能体、子智能体、remote-control 都通过同一条 workplace prompt 注入。
- 已隐藏子智能体会话里的 `Developer Prompt` 前端入口；子智能体没有主会话那种可编辑 developerPrompt，真实提示词来自 agent type definition。
- 已将主 chat 的自由 `Developer Prompt` 产品入口替换为 Agent 身份系统：主会话选择 `personaId`，运行时解析 persona prompt 注入主智能体；子智能体不允许身份，remote-control 暂不接入。
- Agent 身份是纯资产驱动且单身份单目录：`.yyz/personas/<personaId>/persona.json` 是身份定义，同目录 `avatar.svg|avatar.png` 是头像；目录名就是唯一 ID，现有默认身份目录已改成身份名称，`persona.json` 不再保存 `id`；后端不会自动 seed，目录里有什么就显示什么，删了就没了；聊天入口会拒绝无效 personaId 回写，避免旧前端状态把老 slug 写回库；编辑身份名称时目录会同步 rename，并批量迁移会话和 remote config 里的旧 personaId。
- Remote Control 已复用同一套 Agent 身份：配置保存 `personaId`，运行时通过 `PersonaStore.resolvePrompt()` 注入 `personaPrompt`；remote UI 不再展示自由 developerPrompt，保存时会清空 legacy developerPrompt，runtime 也不再注入 legacy developerPrompt。
- 新增 `AGENT_IDEAS.md`，单独记录和 skills 无关的 agent 趣味化创意。

## 下一步打算做什么
- 如继续做趣味化 agent 功能，先看 `AGENT_IDEAS.md`。
- 如继续做工程验证，真实服务下手工联调：中途插入刷新可见、压缩期间插入 409、AI 互博后台轮询、浏览器 command/diagnostic 工具、Markdown 摘要记忆真实写入质量。
- 如继续完善身份系统，优先做真实服务 UI 联调：身份选择是否落库、刷新后是否保持、头像上传 SVG/PNG 是否可读、删除身份目录后是否不再显示。

## 关键约束 / 风险
- 仓库仍是脏工作区，存在用户自己的 `config/config.json` 和 `integrations/remote-control/config.json` 改动，不能回退。
- `.agents/skills/...` 在 git status 中显示大量删除，当前项目本地 `.agents` 目录缺失；不要擅自恢复。
- 之前大量跨前后端改动已通过 `npm run build:backend` / `npm run build:frontend`，但部分能力仍缺真实模型和浏览器手工回归。
- AI 互博实时性粒度是“每个完整 turn 落库后前端轮询看到”，不是 token/SSE 流式；服务进程重启时内存后台任务不会自动恢复。
- 浏览器 `browser_command` 是白名单组合命令，不是任意 JS 执行器；截图工具保存 PNG 文件，视觉判断仍走 `browser_vision`。
- 身份系统不要把“内置身份”硬编码进 JS，也不要启动时自动初始化；默认身份只能作为 `.yyz/personas/<personaId>/` 下的普通资产存在。
