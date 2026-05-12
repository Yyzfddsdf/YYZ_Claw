# Hook 使用说明

## 这份文档是干什么的

这份文档是 **Hook 的使用手册**，面向实际配置和使用。

它和根目录的 [HOOK_STANDARD.md](/D:/Work/YYZ_Claw/HOOK_STANDARD.md) 不一样：

- [HOOK_STANDARD.md](/D:/Work/YYZ_Claw/HOOK_STANDARD.md) 负责定义标准和语义
- 本文档负责说明：
  - 支持哪些 hook
  - 配置文件放哪里
  - 怎么写
  - 输入输出格式是什么
  - 每种返回值会产生什么效果
  - 怎么调试

---

## Hook 是什么

Hook 是一套 **事件驱动的拦截和注入机制**。

它会在对话运行过程中的特定时机触发脚本或 prompt，然后把结果接入现有 run 链路。

当前实现里，hook 的结果会：

- 进入当前活跃会话
- 通过现有 SSE / run 事件链推到前端
- 正常入库
- 在需要时进入后续模型上下文

它不是旧的 `runtime_hook_injected` 机制。

区别很直接：

- `runtime_hook_injected` 是现有运行时提示块注入
- hook 是本文档描述的 **标准事件型 hook 机制**

---

## 当前支持的 Hook

当前支持 6 个事件：

1. `SessionStart`
2. `UserPromptSubmitted`
3. `PreToolUse`
4. `PermissionRequest`
5. `PostToolUse`
6. `Stop`

### 1. SessionStart

触发时机：

- 一个会话中的第一条用户消息提交后
- 每个会话只触发一次

适合做的事：

- 注入一次性的上下文
- 加载工作区约定
- 提醒模型遵守当前项目规则

### 2. UserPromptSubmitted

触发时机：

- 每次用户消息提交后都会触发

适合做的事：

- 每轮补充上下文
- 对当前提问做提醒
- 做 prompt 级引导

### 3. PreToolUse

触发时机：

- 工具执行前

适合做的事：

- 安全检查
- 拦截危险工具调用
- 审查命令参数

### 4. PermissionRequest

触发时机：

- 工具需要审批时
- 在弹审批前触发

适合做的事：

- 自动放行只读命令
- 自动拒绝某些危险命令
- 替代一部分人工审批

### 5. PostToolUse

触发时机：

- 工具执行后
- 成功和失败都会触发

适合做的事：

- 根据工具结果补上下文
- 阻止某些工具结果继续传给模型
- 记录审计状态

### 6. Stop

触发时机：

- 当前 agent 回合结束时
- 正常收尾和 stop 收尾都会触发

适合做的事：

- 记录收尾状态
- 决定是否让系统自动续一轮

注意：

- `Stop` 不是整个会话结束
- 它是 **当前回合结束**

---

## 配置文件放哪里

### 全局 Hook

全局 hook 配置文件位置：

- `<home>/.yyz/hooks/hooks.json`

全局 hook 脚本通常也放在同目录：

- `<home>/.yyz/hooks/*.ps1`
- 或 `*.py`
- 或其他可执行脚本

全局 command hook 支持 `.yyz` 根目录便捷访问：

- `${YYZ_ROOT}` 会在 `command` 字符串中展开为当前用户的 `.yyz` 根目录。
- `$YYZ_ROOT` 是同义写法。
- 执行脚本时会注入环境变量 `YYZ_ROOT`。
- `YYZ_ROOT` 来自运行时 `YYZ_DIR`：如果设置了 `YYZ_CLAW_HOME` 就使用该目录，否则使用当前用户主目录下的 `.yyz`。

示例：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -ExecutionPolicy Bypass -File \"${YYZ_ROOT}/hooks/pre_tool_use.ps1\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### 插件级 Hook

插件级 hook 配置文件位置：

- `<plugin-root>/hooks/hooks.json`

插件 hook 只会在对应插件启用时生效。

插件级 command hook 支持插件根目录便捷访问：

- `${CLAUDE_PLUGIN_ROOT}` 会在 `command` 字符串中展开为当前插件根目录。
- `${PLUGIN_ROOT}` 是同义别名，也会展开为当前插件根目录。
- 执行脚本时会同时注入环境变量 `CLAUDE_PLUGIN_ROOT` 和 `PLUGIN_ROOT`。
- `${YYZ_ROOT}` 在插件级 command hook 中也可用，仍指向当前用户的 `.yyz` 根目录。
- `cwd` 仍然表示当前工作区目录，不等于插件目录；需要访问插件内脚本、配置或资源时，优先使用上述占位符。

