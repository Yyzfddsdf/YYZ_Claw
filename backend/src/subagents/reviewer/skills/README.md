这里不再直接塞本地 markdown 技能全文到 system。

审查子智能体要复用当前 session 的 `.yyz/skills` 体系：
- skills 选择来自主会话的全局选择性注入
- system 里只注入技能索引（name / description）
- 需要完整技能内容时，由 agent 主动调用 `skill_view`
