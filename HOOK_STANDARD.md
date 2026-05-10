# Hook Standard (v0)

## 目标
- 规范本框架支持的 hook 机制
- 为后续实现、测试、扩展提供统一标准
- 只定义标准，不定义具体实现细节

## 支持的 hook 事件

共 **6 个事件**，按触发顺序排列：

| # | 事件 | 触发时机 | 是否支持 matcher |
|---|---|---|---|
| 1 | `SessionStart` | 会话内第一条 user 消息提交时 | 不支持 |
| 2 | `UserPromptSubmitted` | 每次 user 消息进入本轮处理时 | 不支持 |
| 3 | `PreToolUse` | 工具调用执行前 | 支持 |
| 4 | `PermissionRequest` | 工具调用进入审批流程前（仅需要审批的工具） | 支持 |
| 5 | `PostToolUse` | 工具调用后（成功/失败均触发） | 支持 |
| 6 | `Stop` | 当前 agent 回合结束时 | 不支持 |

---

## 事件定义

### SessionStart
- **触发时机**：会话内**第一条 user 消息提交时**
- **触发次数**：每个会话**仅触发一次**，不因审批恢复、重连、压缩、子流程继续而重复触发
- **用途**：会话级初始化，注入一次性上下文、状态标记
- 与 `UserPromptSubmitted` 首轮会同时命中

### UserPromptSubmitted
- **触发时机**：每次 user 消息提交后（包括首轮）
- **触发次数**：每轮一次
- **用途**：追加轮次级提示、状态信息、上下文补充

### PreToolUse
- **触发时机**：工具调用**执行前**
- **用途**：安全检查、参数审阅、上下文注入、拦截阻断
- 支持按工具名通过 matcher 过滤

### PermissionRequest
- **触发时机**：工具调用**进入审批流程前**（仅当工具需要审批时触发）
- **用途**：在审批弹窗前做预审批决策
- 支持按工具名通过 matcher 过滤
- **决策优先级**：
  - 返回 `allow` → 跳过审批流程，直接执行工具
  - 返回 `deny` → 直接拒绝，不进入审批弹窗
  - 无匹配 hook 或不返回决策 → 走正常审批流程

### PostToolUse
- **触发时机**：工具调用**执行后**（无论成功/失败均触发）
- **用途**：结果处理、日志记录、上下文回写
- 支持按工具名通过 matcher 过滤

### Stop
- **触发时机**：当前 agent 回合结束（正常结束或异常结束均触发）
- **用途**：资源清理、日志保存、回合摘要
- 不是"会话结束"——整个会话结束由上层管控，本事件仅标记单个回合收尾
- ⚠️ 与 `SessionStart` 语义不同：`SessionStart` 是一次性初始化，`Stop` 是回合级收尾，一个会话可能触发多次 `Stop`

---

## matcher 规则

### 不支持 matcher 的事件
- `SessionStart`、`UserPromptSubmitted`、`Stop`
- 若配置中写入 matcher，必须报错，不允许静默忽略

### 支持 matcher 的事件
- `PreToolUse`、`PermissionRequest`、`PostToolUse`

### matcher 匹配值

**内置工具**：精确匹配工具名
```
"Bash"         → 仅匹配 Bash 工具
"Read"         → 仅匹配 Read 工具
"Edit"         → 仅匹配 Edit 工具
```

**MCP 工具**：使用命名空间格式 `mcp__<server>__<tool>`
```
"mcp__filesystem__read_file"     → 匹配特定 MCP 服务器的特定工具
"mcp__filesystem__*"             → 匹配某 MCP 服务器的全部工具
"mcp__*"                         → 匹配所有 MCP 工具
```

**通配符与正则**
```
"*"             → 匹配全部工具（等价于省略 matcher）
"Edit|Write"    → 多个精确值并列匹配
```

### 匹配逻辑
- 一个事件可配置多个 matcher 组，按配置顺序逐个匹配
- 同一事件下多个 matcher 组都匹配时，所有匹配的组内 hook 都会执行
- matcher 为空字符串 `""`、`"*"` 或省略时，等价于匹配全部

---

## Handler 类型（v0）

