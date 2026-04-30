这里不再直接塞本地 markdown 技能全文到 system。

研究子智能体要复用当前 session 已注入的 skills 体系：
- skills 选择来自主会话的选择性注入；全局 skills 默认来自用户主目录 `.yyz/skills`
- 不自行去当前项目根查找或创建 `.yyz/skills`
- system 里只注入技能索引（name / description）
- 需要完整技能内容时，由 agent 主动调用 `skill_view`
