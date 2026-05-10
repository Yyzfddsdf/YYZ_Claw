# Hook Standard

## 目标
- 规范本框架支持的 hook 机制
- 为后续实现、测试、扩展提供统一标准
- 只定义标准，不定义具体实现细节

## 支持的 hook 事件
- `sessionStart`
- `userPromptSubmitted`
- `preToolUse`
- `postToolUse`
- `Stop`

## 事件定义

### `sessionStart`
- 触发时机：用户发出第一句话之前
- 目的：补一个运行时提醒，让系统在本次会话正式开始前注入必要上下文
- 语义：
  - 只触发一次
  - 发生在会话初始化阶段
  - 用于补充运行时提示、会话级说明、初始化约束

### `userPromptSubmitted`
- 触发时机：每一个用户问题提交后
- 目的：在每轮用户输入之后补充上下文
- 语义：
  - 每轮都会触发
  - 紧跟用户输入之后
  - 用于追加轮次级提示、状态信息、约束、上下文补充

### `preToolUse`
- 触发时机：工具执行前
- 目的：在工具调用前进行检查、补充、拦截或改写上下文
- 语义：
  - 每次工具调用前触发
  - 用于安全检查、权限判断、参数审阅、额外上下文注入

### `postToolUse`
- 触发时机：工具执行后
- 目的：在工具调用后进行结果处理、日志补充、上下文回写
- 语义：
  - 每次工具调用后触发
  - 用于记录结果、补充后续上下文、做后处理

### `Stop`
- 触发时机：任意主智能体或子智能体完成一次回复时
- 目的：在当前智能体回合结束前做收尾、清理、记录
- 语义：
  - 只在当前智能体回合结束时触发
  - 用于清理临时资源、保存日志、输出回合摘要
  - 主智能体与子智能体都走同一个 `Stop`
  - 整个会话结束对应 `SessionEnd`
  - 如果是 API 错误导致结束，走 `StopFailure`

## 标准约束
- 这 5 个事件是本框架当前支持的 hook 集合
- hook 的职责是补充上下文、控制工具执行、处理前后状态、完成会话收尾
- hook 的运行方式是触发一个 command / script；它不是纯文本注入，也不是独立业务模块
- hook 的输出可以是上下文补充，也可以是工具控制结果，具体取决于事件类型
- `sessionStart` 和 `userPromptSubmitted` 是上下文注入类
- `preToolUse` 和 `postToolUse` 是工具生命周期类
- `Stop` 是会话生命周期收尾类
- 主智能体和部分子主智能体的 `Stop` 处于同一标准层级
- hook 可以支持 MCP 作用域，但默认只作用于本插件自己带的 MCP，不向别的 MCP 透传或串用
- MCP 作用域只是一种挂载范围，不是跨插件、跨 MCP 的全局广播
- `Stop` 不算 MCP 作用域，MCP 作用域只覆盖 `preToolUse` / `postToolUse` 这一类工具生命周期点

## 作用域说明
- 全局 hook 和插件级 hook 使用同一套 JSON 结构
- 它们的差别只在于配置所在位置和作用范围
- 全局 hook 作用于更大的环境范围
- 插件级 hook 只在插件启用时生效
- 这两者不是两套协议，只是同一协议的不同挂载点

## hook JSON 格式

### 1. 配置文件格式
- hook 配置使用 JSON 文件表达
- 真实配置形态是 `hooks -> 事件名 -> matcher 组 -> hooks 数组`
- 顶层是 `hooks`
- 事件名使用 Claude Code 风格的 PascalCase，例如 `SessionStart`、`PreToolUse`、`PostToolUse`、`PermissionRequest`、`UserPromptSubmit`、`Stop`
- 一个事件下面可以有多个 matcher 组
- 每个 matcher 组里再放一个 `hooks` 数组
- `hooks` 数组里的每一项都是一个 hook handler
- 当前文档以你贴出来的这套格式为准，不再使用我之前那种扁平化写法