### command
- 执行 shell 命令
- 通过 **stdin** 接收事件 JSON
- 通过 **stdout** 返回决策/结果（JSON 格式）
- 通过**退出码**标识执行状态

### prompt
- 将文本作为**特殊标记的用户消息**注入对话
- 注入后消息 `role = "user"`，`meta.kind = "hook_prompt"`
- 不参与模型工具调用语义，仅影响模型上下文

### 不在 v0 支持的类型
- `http`：v0 可用 `command + curl` 替代
- `mcp_tool`：MCP 属于工具调用层，不应作为生命周期指令的执行器
- `agent`：hook 职责是拦截/记录/控制，不负责触发内部 agent 流程

---

## Command 输入输出格式

### 通用输入字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `session_id` | string | 当前会话/线程的唯一标识。用于脚本关联日志、状态等外部数据 |
| `transcript_path` | string \| null | 会话 transcript 文件路径。脚本如需读取完整对话历史可用此路径；若无则为 null |
| `cwd` | string | 会话的工作目录（workspace path）。脚本如需基于目录做决策（如判断是否在项目根目录）可用此字段 |
| `hook_event_name` | string | 当前触发的 hook 事件名（如 `SessionStart`、`PreToolUse`）。脚本可通过此字段做统一入口处理多个事件 |
| `model` | string | 当前活跃的模型标识（如 `claude-sonnet-4`）。脚本可基于模型能力差异做不同策略 |

### 事件特定输入字段

