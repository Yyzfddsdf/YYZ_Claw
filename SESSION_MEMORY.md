# SESSION MEMORY

## 上一步实际完成了什么
- 已把工作区记忆 schema 从 `scope/appliesTo/currentFocus/stableRules/reusableKnowledge/pitfalls` 收敛成更稳定的 `purpose/surfaces/invariants/entrypoints/gotchas`
- 已把 `memory_summary` 的 tool schema、生成 prompt、运行时注入 prompt 统一改成英文表述
- 已保留无规则后处理：global/workspace 仍只做基础 `normalize + merge`，没有恢复内容筛选规则

## 下一步打算做什么
- 迁移现有 `.yyz/memory_summary.json` 到新字段，避免文件仍停留在旧 schema
- 真实触发一次 `memory_summary` refresh，观察“新 schema + 英文 prompt + 无规则后处理”下的实际生成质量
- 如果结果还是差，优先考虑给 `memory_summary` 单独换更强模型，而不是重新堆后处理规则

## 关键约束 / 风险
- 当前 summary 文件仍在工作区 `.yyz/memory_summary.json`，还没迁到总目录
- 已冻结到会话的 `memory_summary_prompt` 不会热更新；要看新 prompt 效果，需要看新会话或尚未冻结的会话
- 当前只完成了“新 workspace schema + 英文 prompt/schema + 无规则后处理”改造和代码校验，还没跑真实模型 refresh 验证最终生成质量
