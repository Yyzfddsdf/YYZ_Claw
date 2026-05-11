# Agent 使用说明

## 这份文档是干什么的

这份文档讲的是：

- 子智能体是什么
- 本地子智能体怎么定义
- 插件子智能体怎么定义
- 当前会话什么时候能看到插件子智能体
- 主智能体怎么创建子智能体
- 子智能体提示词怎么注入

---

## Agent 是什么

Agent 在这里指 **子智能体类型**。

它不是普通提示词片段，也不是 skill。

一个子智能体类型包含：

- `agentType`
- 展示名
- 描述
- 专属系统提示词

主智能体可以通过工具创建一个子智能体实例，让它在同一个主会话池里承担独立任务。

---

## 两类子智能体

当前支持两类子智能体：

1. 本地子智能体
2. 插件子智能体

### 1. 本地子智能体

本地子智能体放在用户主目录：

```text
C:\Users\HUAWEI\.yyz\subagents\<agentType>\
  definition.json
  prompt.md
```

这类子智能体是全局可用的。

只要定义存在，`subagent_types_list` 就能看到。

### 2. 插件子智能体

插件子智能体放在插件根目录：

```text
<plugin-root>/
  agents/
    novel-architect.md
```

这类子智能体不是全局可用。

它只在 **当前会话启用了对应插件** 时可见。

例如：

- 当前会话启用了 `novel-writer`
- `novel-writer/agents/novel-architect.md` 才会进入可用子智能体列表
- 当前会话没启用 `novel-writer`，这个子智能体不可见，也不能创建

---

## 本地子智能体格式

### `definition.json`

示例：

```json
{
  "agentType": "researcher",
  "displayName": "Researcher",
  "description": "负责检索、整理和归纳资料的子智能体",
  "promptFile": "prompt.md",
  "metadata": {
    "specialty": "research"
  }
}
```

字段说明：

- `agentType`
  - 子智能体类型 ID
  - 用于 `subagent_create`
- `displayName`
  - 展示名
- `description`
  - 给主智能体看的能力说明
- `promptFile`
  - 专属提示词文件
  - 默认是 `prompt.md`
- `metadata`
  - 额外信息
  - 当前常用 `specialty`

### `prompt.md`

示例：

```md
你是 Researcher 子智能体。

职责：
- 搜集事实
- 对比来源
- 输出结构化结论

不要直接修改代码，除非主智能体明确要求。
```

`prompt.md` 是子智能体真正运行时注入的完整系统提示词。

---

## 插件子智能体格式

插件子智能体使用一个 Markdown 文件定义。

推荐位置：

```text
<plugin-root>/agents/<agent-name>.md
```

示例：

```md
---
name: novel-architect
description: 专门负责长篇小说结构、连续性、章节推进和修订建议的子智能体
---

你是小说架构子智能体。

职责：
- 维护长篇小说结构
- 检查人物动机和章节连续性
- 给出下一章推进建议
- 标记伏笔、冲突和节奏问题
```

字段说明：

- `name`
  - 插件内 agent 名称
  - 会参与生成最终 `agentType`
- `description`
  - 给主智能体看的能力说明
- Markdown 正文
  - 子智能体真正运行时注入的完整系统提示词

---

## 插件子智能体的 agentType

插件子智能体的 `agentType` 由系统生成。

规则：

```text
<plugin-name>--<agent-name>
```

示例：

```text
novel-writer--novel-architect
```

注意：

- 主智能体创建插件子智能体时，应使用 `subagent_types_list` 返回的 `agentType`
- 不要手写猜测
- 如果内部 normalize 后显示为单横线，也以工具返回值为准

---

## 会话级启用规则

插件子智能体跟随 **当前会话启用的插件**。

当前会话启用状态存储在会话历史的 `plugins` 字段里。

规则：

- 本地子智能体：始终可见
- 插件子智能体：只有对应插件在当前会话启用时可见
- 子智能体会话会继承根主会话的插件启用状态
- 不存在全局插件启用状态参与子智能体可见性判断

例子：

```text
当前会话 plugins = []
可见：builder、researcher、reviewer
不可见：novel-writer--novel-architect
```