**SessionStart**
```json
{
  "session_id": "...",
  "transcript_path": null,
  "cwd": "/path/to/workspace",
  "hook_event_name": "SessionStart",
  "model": "claude-sonnet-4",
  "source": "startup"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `source` | string | 会话启动来源。`startup` 表示全新会话，`resume` 表示从暂停恢复。用于区分初始化场景 |

**UserPromptSubmitted**
```json
{
  "session_id": "...",
  "transcript_path": "/path/to/transcript",
  "cwd": "/path/to/workspace",
  "hook_event_name": "UserPromptSubmitted",
  "model": "claude-sonnet-4",
  "turn_id": "turn_001",
  "prompt": "用户的完整输入内容"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `turn_id` | string | 当前轮次唯一标识。用于精确追踪本轮对话 |
| `prompt` | string | 用户本轮提交的完整原始文本。用于内容分析、关键词检测等 |

**PreToolUse**
```json
{
  "session_id": "...",
  "transcript_path": "/path/to/transcript",
  "cwd": "/path/to/workspace",
  "hook_event_name": "PreToolUse",
  "model": "claude-sonnet-4",
  "turn_id": "turn_001",
  "tool_name": "Bash",
  "tool_use_id": "tool_001",
  "tool_input": {
    "command": "ls -la"
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `turn_id` | string | 当前轮次唯一标识 |
| `tool_name` | string | 即将调用的工具名（内置工具如 `Bash`，MCP 工具如 `mcp__filesystem__read_file`） |
| `tool_use_id` | string | 本次工具调用的唯一 ID。用于关联后续 PostToolUse 的同一调用 |
| `tool_input` | JSON value | 工具调用的输入参数。`Bash` 下为 `{command: "..."}`，MCP 工具为对应参数对象 |

**PermissionRequest**
```json
{
  "session_id": "...",
  "transcript_path": "/path/to/transcript",
  "cwd": "/path/to/workspace",
  "hook_event_name": "PermissionRequest",
  "model": "claude-sonnet-4",
  "turn_id": "turn_001",
  "tool_name": "Bash",
  "tool_use_id": "tool_001",
  "tool_input": {
    "command": "rm -rf /tmp/*"
  },
  "tool_input_description": "删除临时文件"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `turn_id` | string | 当前轮次唯一标识 |
| `tool_name` | string | 待审批的工具名 |
| `tool_use_id` | string | 本次工具调用的唯一 ID |
| `tool_input` | JSON value | 工具调用输入参数 |
| `tool_input_description` | string \| null | 工具用途的人类可读描述，由框架生成（如"删除临时文件"），供脚本做审批决策参考 |

**PostToolUse**
```json
{
  "session_id": "...",
  "transcript_path": "/path/to/transcript",
  "cwd": "/path/to/workspace",
  "hook_event_name": "PostToolUse",
  "model": "claude-sonnet-4",
  "turn_id": "turn_001",
  "tool_name": "Bash",
  "tool_use_id": "tool_001",
  "tool_input": {
    "command": "ls -la"
  },
  "tool_response": "total 0\n"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `turn_id` | string | 当前轮次唯一标识 |
| `tool_name` | string | 已执行完成的工具名 |
| `tool_use_id` | string | 本次工具调用的唯一 ID，与 PreToolUse 中的 ID 一致 |
| `tool_input` | JSON value | 当时工具调用的输入参数（与 PreToolUse 传递的一致） |
| `tool_response` | JSON value | 工具的实际返回结果。MCP 工具为 MCP 响应对象，内置工具为标准化字符串 |

**Stop**
```json
{
  "session_id": "...",
  "transcript_path": "/path/to/transcript",
  "cwd": "/path/to/workspace",
  "hook_event_name": "Stop",
  "model": "claude-sonnet-4",
  "turn_id": "turn_001",
  "stop_hook_active": false,
  "last_assistant_message": "这是本回合的最终回复"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `turn_id` | string | 当前轮次唯一标识 |
| `stop_hook_active` | boolean | 本回合是否已被其他 Stop hook 的 continuation 逻辑接过。`true` 表示已有 hook 处理过 |
| `last_assistant_message` | string \| null | 本回合助手最后一条消息文本。用于生成摘要、日志等 |

---

### stdout 输出格式

所有 command hook 的 stdout 统一使用 JSON 格式。解析失败则视为纯文本（兼容模式）。

**通用输出字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| `continue` | boolean | 是否继续执行。`false` 时标记 hook 运行已停止 |
| `stopReason` | string | 停止原因记录 |
| `systemMessage` | string | 作为系统提示展示在 UI 或事件流中 |
| `suppressOutput` | boolean | 解析但暂不实现 |

**事件特定输出字段**

**SessionStart / UserPromptSubmit**

stdout 纯文本 → 作为额外开发者上下文注入对话。

stdout JSON：
```json
{
  "continue": true,
  "stopReason": null,
  "systemMessage": null,
  "suppressOutput": false,
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "加载工作空间约定后再开始编辑。"
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `hookSpecificOutput.hookEventName` | string | 固定为事件名，用于多事件脚本区分 |
| `hookSpecificOutput.additionalContext` | string | 要注入对话上下文的额外文本。框架会将其作为 `role=user, meta.kind=hook_prompt` 的消息插入 |

此外，stdout 为纯文本时，框架直接将其作为额外开发者上下文注入（等同于 `additionalContext`）。

**PreToolUse**

stdout 纯文本 → 忽略。

stdout JSON：
```json
{
  "continue": true,
  "stopReason": null,
  "systemMessage": "正在检查 Bash 命令安全性",
  "suppressOutput": false,
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "检测到危险命令：rm -rf"
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `hookSpecificOutput.hookEventName` | string | 固定为 `PreToolUse` |
| `hookSpecificOutput.permissionDecision` | string | `"allow"` 允许工具执行；`"deny"` 阻止工具执行；`"ask"` 交由用户确认（暂不支持，fail open） |
| `hookSpecificOutput.permissionDecisionReason` | string | 决策原因，用于日志记录和 UI 展示 |

**deny 的行为**：工具不被执行，但**不会停止会话**。框架会向模型反馈一条消息（如 "工具 Bash 被拒绝：危险命令"），模型收到后自行决定下一步——可以修改命令重试、换用其他工具，或直接回复用户。

**allow 的行为**：框架正常执行工具，PreToolUse 不会干预工具执行过程。

不支持字段（解析但忽略）：`continue`、`stopReason`、`suppressOutput`

**PermissionRequest**

stdout 纯文本 → 忽略。

允许时：
```json
{
  "continue": true,
  "stopReason": null,
  "systemMessage": null,
  "suppressOutput": false,
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow"
    }
  }
}
```

拒绝时：
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "仓库策略禁止执行此命令"
    }
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `hookSpecificOutput.hookEventName` | string | 固定为 `PermissionRequest` |
| `hookSpecificOutput.decision.behavior` | string | `"allow"` 跳过审批流程直接执行；`"deny"` 直接拒绝，不进入审批弹窗 |
| `hookSpecificOutput.decision.message` | string | 拒绝时的原因说明 |

不支持字段（解析但忽略）：`updatedInput`、`updatedPermissions`、`interrupt`

**PostToolUse**

stdout 纯文本 → 忽略。

stdout JSON：
```json
{
  "continue": true,
  "stopReason": null,
  "systemMessage": null,
  "suppressOutput": false,
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "decision": "block",
    "reason": "命令输出需要审核后才能继续",
    "additionalContext": "命令已更新生成文件"
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `hookSpecificOutput.hookEventName` | string | 固定为 `PostToolUse` |
| `hookSpecificOutput.decision` | string | `"block"` 阻止工具结果继续传递，用 `reason` 替换工具结果并继续模型推理 |
| `hookSpecificOutput.reason` | string | decision 为 block 时，替换工具结果的反馈文本 |
| `hookSpecificOutput.additionalContext` | string | 要注入对话上下文的额外文本，作为 `role=user, meta.kind=hook_prompt` 插入 |

不支持字段（解析但忽略）：`updatedMCPToolOutput`、`suppressOutput`

**Stop**

stdout **必须**为 JSON（纯文本无效）。

stdout JSON：
```json
{
  "continue": false,
  "stopReason": "需要更多测试通过后再继续",
  "systemMessage": null,
  "suppressOutput": false
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `continue` | boolean | `false` 时框架自动创建新的 continuation prompt，用 `stopReason` 作为 prompt 文本，实现"再来一轮" |
| `stopReason` | string | 当 `continue=false` 时，作为自动生成的 continuation prompt 文本 |

---

### 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 成功 |
| `2` | 失败（写入 stderr 的内容作为原因） |
| 其他非 `0` | 失败 |

stdout JSON 优先级高于退出码：即使退出码为 0，若 stdout JSON 中决策为 deny/block，仍按对应逻辑处理。

---

## 配置格式（JSON）

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.codex/hooks/session_start.py",
            "statusMessage": "加载会话笔记",
            "timeout": 10
          }
        ]
      }
    ],
    "UserPromptSubmitted": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "当前会话已进入第 {{turn}} 轮"
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
            "command": "python3 ~/.codex/hooks/pre_tool_check.py",
            "statusMessage": "检查 Bash 命令"
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
            "command": "python3 ~/.codex/hooks/permission_check.py",
            "statusMessage": "检查权限"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.codex/hooks/post_tool_log.py",
            "statusMessage": "记录工具结果",
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.codex/hooks/stop_handler.py",
            "statusMessage": "回合收尾",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### 结构说明
