# Plugin Command Standard

## 目标
- 定义 plugin 里的 `command` 是什么
- 把 `command` 明确成 `/` 快捷展开的指令提示词
- 区分 `command`、`hook`、`skill`、`agent`、`MCP` 的职责边界
- 为后续完整 plugin 和插件市场实现提供统一口径

## 定义
- `command` 是一种**可通过 `/xxx` 快捷调用的提示词指令**
- 它的核心作用是把一段固定提示词、固定说明、固定模板快速注入当前对话
- 它不是自动触发的，不像 `hook` 那样跟着生命周期事件跑
- 它不是完整推理体，也不是工具服务
- 它本质上是“快捷展开的 prompt 模板”
- 在我们项目里，`command` 作为**独立机制**存在，和 `skill` 不强绑定
- 用户在输入框里输入 `/review` 之后，宿主应自动把它替换成该 command 定义的提示词内容
- 替换后再按普通消息流程发送给模型

## 它干什么
- 把常用提示词做成一条短命令
- 让用户输入 `/xxx` 就能展开一段预设说明
- 快速补齐任务背景、约束、格式要求、输出要求
- 作为一个比手写 prompt 更快的入口

## 它不是什么
- 不是 `hook`
  - `hook` 是事件驱动
  - `command` 是手动触发展开
- 不是 `agent`
  - `agent` 是带推理和任务分解的执行体
  - `command` 只是 prompt 快捷入口
- 不是 `skill`
  - `skill` 更像能力说明和任务指南
  - `command` 更像一段快捷提示词
- 不是 `MCP`
  - `MCP` 是工具来源
  - `command` 不提供工具，只提供提示词

## 触发方式
- 用户输入 `/xxx`
- 宿主识别为命令型插件指令
- 宿主把该 command 对应的 prompt 内容直接替换到输入框或发送缓冲区
- 用户不需要再手动展开
- 替换后的内容按普通消息进入会话

## 输出形式
- command 的主要输出是 prompt 文本
- 可选输出：
  - 固定模板提示词
  - 参数化后的提示词
  - 结构化提示词片段
  - 一段输出要求
  - 一段任务约束
- 在我们项目里，command 的直接效果就是“输入替换为定义好的提示词”

## 典型使用场景
- 快速展开一段 review 提示词
- 快速展开一段 coding 规范提示词
- 快速展开一段项目背景说明
- 快速展开一段固定输出格式说明
- 快速展开一段任务模板

## 与 `hook` 的区别
- `hook` 是系统到了某个时间点自动执行
- `command` 是用户显式输入 `/xxx` 才执行
- `hook` 负责自动化
- `command` 负责快捷输入
- `hook` 更偏系统回调
- `command` 更偏手动模板展开

## 与 `skill` 的区别
- `skill` 是任务能力说明书
- `command` 是一条快捷提示词入口
- `skill` 可以很长，讲方法、流程、判断标准
- `command` 应尽量短，重在快速注入一段 prompt

## 与 `agent` 的区别
- `agent` 是独立执行体
- `command` 只是 prompt 展开入口
- `agent` 会自己推理、分解、执行
- `command` 只负责帮你把提示词快速叫出来

## 与 `MCP` 的区别
- `MCP` 提供工具
- `command` 提供提示词
- `command` 不直接访问工具
- 如果 command 展开后需要工具，那是后续对话或别的组件再去调用

## 格式说明
- Open Plugins 目前只标准化 `commands/` 这个组件类别，并没有统一规定每个 command 必须怎么落盘
- 所以下面这套是**我们项目自定义的 command 落盘约定**
- 目的是让 `/` 快捷指令有一致的文件结构，方便实现和维护

## 我们的约定格式

### 1. 目录结构
```text
commands/
  review/
    command.md
  summarize/
    command.md
  plan/
    command.md
```

### 2. 文件内容
- 每个 command 用一个独立目录
- 核心文件是 `command.md`
- `command.md` 用来存放可展开的 prompt 模板
- 必要时可以加元数据文件，比如 `command.json`

### 3. `command.md` 推荐格式
```md
---
name: review
description: 快速展开代码审查提示词
shortcut: /review
---

你现在要进行代码审查。

审查目标：
- 找 bug
- 找风险
- 找回归
- 找缺失测试

输出要求：
- 先列问题
- 再给修改建议
- 最后给简短总结
```

### 4. 字段含义
- `name`：命令名
- `description`：命令说明
- `shortcut`：快捷触发词，通常就是 `/xxx`
- 正文：展开后注入的 prompt 内容

## 参数化
- command 可以支持参数
- 参数来自用户在 `/xxx` 后面输入的内容
- 例如：
  - `/review src/a.ts`
  - `/summarize docs/design.md`
- 宿主负责把参数注入模板
- 模板里可以预留变量位置

## 参数模板示例
```md
---
name: review
shortcut: /review
---

审查下面这段内容：

{{input}}

请输出：
1. 问题
2. 风险
3. 建议
```

## 宿主层要求
- 宿主必须能发现 `commands/`
- 宿主必须能把 command 暴露成 `/xxx`
- 宿主必须能把 command 内容展开成 prompt
- 宿主必须能处理参数替换
- 宿主必须能把 command 结果插入当前会话输入或上下文

## 当前实现边界
- 我们现在已经有插件发现、skills、rules、assets、hooks 识别
- `command` 目前还在标准设计阶段
- 后续实现时要按这里定义的“`/` 快捷提示词入口”来做

## 后续实现要求
- `command` 必须是显式触发
- `command` 的主体必须以 prompt 文本为主
- `command` 不得默认自动执行
- `command` 可以带参数，但参数最终都要回到 prompt 展开
- 如果以后给 `command` 定更细文件格式，必须先补充到本文件