### 2. 标准结构
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.codex/hooks/session_start.py",
            "statusMessage": "Loading session notes"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/usr/bin/python3 \"$(git rev-parse --show-toplevel)/.codex/hooks/user_prompt_submit_data_flywheel.py\""
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/bin/python3 \"$(git rev-parse --show-toplevel)/.codex/hooks/pre_tool_use_policy.py\"",
            "statusMessage": "Checking Bash command"
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/bin/python3 \"$(git rev-parse --show-toplevel)/.codex/hooks/permission_request.py\"",
            "statusMessage": "Checking approval request"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/bin/python3 \"$(git rev-parse --show-toplevel)/.codex/hooks/post_tool_use_review.py\"",
            "statusMessage": "Reviewing Bash output"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/usr/bin/python3 \"$(git rev-parse --show-toplevel)/.codex/hooks/stop_continue.py\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### 3. 字段含义
- `matcher`：事件内的筛选条件，也就是这一组 hook 的“作用对象”
- `type`：hook handler 类型，当前示例是 `command`
- `command`：要执行的命令或脚本
- `statusMessage`：运行时展示的状态文案
- `timeout`：超时时间，单位秒
- `hooks`：同一 matcher 组下实际执行的 hook handler 列表

### 4. matcher 怎么理解
- `matcher` 不是事件名，不是命令，也不是 handler，它只是过滤器
- 一个事件先被触发，再由 `matcher` 决定这一组 hook 要不要参与
- `matcher` 只负责缩小范围，不负责决定业务逻辑
- `matcher` 可以为空、`*`、或省略，表示匹配当前事件的全部情况
- `matcher` 里用 `|` 表示多个精确值的并列匹配
- `matcher` 的匹配对象由事件决定：
  - `SessionStart`：匹配会话启动方式，比如 `startup`、`resume`、`clear`、`compact`
  - `PreToolUse`：匹配工具名，比如 `Bash`、`Edit`、`Write`
  - `PermissionRequest`：匹配工具名，比如 `Bash`
  - `PostToolUse`：匹配工具名，比如 `Bash`
  - `UserPromptSubmit` 和 `Stop`：一般不靠 matcher，默认整事件触发
- 在 MCP 作用域下，`matcher` 可以写 MCP 名字或 MCP 工具命名空间，但只针对本插件自己携带的 MCP
- 你可以把它理解成“事件内的路由条件”

### 5. 支持的 handler 类型
- `command`：执行 shell 命令
- `http`：把事件 JSON 发到 HTTP 端点
- `prompt`：把文本作为 prompt 注入
- `agent`：启动 agent 型 hook
- `mcp_tool`：调用 MCP 工具

### 6. 事件与 matcher 规则
- `SessionStart`：支持 `matcher`，常见值是 `startup`、`resume`、`clear`、`compact`
- `PreToolUse`：支持 `matcher`，通常写工具名，例如 `Bash`
- `PermissionRequest`：支持 `matcher`，通常写工具名，例如 `Bash`
- `PostToolUse`：支持 `matcher`，通常写工具名，例如 `Bash`
- `UserPromptSubmit`：不依赖 matcher，默认每次用户提交都会触发
- `Stop`：不依赖 matcher，默认会话结束时触发

### 7. 运行时输入输出
- hook handler 通过 stdin 接收事件 JSON
- hook handler 通过 stdout 和退出码返回结果
- `command` 型 hook 会根据事件接收不同输入字段
- `SessionStart` 收到会话开始信息
- `UserPromptSubmit` 收到用户 prompt
- `PreToolUse`、`PostToolUse`、`PermissionRequest` 收到 tool name 和 tool input
- `Stop` 收到收尾所需的会话上下文

## 命名约定
- 事件名使用固定名称，不再扩展其它未定义事件作为默认标准
- 后续新增 hook 事件时，必须先更新本文件

## 后续实现要求
- 所有 hook 的实现都必须遵守这里定义的触发时机和职责边界
- 任何新的执行逻辑都不得修改这些事件的语义
- 若需要扩展事件，必须先在这里补充标准，再实现代码