- 顶层 `hooks` → 事件名（PascalCase）→ matcher 组 → `hooks` 数组 → handler
- 无 matcher 的事件（`SessionStart`/`UserPromptSubmitted`/`Stop`）：matcher 字段必须省略，写入即报错
- 有 matcher 的事件：matcher 可省略（等价于 `*`，匹配全部）
- `timeout`：单位秒，仅 `command` 类型支持，超时后进程被终止并标记失败。默认 `600` 秒
- `statusMessage`：可选，用于前端展示和审计落库

---

## statusMessage 规范

- **用途**：运行时向前端展示状态文案、向后端审计落库
- **不入对话消息流**：不作为 `user` 或 `assistant` 角色消息
- **入库方式**：使用独立消息类型（如 `meta.kind = "hook_status"`）存储
- **前端渲染**：以状态条/提示卡片形式展示，与普通对话气泡分层

---

## 命名约定
- 事件名使用固定名称，不再扩展其它未定义事件作为默认标准
- 后续新增 hook 事件时，必须先更新本文件

## 后续实现要求
- 所有 hook 的实现都必须遵守这里定义的触发时机和职责边界
- 任何新的执行逻辑都不得修改这些事件的语义
- 若需要扩展事件，必须先在这里补充标准，再实现代码
- matcher 不支持的事件若写入 matcher，运行时必须报错并拒绝启动