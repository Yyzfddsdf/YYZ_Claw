# SESSION MEMORY

## 上一步实际完成了什么
- 已新增会话级 goal 追踪功能：goal 是审批模式之外的附加字段，不再作为 `approvalMode` 第三种模式。
- 后端新增 `goal_text` 落库、`/chat/histories/:conversationId/goal` 更新接口、goal system prompt、`goal_submit` 工具。
- 有 goal 时模型必须调用 `goal_submit` 才算目标完成；如果本轮完整结束未提交，后端追加普通 user 目标追踪提醒，并在前台/后台 run 结束后自动后台续跑。
- `goal_submit` 只在会话有 goal 时对模型暴露，并从前端工具管理列表隐藏；提交完成后后端会清空当前会话 goal，避免后续普通消息继续被旧目标约束。
- 前端在原审批按钮菜单中加入目标追踪编辑区，目标文本不限长度；会话顶部显示“目标追踪”徽标。

## 下一步打算做什么
- 如继续验证 goal，开一个会话设置目标，让模型先不调用 `goal_submit`，确认本轮结束后出现 `[目标追踪]` 普通 user 提醒并后台续跑。
- 再让模型调用 `goal_submit`，确认 goal 被清空、不会继续自动追踪。
- 如果用户想要保留已完成 goal 展示，需要另加 goal 历史/完成状态字段；当前实现是完成即清空。

## 关键约束 / 风险
- goal 续跑是“完整轮次结束后追加 user 再后台续跑”，不是原子插入，不应复用中途插入队列语义。
- goal 提醒消息是正常 user 落库，会触发普通历史、SSE 和压缩逻辑。
- goal 不修改 `confirm/auto` 审批语义；工具审批仍由原审批模式决定。