```text
当前会话 plugins = ["novel-writer"]
可见：builder、researcher、reviewer、novel-writer--novel-architect
```

---

## 主智能体怎么创建子智能体

主智能体应先调用：

```text
subagent_types_list
```

返回当前会话可用的子智能体类型。

然后调用：

```text
subagent_create
```

参数：

```json
{
  "agentType": "novel-writer--novel-architect",
  "displayName": "小说架构师",
  "initialTask": "请检查当前小说设定，并给出前三章结构建议。"
}
```

字段说明：

- `agentType`
  - 必填
  - 必须来自 `subagent_types_list`
- `displayName`
  - 可选
  - 本次创建出来的子智能体展示名
- `initialTask`
  - 可选
  - 创建后立即派发给子智能体的第一条任务

---

## 插件提示词里会暴露什么

当前会话启用插件后，插件系统提示词会列出该插件提供的子智能体。

格式类似：

```text
<subagents>
Plugin subagents are available only when this plugin is enabled in the current conversation.
Use subagent_types_list to confirm available agentType values, then create one with subagent_create.
- novel-writer--novel-architect (name: novel-architect) - 专门负责长篇小说结构、连续性、章节推进和修订建议的子智能体
</subagents>
```

这里只给主智能体看：

- `agentType`
- `name`
- `description`

不会把子智能体完整提示词塞进主智能体上下文。

---

## 子智能体提示词怎么注入

本地子智能体和插件子智能体走同一条运行链路。

区别只在 definition 来源：

- 本地子智能体
  - 来自 `.yyz/subagents/<agentType>/definition.json`
  - 提示词来自 `.yyz/subagents/<agentType>/prompt.md`
- 插件子智能体
  - 来自当前会话已启用插件的 `agents/*.md`
  - 提示词来自 Markdown 正文

后续注入链路一致：

```text
definition
→ AgentRuntimeFactory.createRuntime(definition)
→ definition.prompt
→ definitionSystemPrompt
→ buildConversationPromptMessages(definitionPrompt)
→ 注入子智能体系统提示词
```

也就是说：

- 插件提示词只告诉主智能体“有哪些插件子智能体可用”
- 插件子智能体真正运行时，才注入它自己的完整 prompt

---

## 和 skill / command / hook / MCP 的区别

### Agent 不是 skill

- `skill` 是能力说明和方法说明
- `agent` 是可以被创建出来独立工作的执行体

### Agent 不是 command

- `command` 是 `/xxx` 快捷提示词展开
- `agent` 是子智能体类型

### Agent 不是 hook

- `hook` 是生命周期事件触发
- `agent` 是由主智能体显式创建或调度

### Agent 不是 MCP

- `MCP` 是工具能力
- `agent` 是使用工具和上下文执行任务的智能体

---

## 常见问题

### Q1：为什么插件子智能体看不到？

先检查当前会话是否启用了对应插件。

插件子智能体不看全局开关，只看当前会话 `plugins`。

### Q2：为什么插件提示词里只看到 name 和 description？

这是故意的。

主智能体只需要知道有哪些子智能体可以创建，不应该提前吞掉所有子智能体完整 prompt。

完整 prompt 会在子智能体真正运行时注入。

### Q3：插件关掉后，已经创建的子智能体还能运行吗？

当前运行时会按根主会话的插件启用状态解析插件子智能体 definition。

如果根主会话关闭了对应插件，插件子智能体 definition 将不可解析。

### Q4：插件子智能体能不能跨会话全局可见？

不能。

插件子智能体是会话级能力，只属于启用了对应插件的会话。

### Q5：本地子智能体和插件子智能体能重名吗？

不推荐。

本地子智能体 `agentType` 是直接定义的。

插件子智能体 `agentType` 会带插件名前缀。

如果发生冲突，应该以 `subagent_types_list` 返回的结果为准。

---

## 当前状态

- 本地子智能体已支持
- 插件子智能体已支持
- 插件子智能体按当前会话插件启用状态过滤
- 插件提示词会列出可用插件子智能体
- 子智能体运行时会注入完整 definition prompt
- 插件子智能体不依赖全局插件启用配置
