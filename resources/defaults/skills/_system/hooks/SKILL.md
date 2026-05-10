---
name: hooks
description: Create, edit, review, and explain YYZ_Claw global hooks and plugin hooks, including hooks.json structure, event semantics, matcher rules, command stdin/stdout contracts, approval behavior, context injection, and stop continuation behavior.
version: 1.0.0
author: YYZ_Claw
license: MIT
---

# Hooks

Use this skill when the task is about:

- creating a new global hook
- creating a new plugin hook
- editing `hooks/hooks.json`
- writing a hook script
- explaining hook input or output JSON
- deciding which hook event should be used
- debugging why a hook did or did not fire
- configuring hook enable/disable state

This skill is the source of truth for **how YYZ_Claw hooks are authored and used**.

It covers both:

- global hooks
- plugin hooks

Plugin hooks and global hooks use the **same `hooks.json` format** and the **same event semantics**.

---

## 1. Where hooks live

### Global hooks

Global hook config:

- `<home>/.yyz/hooks/hooks.json`

Global hook scripts:

- `<home>/.yyz/hooks/*.ps1`
- `<home>/.yyz/hooks/*.py`
- or any other executable script

Global hook enable/disable state:

- `<home>/.yyz/config/hook-settings.json`

### Plugin hooks

Plugin hook config:

- `<plugin-root>/hooks/hooks.json`

Plugin hook scripts:

- `<plugin-root>/hooks/*.ps1`
- `<plugin-root>/hooks/*.py`
- or any other executable script

Important:

- global hook enable/disable settings only affect **global** hooks
- plugin hooks are **not** controlled by the global hook-settings file

---

## 2. Shared hooks.json format

Both global and plugin hooks use this top-level shape:

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

Each event contains an array of **matcher groups**.

Each matcher group contains a `hooks` array.

Each item inside `hooks` is one actual handler.

Example:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Treat hook_status as runtime diagnostics only."
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

## 3. Supported events

YYZ_Claw currently supports 6 hook events:

1. `SessionStart`
2. `UserPromptSubmitted`
3. `PreToolUse`
4. `PermissionRequest`
5. `PostToolUse`
6. `Stop`

### `SessionStart`

Fires:

- after the first user message of a conversation
- only once per conversation

Use it for:

- one-time context injection
- workspace conventions
- initial guardrails

### `UserPromptSubmitted`

Fires:

- after every user message

Use it for:

- per-turn context injection
- prompt-level reminders
- debugging guidance
- review-mode reminders

### `PreToolUse`

Fires:

- before tool execution

Use it for:

- destructive-command blocking
- parameter inspection
- pre-execution safety checks

### `PermissionRequest`

Fires:

- only when the tool would normally enter the system approval flow
- before the approval prompt appears

Use it for:

- auto-allowing safe commands
- auto-denying dangerous commands
- reducing the need for a human to sit in front of the machine

### `PostToolUse`

Fires:

- after tool execution
- for both success and failure

Use it for:

- additional context injection
- summarizing tool outcomes
- replacing tool results in special cases

### `Stop`

Fires:

- when the current agent turn ends
- both normal turn-end and stop-related turn-end can reach this chain

Use it for:

- end-of-turn continuation decisions
- stop diagnostics
- final pass / auto-continue behavior

Important:

- `Stop` is **not** “conversation closed”
- it is **turn end**

---

## 4. Matcher rules

Only these 3 events support `matcher`:

- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`

These events do **not** use `matcher`:

- `SessionStart`
- `UserPromptSubmitted`
- `Stop`

### What matcher matches

Matcher matches the **tool name**.

Examples:

```json
"matcher": "Bash"
```

- matches only `Bash`

```json
"matcher": "Bash|PowerShell"
```

- matches both shell tools

```json
"matcher": "Edit|Write"
```

- matches file editing and whole-file writing

```json
"matcher": "Read|Glob|Grep"
```

- matches file read and search tools

```json
"matcher": "NotebookEdit"
```

- matches notebook cell editing

### MCP matcher examples

```json
"matcher": "mcp__filesystem__read_file"
```

- matches one MCP tool
- for a global MCP, this means:
  - server: `filesystem`
  - tool: `read_file`

```json
"matcher": "mcp__filesystem__*"
```

- matches all tools under one MCP server

```json
"matcher": "mcp__novel_writer__*"
```

- matches all MCP tools under the `novel-writer` plugin

For plugin-level MCP, current YYZ_Claw implementation includes the plugin name in the namespace.

Example:

```json
"matcher": "mcp__novel_writer__hello__say_hello"
```

- plugin: `novel-writer`
- server: `hello`
- tool: `say_hello`

```json
"matcher": "mcp__*"
```

- matches all MCP tools

### Match everything

```json
"matcher": "*"
```

or

```json
"matcher": ""
```

Both are treated as match-all.

### Recommended built-in tool names

When writing matchers in YYZ_Claw, prefer these built-in names:

- `Bash`
- `PowerShell`
- `Read`
- `Edit`
- `Write`
- `Glob`
- `Grep`
- `NotebookEdit`

---

## 5. Supported handler types

Current handler types:

- `prompt`
- `command`

### `prompt`

Use `prompt` when the content is static.

Example:

```json
{
  "type": "prompt",
  "prompt": "Prefer existing local context over generic assumptions."
}
```

This creates a `hook_prompt` message and injects it into later model context.

### `command`

Use `command` when you need dynamic logic.

It receives JSON on `stdin` and writes result JSON to `stdout`.

Recommended PowerShell prelude:

```powershell
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
```

If you are doing terminal file I/O, keep it explicitly UTF-8.

---

## 6. Common command stdout shape

Use this common JSON structure:

```json
{
  "continue": true,
  "stopReason": null,
  "systemMessage": null,
  "suppressOutput": false,
  "hookSpecificOutput": {}
}
```

### Common fields

- `systemMessage`
  - becomes `hook_status`
  - shown in the UI
  - stored in history
  - not injected into later model context

- `continue`
  - mainly meaningful for `Stop`

- `stopReason`
  - mainly meaningful for `Stop`

- `suppressOutput`
  - currently parsed but not relied on in our runtime

### Context injection fields

- `hookSpecificOutput.additionalContext`
  - becomes `hook_prompt`
  - enters later model context

This is the preferred way to add dynamic context after a command hook runs.

---

## 7. Event-specific input

All command hooks receive a shared base input:

```json
{
  "session_id": "conversation id or session id",
  "transcript_path": null,
  "cwd": "working directory",
  "hook_event_name": "CurrentEventName",
  "model": "active model slug"
}
```

### `SessionStart` additional input

```json
{
  "source": "startup"
}
```

### `UserPromptSubmitted` additional input

```json
{
  "turn_id": "turn id",
  "prompt": "user prompt text"
}
```

### `PreToolUse` additional input

```json
{
  "turn_id": "turn id",
  "tool_name": "Bash",
  "tool_use_id": "tool call id",
  "tool_input": {
    "command": "git status"
  }
}
```

### `PermissionRequest` additional input

```json
{
  "turn_id": "turn id",
  "tool_name": "Bash",
  "tool_use_id": "tool call id",
  "tool_input": {
    "command": "git status"
  },
  "tool_input_description": "Bash"
}
```

### `PostToolUse` additional input

```json
{
  "turn_id": "turn id",
  "tool_name": "Bash",
  "tool_use_id": "tool call id",
  "tool_input": {
    "command": "git status"
  },
  "tool_response": {
    "cwd": "D:\\Work\\YYZ_Claw",
    "command": "git status",
    "stdout": "...",
    "stderr": "",
    "exitCode": 0
  }
}
```

### `Stop` additional input

```json
{
  "turn_id": "turn id",
  "stop_hook_active": false,
  "last_assistant_message": "latest assistant message text"
}
```

---

## 8. Event-specific output behavior

### `SessionStart`

Supported useful output:

- plain text stdout
- `hookSpecificOutput.additionalContext`
- `systemMessage`

Use it for:

- one-time injected context
- one-time status display

### `UserPromptSubmitted`

Supported useful output:

- plain text stdout
- `hookSpecificOutput.additionalContext`
- `systemMessage`

Use it for:

- per-turn guidance
- debug-mode or review-mode context

You can also block a prompt by returning:

```json
{
  "decision": "block",
  "reason": "Ask for confirmation before doing that."
}
```

### `PreToolUse`

Use this output shape:

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

Supported `permissionDecision` values in current YYZ_Claw implementation:

- `allow`
- `deny`

Behavior:

- `deny`
  - tool does not run
  - conversation does not stop
  - model receives a rejected-tool result and continues reasoning

- `allow`
  - hook fired
  - tool is allowed to continue down the normal execution chain
  - model does not receive a separate “approved” message; it simply sees the later tool flow

Important:

- the actual rejection message comes from `permissionDecisionReason`
- not from `reason`
- current YYZ_Claw implementation does **not** support legacy `decision = "block"` plus `reason` for `PreToolUse`

### `PermissionRequest`

Use this output shape:

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

Supported `behavior` values:

- `allow`
- `deny`

Current real behavior:

- `allow`
  - skips system approval
  - tool executes directly

- `deny`
  - rejects directly
  - no approval dialog
  - model receives a rejected-tool result and continues reasoning

- no `behavior`
  - falls back to the normal system approval flow

Important:

- `PermissionRequest` runs only if the tool would normally require approval
- execution order is always:
  1. `PreToolUse`
  2. approval check
  3. `PermissionRequest` if needed
- if `PreToolUse` already denies, `PermissionRequest` never runs

### `PostToolUse`

Use this output shape:

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

Important fields:

- `decision = "block"`
  - replaces the model-facing tool result
- `reason`
  - becomes the replacement tool result seen by the model
- `additionalContext`
  - becomes `hook_prompt`
  - enters later model context
- `systemMessage`
  - becomes `hook_status`

Critical caution:

- `PostToolUse block` is powerful and should be used carefully
- if you block, the model no longer sees the original tool output
- it sees only `reason`
- if `reason` is a useless fixed string such as:
  - `done`
  - `completed`
  - `executed`
  - `output reviewed`
  then the model loses the real tool information and later reasoning quality drops sharply

Rule of thumb:

- if you only want to add guidance, use `additionalContext`
- only use `decision = "block"` when you deliberately want to replace the original tool result

Also note:

- in current YYZ_Claw runtime, the **model** sees the replaced result
- the **frontend tool-result event** may still carry the original raw tool content for display/runtime purposes

### `Stop`

Use this output shape:

```json
{
  "continue": false,
  "stopReason": "The assistant has not produced a useful reply yet. Continue from the current context.",
  "systemMessage": "Stop hook requested a continuation",
  "suppressOutput": false
}
```

Behavior:

- `continue = false`
  - asks the runtime to generate a continuation prompt and run another turn
- `stopReason`
  - becomes the continuation prompt text

If you only want a normal stop status without continuation:

```json
{
  "continue": true,
  "stopReason": "",
  "systemMessage": "Stop hook executed",
  "suppressOutput": false
}
```

---

## 9. What the model actually sees

This is important.

### `hook_prompt`

These do enter later model context.

They come from:

- `prompt` handlers
- `SessionStart` plain text stdout
- `UserPromptSubmitted` plain text stdout
- `hookSpecificOutput.additionalContext`
- `Stop` continuation prompts

### `hook_status`

These do **not** enter later model context.

They come from:

- handler `statusMessage`
- command stdout `systemMessage`

They are for:

- UI display
- runtime diagnostics
- stored history

### Rejected tools

When `PreToolUse` or `PermissionRequest` denies:

- the tool does not execute
- the model receives a rejected-tool result
- the conversation continues

### Post-tool replacement

When `PostToolUse` blocks:

- the original tool result is replaced for the model
- the model reasons from `reason`

---

## 10. Practical recommended patterns

Prefer hooks that are useful and low-noise.

### Good `PreToolUse` patterns

- block `rm -rf`
- block `Remove-Item -Recurse -Force`
- block `git reset --hard`
- block `git clean -f`

### Good `PermissionRequest` patterns

- auto-allow safe read-only shell checks:
  - `git status`
  - `git diff`
  - `rg`
  - `Get-ChildItem`
  - `Get-Content`

### Good `UserPromptSubmitted` patterns

- if the user pasted an error, inject debugging guidance
- if the user explicitly asked for review, inject review-mode guidance

### Good `PostToolUse` patterns

- if shell output looks like path / command-not-found / permission failure, inject follow-up debugging context
- summarize oversized outputs only when you can preserve the important meaning

### Bad patterns

- status lines on every turn with no real value
- `PostToolUse block` with meaningless fixed replacement text
- global hooks that should really be plugin-scoped

---

## 11. Plugin hook guidance

When authoring plugin hooks:

- do not invent a different file format
- reuse the exact same `hooks/hooks.json` structure
- keep plugin-specific scripts inside the plugin `hooks/` folder
- use global hooks only for behavior that should apply everywhere

Plugin hooks are the same mechanism.

Only the scope is different.

---

## 12. Workflow

When using this skill to create or update hooks, follow this order:

1. Decide whether the hook is global or plugin-scoped.
2. Choose the correct event.
3. Decide whether `prompt` is enough.
4. Use `command` only if you need dynamic logic.
5. Use UTF-8 clean scripts.
6. Keep hooks low-noise.
7. If the task also involves plugin scaffolding, coordinate with `plugin_creator`.
8. If the task also involves plugin-level MCP, coordinate with `_system/mcp`.

---

## 13. Debug checklist

If a hook does not seem to work, check:

1. Is the event name correct?
2. Is the handler under the right event array?
3. If using `matcher`, does the actual tool name match?
4. Is the script path valid?
5. Is the script writing valid UTF-8 JSON to stdout?
6. Are you returning the right event-specific fields?
7. For `PermissionRequest`, does the tool actually require approval?
8. For plugin hooks, is the plugin enabled?
9. For global hooks, is that event disabled in `hook-settings.json`?
