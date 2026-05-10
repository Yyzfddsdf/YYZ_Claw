# Agent Standard

## 目标
- 定义 plugin 里的 `agents/` 是什么
- 明确一个 agent 应该如何落盘、如何被宿主发现、如何被调用
- 区分 agent 和 skill、command、hook、MCP 的职责边界

## 结论
- `agents` 是**专门的子智能体**
- Claude Code 里，agents 有明确标准：**Markdown 文件 + YAML frontmatter**
- 在我们框架里，**一个 agent 也定义成一个单独的 Markdown 文件**
- 这个 Markdown 文件顶部带 YAML frontmatter，下面是 agent 的行为说明
- 这和 Claude Code 的官方 subagent 格式一致，适合直接对齐实现
- 默认情况下，agent 继承全部可用工具，不额外限制
- 我们会通过**适配层**复用现有的子智能体链路，**不改文件格式规范**

## 为什么是一个 md 文件
- 可读
- 可审阅
- 可版本管理
- 可直接 diff
- 便于宿主解析
- 便于人类修改

## 目录结构
```text
agents/
  security-reviewer.md
  performance-tester.md
  docs-writer.md
```

插件里的 agents 目录就是 Open Plugins 的 `agents/`，路径在插件根目录下。

## 文件格式
```md
---
name: security-reviewer
description: 专门负责安全审查的子智能体
---

你是一个专门做安全审查的子智能体。

职责：
- 找漏洞
- 找危险调用
- 找权限边界问题
- 找敏感信息泄露

输出要求：
- 先列风险
- 再列依据
- 再列建议
```

## frontmatter 字段
- `name`：agent 名称
- `description`：这个 agent 的用途说明

## Claude Code 官方约束
- `name` 和 `description` 是必填
- `name` 必须是小写字母和连字符
- 其他 frontmatter 字段先不写进核心标准，后续如需扩展再补充
- 插件里的 agents 目录用于分发和发现子智能体
- 插件目录下的 `agents/` 采用 Claude Code 的 subagent 文件格式，也就是 Markdown + YAML frontmatter

## 正文职责
- 正文是 agent 的核心行为说明
- 正文定义：
  - 它是谁
  - 它负责什么
  - 它输出什么
  - 它不能做什么
- 正文不是一次性 prompt，而是 agent 的持续工作说明

## agent 是什么
- agent 是一个**可被调用的子智能体**
- 它有自己的角色、职责和输出风格
- 它可以被宿主自动调用，也可以被用户显式调用
- 它比 `command` 更重，比 `skill` 更独立

## agent 和 skill 的区别
- `skill` 是能力说明书，偏“怎么做”
- `agent` 是子智能体，偏“谁来做”
- `skill` 通常被加载进当前智能体上下文
- `agent` 通常以独立子智能体身份执行

## agent 和 command 的区别
- `command` 是 `/xxx` 快捷提示词入口
- `agent` 是真正的子智能体执行体
- `command` 更轻
- `agent` 更重

## agent 和 hook 的区别
- `hook` 是事件触发
- `agent` 是任务执行体
- `hook` 自动触发
- `agent` 被调用时才运行

## agent 和 MCP 的区别
- `MCP` 是工具来源
- `agent` 是会使用工具的执行体
- `agent` 可以调用 MCP 工具
- `agent` 本身不是 MCP

## 调用方式
- 宿主可以根据 agent 名称直接调用
- 宿主可以在特定任务里自动选择 agent
- 用户也可以显式指定 agent

## 典型场景
- 安全审查
- 性能分析
- 文档生成
- 测试设计
- 代码迁移
- 依赖审查

## 宿主层要求
- 宿主必须能发现 `agents/`
- 宿主必须能解析 Markdown + YAML frontmatter
- 宿主必须能把 agent 当成独立子智能体运行
- 宿主必须能把 agent 名称命名空间化，避免冲突

## 命名约定
- 文件名建议使用 kebab-case
- `name` 应与文件名保持一致或可映射

## 当前实现边界
- 我们现在的 plugin 系统还没有完整的 agent 执行链
- 目前先定义格式，不先实现复杂调度
- 后面实现时优先支持：
  - 文件发现
  - frontmatter 解析
  - 子智能体启动

## 后续实现要求
- 不要把 agent 写成 skill
- 不要把 agent 写成 command
- 不要把 agent 混进 hooks
- 如果以后细化成更严格的 schema，先更新本文件