示例：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "python ${CLAUDE_PLUGIN_ROOT}/hooks/check_write.py",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

---

## 配置文件结构

顶层结构固定为：

```json
{
  "hooks": {
    "SessionStart": [],
    "UserPromptSubmitted": [],
    "PreToolUse": [],
    "PermissionRequest": [],
    "PostToolUse": [],
    "Stop": []
  }
}
```

每个事件下面是一个数组，数组里的每一项是一个 **matcher 组**。

每个 matcher 组里再放一个 `hooks` 数组，数组里的每一项是一个实际 handler。

完整示例：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Use hook_status as runtime diagnostics only."
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -ExecutionPolicy Bypass -File \"C:\\Users\\HUAWEI\\.yyz\\hooks\\pre_tool_use.ps1\"",
            "statusMessage": "Checking command tool",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

---

## matcher 怎么用

### 支持 matcher 的事件

只有这 3 个事件支持 `matcher`：

- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`

### 不支持 matcher 的事件

下面这些事件不要写 `matcher`：

- `SessionStart`
- `UserPromptSubmitted`
- `Stop`

### matcher 匹配什么

matcher 匹配的是 **工具名**。

例如：

```json
"matcher": "Bash"
```

只匹配 `Bash` 工具。

```json
"matcher": "Bash|PowerShell"
```

匹配 `Bash` 和 `PowerShell`。

```json
"matcher": "mcp__filesystem__read_file"
```

匹配某个 MCP 工具。

对于**全局 MCP**，这表示：

- server 名：`filesystem`
- tool 名：`read_file`

```json
"matcher": "mcp__filesystem__*"
```

匹配某个全局 MCP server 下的全部工具。

对于**插件级 MCP**，当前实现会把插件名并进 server 命名空间。

例如：

```json
"matcher": "mcp__novel_writer__hello__say_hello"
```

表示：

- 插件名：`novel-writer`
- server 名：`hello`
- tool 名：`say_hello`

### 常见写法

```json
"matcher": "*"
```

表示匹配全部工具。

```json
"matcher": ""
```

也会按匹配全部处理。

### 推荐 matcher 工具名

当前项目里，写 matcher 时优先使用这些内置工具名：

- `Bash`
- `PowerShell`
- `Read`
- `Edit`
- `Write`
- `Glob`
- `Grep`
- `NotebookEdit`

常见推荐写法：

- `Bash`
  - 只匹配 shell 命令执行
- `Bash|PowerShell`
  - 同时匹配两类终端命令
- `Edit|Write`
  - 同时匹配文件修改和整文件写入
- `Read|Glob|Grep`
  - 同时匹配文件读取与检索类工具
- `NotebookEdit`
  - 只匹配 Jupyter Notebook 单元修改

如果是 MCP 工具，继续用命名空间写法：

- `mcp__*`
- `mcp__filesystem__read_file`
- `mcp__filesystem__*`
- `mcp__novel_writer__*`
- `mcp__novel_writer__hello__say_hello`
- `mcp__novel_writer__hello__*`

其中：

- `mcp__*`
  - 匹配全部 MCP 工具
- `mcp__filesystem__*`
  - 匹配全局 `filesystem` MCP 下的全部工具
- `mcp__novel_writer__*`
  - 匹配插件 `novel-writer` 下的全部 MCP 工具
- `mcp__novel_writer__hello__*`
  - 匹配插件 `novel-writer` 下 `hello` 这个 MCP server 的全部工具

---

## 当前支持的 handler 类型

当前只支持两种：

- `command`
- `prompt`

### command

`command` 会执行一个命令，并通过：

- `stdin` 接收 JSON 输入
- `stdout` 返回结果

适合做：

- 安全检查
- 审批控制
- 根据工具结果动态返回 JSON

### prompt

`prompt` 不执行脚本。

它会直接注入一条特殊消息到当前会话里。

适合做：

- 直接插入固定提示
- 简单注入上下文

示例：

```json
{
  "type": "prompt",
  "prompt": "Current turn: {{turn_id}}"
}
```

---

## command Hook 的输入格式

所有 `command` hook 的输入都是 JSON，通过 `stdin` 传入。

### 通用字段

所有事件都会有这些字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `session_id` | string | 当前会话 ID |
| `transcript_path` | string \| null | transcript 路径 |
| `cwd` | string | 当前工作目录 |
| `hook_event_name` | string | 当前事件名 |
| `model` | string | 当前模型名 |

### SessionStart 输入示例

```json
{
  "session_id": "conv_xxx",
  "transcript_path": null,
  "cwd": "D:\\Work\\YYZ_Claw",
  "hook_event_name": "SessionStart",
  "model": "gpt-5",
  "source": "startup"
}
```

### UserPromptSubmitted 输入示例

```json
{
  "session_id": "conv_xxx",
  "transcript_path": null,
  "cwd": "D:\\Work\\YYZ_Claw",
  "hook_event_name": "UserPromptSubmitted",
  "model": "gpt-5",
  "turn_id": "turn_001",
  "prompt": "请检查这个 hook 流程。"
}
```

### PreToolUse 输入示例

```json
{
  "session_id": "conv_xxx",
  "transcript_path": null,
  "cwd": "D:\\Work\\YYZ_Claw",
  "hook_event_name": "PreToolUse",
  "model": "gpt-5",
  "turn_id": "turn_001",
  "tool_name": "Bash",
  "tool_use_id": "tool_001",
  "tool_input": {
    "command": "git status"
  }
}
```

### PermissionRequest 输入示例

```json
{
  "session_id": "conv_xxx",
  "transcript_path": null,
  "cwd": "D:\\Work\\YYZ_Claw",
  "hook_event_name": "PermissionRequest",
  "model": "gpt-5",
  "turn_id": "turn_001",
  "tool_name": "Bash",
  "tool_use_id": "tool_001",
  "tool_input": {
    "command": "git status"
  },
  "tool_input_description": "git status"
}
```

### PostToolUse 输入示例

```json
{
  "session_id": "conv_xxx",
  "transcript_path": null,
  "cwd": "D:\\Work\\YYZ_Claw",
  "hook_event_name": "PostToolUse",
  "model": "gpt-5",
  "turn_id": "turn_001",
  "tool_name": "Bash",
  "tool_use_id": "tool_001",
  "tool_input": {
    "command": "git status"
  },
  "tool_response": "On branch main"
}
```

### Stop 输入示例

```json
{
  "session_id": "conv_xxx",
  "transcript_path": null,
  "cwd": "D:\\Work\\YYZ_Claw",
  "hook_event_name": "Stop",
  "model": "gpt-5",
  "turn_id": "turn_001",
  "stop_hook_active": false,
  "last_assistant_message": "partial answer"
}
```

---

## command Hook 的输出格式

### 1. 纯文本 stdout

不是每个事件都支持纯文本 stdout。

#### 会被当成上下文注入的事件

- `SessionStart`
- `UserPromptSubmitted`

如果这两个事件的脚本输出纯文本，系统会把文本当成 `hook_prompt` 注入会话。

#### 其他事件

- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`
- `Stop`

