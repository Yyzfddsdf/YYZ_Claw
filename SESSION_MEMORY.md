# SESSION MEMORY

## 上一步实际完成了什么
- 已按 1-7 收敛方案实现第一版：调度器消息收纳层、运行态控制台、轻量隐藏上下文解释器、工具参数预检器、中途纠偏后端插入、执行尸检、审批恢复时间线。
- 后端新增 `GET /api/chat/histories/:conversationId/runtime` 和 `POST /api/chat/histories/:conversationId/insertions`，用于运行态只读查询和把前端排队消息转为后端 orchestrator queue 插入。
- 已修复“插入消息刷新后看不到”：中途纠偏插入现在显式生成普通 `role: "user"` 消息进入调度队列，调度器不再给普通 user 插入消息附加 `orchestrator_message` 包装；队列只负责原子级延迟，落库后就是正常用户消息。
- 新增 `ToolCallPreflightService`，`ChatAgent` 主链路、子智能体和 remote 独立 `ChatAgent` 都会共享预检能力；坏 JSON arguments 会被修成 `{}` 并发出 `tool_preflight` 事件。
- 已移除无意义的 `runtime_context_trace`/隐藏上下文统计；运行态面板现在改为从 runtime API 返回的库内消息统计 `messageStats` 展示 total/user/assistant/tool/other 数量，不再展示长期为 0 的 system。
- 前端新增运行态折叠面板、调度器消息“系统动态”收纳条、等待插入栏、审批时间线和失败摘要；等待插入会通过 `messageId/queueId/clientInsertionId` 在 append event 或 history snapshot 出现后移除。
- 已验证 `npm run build:frontend` 通过，后端 ESM import 校验通过，`ToolCallPreflightService` 坏 JSON 最小校验通过。
- 已修复运行态插入粒度：foreground run 内部现在在 `assistant_content_end` / `assistant_empty_end` / `tool_results_end` 检查点强制 flush scheduler queue，插入消息会立即 append 落库并进入下一次模型请求，而不是等整轮会话结束。
- 已补齐非活跃态插入：无 active run 时插入会立即 append 落库并启动后台 run；`waiting_approval` 时插入会立即 append 落库但不会绕过审批启动新 run。
- 已修复前台 SSE 真实会话不插入的问题：`chatController` 前台 normal run / approval resume run 现在都会给 `executionContext` 注入 `flushQueuedInsertions`，checkpoint flush 会同步落库、发 `conversation_messages_appended` SSE，并写入 recorder。
- 已修复前台 checkpoint 插入刷新后顺序跑到前面的问题：flush 前会先把 recorder 当前 assistant/tool 快照 `appendMessages` 到历史，再 append 插入消息，确保 SQLite `sort_index` 顺序稳定。
- 已修正运行态 queue 统计口径：`GET /runtime` 现在只返回/统计 `status !== "consumed"` 的队列项，已消费插入不会继续让 `queueSize` 非 0。
- 已进一步收紧 scheduler 活跃队列语义：`flushReadyInsertions` 消费后会从内存 `queueByAgent` 移除 consumed 项；持久化 SQLite 仍保留 consumed 状态用于审计，session restore 只加载未 consumed 队列。
- 已按用户要求彻底移除 `tool_preflight` 运行时事件：后端工具参数预检仍会静默修复坏 arguments，但不再发 SSE，前端也不再处理该事件。
- 已用内联测试验证：assistant 内容结束后插入会触发下一次模型请求；tool 场景下顺序稳定为 assistant tool_call -> 完整 tool result -> user 插入 -> 下一次模型请求。
- 已将自动摘要记忆从 `.yyz/memory_summary.json` 改为 Markdown 存储：`.yyz/memory/global.md` 保存全局记忆，`.yyz/memory/workspaces/<workspace>-<hash>.md` 保存每个工作区记忆；运行时仍自动注入全局 + 当前工作区两层 Markdown 记忆。
- `MemorySummaryService` 保留前置 `submit_memory_evidence` 概要工具不动，后续全局/工作区两个写入阶段改为直接生成完整 Markdown 文档，不再用 `submit_global_memory` / `submit_workspace_memory` 的 JSON function schema。
- 已做旧 `.yyz/memory_summary.json` 到 Markdown 的一次性迁移兼容；`memory.sqlite` 长期图谱记忆、`memory_*` 工具和前端记忆面板没有纳入本次改动。
- 已修复压缩期间插入消息的后端漏洞：`chatController` 新增压缩活跃态判断，`manual_compression` run 或最近 run event 为 `compression_started` 且未 `compression_completed` 时，普通新消息和中途插入消息都会直接 409，不再进入 scheduler queue。
- 已调整 workspace Markdown 记忆写入提示词：鼓励 `Workspace Info`、`Architecture & Surfaces`、`Invariants & Stable Rules`、`Architectural Decisions`、`Handoff Context` 等软结构；要求 Handoff 写成长期可接手方向，易变状态加 `as last observed/currently observed`，避免一次性 TODO 和临时状态污染。
- 已在前端历史会话列表增加运行中旋转圈：主会话 `agentBusy` 显示“运行中”，子智能体会话 `agentBusy` 显示“运行中”，父会话在存在运行中子智能体时显示“子运行中”。

## 下一步打算做什么
- 做一次真实服务下的手工联调：前端排队消息点“插入”后是否进入后端 queue、在 assistant/tool 检查点是否以普通 user 消息 append 到聊天流、刷新后是否仍可见、等待插入栏是否消失。
- 真实跑一次摘要记忆刷新，确认 global/workspace Markdown 会被模型更新，且下一轮主会话 system prompt 注入内容符合预期。

## 关键约束 / 风险
- 代码仓库当前仍是脏工作区，存在用户此前未提交改动：`config/config.json`。
- 本次改动跨前后端和调度器，构建通过且内联循环测试通过，但还未做浏览器 UI 截图回归，也未做真实模型运行中的纠偏插入回归。
- 中途插入消息现在不带 `meta.kind=orchestrator_message`；前端等待插入清理主要依赖后端返回的落库 `messageId`。
- 8 上下文预算仪表和 9 会话健康度按用户要求暂不做。
- 新 Markdown 摘要记忆目前已通过后端 import、prompt 注入最小校验和 `npm run build:backend`；还未真实调用模型验证 Markdown 写入质量。
- 压缩期间禁插入修复已通过 `chatController` import 和 `npm run build:backend`，但还未在真实前端压缩窗口里手工点插入验证 409 展示。
- workspace Markdown 提示词调整已通过 `MemorySummaryService` import 和 `npm run build:backend`，还未真实调用模型观察下一次自动记忆输出。
- 历史会话列表运行中旋转圈已通过 `npm run build:frontend`，还未做浏览器视觉回归截图。