这些事件的纯文本 stdout 不作为标准返回值使用。

### 2. JSON stdout

推荐所有 command hook 都返回 JSON。

通用结构：

```json
{
  "continue": true,
  "stopReason": null,
  "systemMessage": "Some status",
  "suppressOutput": false,
  "hookSpecificOutput": {}
}
```

通用字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| `continue` | boolean | 是否继续 |
| `stopReason` | string \| null | 停止原因 |
| `systemMessage` | string \| null | 状态信息，作为 `hook_status` 显示 |
| `suppressOutput` | boolean | 当前保留字段 |
| `hookSpecificOutput` | object | 事件专属返回内容 |

---

## 每个事件该怎么返回

### SessionStart / UserPromptSubmitted

推荐返回：

```json
{
  "continue": true,
  "stopReason": null,
  "systemMessage": "SessionStart hook executed",
  "suppressOutput": false,
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Current workspace: D:\\Work\\YYZ_Claw"
  }
}
```

其中：

- `systemMessage`
  - 会显示成 `hook_status`
- `hookSpecificOutput.additionalContext`
  - 会注入成 `hook_prompt`
  - 会进入后续模型上下文

### PreToolUse

推荐返回：

```json
{
  "continue": true,
  "stopReason": null,
  "systemMessage": "PreToolUse checked Bash",
  "suppressOutput": false,
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "High-risk destructive command detected."
  }
}
```

支持的 `permissionDecision`：

- `allow`
- `deny`

含义：

- `allow`
  - hook 已触发
  - 但工具继续执行
- `deny`
  - 工具不会执行
  - 会话不会停止
  - 模型会收到“工具被拒绝”的结果继续推理

注意：

- 这里真正用于拦截报错文案的是 `permissionDecisionReason`
- 不是 `reason`
- 当前实现里 `PreToolUse` 不支持旧格式 `decision = "block"` 加 `reason`
- 如果你在 `PreToolUse` 里只返回 `reason`，当前代码不会识别

### PermissionRequest

推荐返回：

```json
{
  "continue": true,
  "stopReason": null,
  "systemMessage": "PermissionRequest checked Bash",
  "suppressOutput": false,
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "message": ""
    }
  }
}
```

支持的 `behavior`：

- `allow`
- `deny`

含义：

- `allow`
  - 跳过审批
  - 工具直接执行
- `deny`
  - 直接拒绝
  - 不进入审批弹窗
- 不返回 `behavior`
  - 继续走系统原本的审批流程

注意：

- 执行顺序永远是先 `PreToolUse`，后 `PermissionRequest`
- 如果 `PreToolUse` 已经 `deny`
  - 工具会直接被拒绝
  - `PermissionRequest` 根本不会再执行

### PostToolUse

推荐返回：

```json
{
  "continue": true,
  "stopReason": null,
  "systemMessage": "PostToolUse processed Bash",
  "suppressOutput": false,
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "decision": "block",
    "reason": "Tool output should not be passed through directly.",
    "additionalContext": "A read-only inspection tool just ran."
  }
}
```

这里几个字段的作用要分清：

- `decision = "block"`
  - 阻止原始工具结果继续传给模型
- `reason`
  - 作为替代工具结果回给模型
- `additionalContext`
  - 注入成 `hook_prompt`
  - 进入后续模型上下文
- `systemMessage`
  - 显示成 `hook_status`

如果只是想补上下文，不想 block 工具结果，可以把 `decision` 留空字符串。

注意：

- `PostToolUse` 的 `decision = "block"` 要谨慎使用
- 一旦 block，模型看到的就不再是原始 `tool_result`
- 而是 `reason`
- 如果你把 `reason` 写成固定废话，例如“已执行完成”
  - 模型会丢失真正的工具输出
  - 后续推理质量会明显下降
- 想补充提醒、建议、约束时，优先用 `additionalContext`
- 只有在你明确要替换原始工具结果时，才用 `decision = "block"`

### Stop

推荐返回：

```json
{
  "continue": false,
  "stopReason": "The assistant has not produced a useful reply yet. Continue from the current context.",
  "systemMessage": "Stop hook requested a continuation",
  "suppressOutput": false
}
```

含义：

- `continue = false`
  - 当前 Stop hook 要求系统自动再续一轮
- `stopReason`
  - 作为 continuation prompt 的正文

如果只想做普通收尾，不想自动续跑：

```json
{
  "continue": true,
  "stopReason": "",
  "systemMessage": "Stop hook executed",
  "suppressOutput": false
}
```

---

## 前端里会怎么显示

当前实现中，hook 结果会变成两类特殊消息：

### 1. `hook_prompt`

来源：

- `SessionStart` / `UserPromptSubmitted` 的纯文本输出
- `additionalContext`
- `prompt` 类型 handler
- `Stop` 自动 continuation prompt

特点：

- 会显示成特殊上下文卡片
- 会进入后续模型上下文

### 2. `hook_status`

来源：

- handler 的 `statusMessage`
- JSON stdout 的 `systemMessage`

特点：

- 会显示成状态条
- 会入库
- 不会进入后续模型上下文

---

## 当前实现中真正生效的行为

为了避免误解，这里把当前代码里的真实行为写死：

### SessionStart

- 会在会话第一条用户消息时触发
- 结果会立即通过当前 run 链路推到前端

### UserPromptSubmitted

- 每轮用户消息都会触发
- 结果会立即进入当前活跃会话

### PreToolUse

- 在工具执行前触发
- `deny` 会阻止工具执行
- 模型会收到“被拒绝”的反馈继续推理

### PermissionRequest

- 只在工具本来就需要审批时触发
- `allow` 会跳过审批直接执行
- `deny` 会直接拒绝工具

### PostToolUse

- 工具执行后触发
- `additionalContext` 会注入为 `hook_prompt`
- `decision = "block"` 时，会用 `reason` 替换给模型的工具结果

### Stop

- 当前回合结束时触发
- 用户手动 stop 时也会走这条链
- `continue = false` 时，系统会自动生成 continuation prompt 再续一轮

---

## 当前已经配好的全局 Hook

当前你本机已经有一套可用的全局 hook 示例：

- [hooks.json](C:/Users/HUAWEI/.yyz/hooks/hooks.json)
- [user_prompt_submitted.ps1](C:/Users/HUAWEI/.yyz/hooks/user_prompt_submitted.ps1)
- [pre_tool_use.ps1](C:/Users/HUAWEI/.yyz/hooks/pre_tool_use.ps1)
- [permission_request.ps1](C:/Users/HUAWEI/.yyz/hooks/permission_request.ps1)
- [post_tool_use.ps1](C:/Users/HUAWEI/.yyz/hooks/post_tool_use.ps1)

它们的作用是：

- `SessionStart`
  - 注入一条一次性运行时提醒
- `UserPromptSubmitted`
  - 仅在用户像是在贴错误、异常、失败信息或显式请求 review 时，补一条更有针对性的上下文
- `PreToolUse`
  - 拦高风险破坏性 shell 命令
- `PermissionRequest`
  - 自动放行安全的只读 shell 检查命令
- `PostToolUse`
  - 在 shell 输出看起来像环境、路径或权限错误时补上下文
- `Stop`
  - 当前默认不挂全局 Stop hook

---

## 推荐写法

### 推荐 1：脚本用 ASCII 输出

在 Windows PowerShell 5.1 下，脚本如果直接输出中文，有时会遇到编码和解析问题。

建议：

- `stdout JSON` 优先用 ASCII / English
- 如果要中文，先自己充分验证

### 推荐 2：显式设置 UTF-8

PowerShell 脚本开头建议统一写：

```powershell
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
```

### 推荐 3：command hook 返回 JSON

即使某些事件支持纯文本，还是推荐返回 JSON，因为更稳定、可控。

### 推荐 4：让 `systemMessage` 和 `additionalContext` 分工明确

建议这样用：

- `systemMessage`
  - 给前端看
  - 做状态提示
- `additionalContext`
  - 给模型看
  - 真正影响后续推理

---

## 常见问题

### Q1：为什么 allow 看起来像没触发？

因为：

- `allow` 的结果是继续执行工具
- 它不像 `deny` 那样会明显报错

但它其实已经触发了。

你可以通过：

- `hook_status`
- 状态条
- 日志

来确认它已执行。

### Q2：`reason` 和 `permissionDecisionReason` 有什么区别？

- `permissionDecisionReason`
  - 用在 `PreToolUse`
  - 表示为什么允许/拒绝工具

- `reason`
  - 用在 `PostToolUse`
  - 当 `decision = "block"` 时，用来替代工具结果回给模型

### Q3：`deny` 会不会直接停会话？

不会。

`deny` 拒绝的是 **这次工具调用**，不是整个会话。

模型会收到被拒绝的结果，然后继续决定下一步。

### Q4：hook 的结果会不会只入库不显示？

不会。

当前实现是走现有 run 链路：

- 活跃态会话里可见
- 正常入库
- 不是旁路写库

### Q5：所有 hook 都会进入模型上下文吗？

不会。

会进入模型上下文的是：

- `hook_prompt`

不会进入模型上下文的是：

- `hook_status`

---

## 最小可用示例

### 只做一条 SessionStart 注入

`hooks.json`

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "This workspace prefers reusing existing run chains."
          }
        ]
      }
    ]
  }
}
```

### 拦截 Bash 危险命令

`hooks.json`

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -ExecutionPolicy Bypass -File \"C:\\Users\\HUAWEI\\.yyz\\hooks\\pre_tool_use.ps1\"",
            "statusMessage": "Checking Bash command",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### 工具后补一条上下文

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -ExecutionPolicy Bypass -File \"C:\\Users\\HUAWEI\\.yyz\\hooks\\post_tool_use.ps1\"",
            "statusMessage": "Processing tool result",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

---

## 调试建议

### 1. 先单独跑脚本

先确认脚本本身能吃 JSON stdin 并输出 JSON stdout。

### 2. 再看前端是否出现 `hook_status`

如果 `statusMessage` 或 `systemMessage` 生效了，说明 hook 已经跑到了。

### 3. 再看是否出现 `hook_prompt`

如果出现 `hook_prompt` 卡片，说明上下文注入链打通了。

### 4. 最后再验证模型行为

例如：

- `PreToolUse deny` 是否阻止了工具
- `PermissionRequest allow` 是否跳过审批
- `PostToolUse additionalContext` 是否影响了下一步推理

---
