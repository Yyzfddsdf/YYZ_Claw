---
name: hooks
description: Create and maintain YYZ_Claw global hooks and plugin hooks using the shared hooks.json format, command hook stdin/stdout contracts, and practical patterns for safety, approvals, context injection, and stop handling.
version: 1.0.0
author: YYZ_Claw
license: MIT
---

# Hooks

Use this skill when creating, editing, or reviewing YYZ_Claw hooks.

This skill covers both:

- global hooks in `<home>/.yyz/hooks/hooks.json`
- plugin hooks in `<plugin-root>/hooks/hooks.json`

Plugin hooks and global hooks use the same JSON format and the same event semantics.

## When to use this skill

Use it when the user asks to:

- add or edit a global hook
- add or edit a plugin hook
- create a hook script
- explain hook input/output JSON
- wire hook settings with useful defaults

## Hook file locations

### Global

- config: `<home>/.yyz/hooks/hooks.json`
- scripts: `<home>/.yyz/hooks/*.ps1` or `*.py`
- enable / disable state: `<home>/.yyz/config/hook-settings.json`

### Plugin

- config: `<plugin-root>/hooks/hooks.json`
- scripts: `<plugin-root>/hooks/*.ps1` or `*.py`

## Shared format

Both global and plugin hooks use:

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

## Supported events

- `SessionStart`
- `UserPromptSubmitted`
- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`
- `Stop`

Only these three support `matcher`:

- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`

## Handler types

### `prompt`

Use for fixed context injection.

```json
{
  "type": "prompt",
  "prompt": "This workspace prefers existing local context over generic assumptions."
}
```

### `command`

Use for dynamic logic.

- input: JSON from `stdin`
- output: JSON to `stdout`
- encoding: always UTF-8

Recommended PowerShell prelude:

```powershell
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
```

## Command output shape

Use this common structure:

```json
{
  "continue": true,
  "stopReason": null,
  "systemMessage": null,
  "suppressOutput": false,
  "hookSpecificOutput": {}
}
```

Important fields:

- `systemMessage`
  - becomes a `hook_status`
  - shown in the UI
  - not injected into later model context

- `hookSpecificOutput.additionalContext`
  - becomes a `hook_prompt`
  - injected into later model context

- `hookSpecificOutput.permissionDecision`
  - used by `PreToolUse`
  - `allow` or `deny`

- `hookSpecificOutput.decision.behavior`
  - used by `PermissionRequest`
  - `allow` or `deny`

- `hookSpecificOutput.decision = "block"`
  - used by `PostToolUse`

- `continue = false` plus `stopReason`
  - used by `Stop`
  - asks the runtime to continue with a generated continuation prompt

## Practical guidance

Prefer hooks that are genuinely useful and low-noise:

- `PreToolUse`
  - block destructive shell commands
- `PermissionRequest`
  - auto-approve safe read-only shell inspection commands
- `UserPromptSubmitted`
  - inject debugging guidance when the user pasted an error
- `PostToolUse`
  - inject environment guidance when shell output shows command-not-found or path issues

Avoid noisy hooks that add status lines on every turn unless the user explicitly wants that.

## Plugin hook guidance

When creating plugin hooks:

- do not invent a different file format
- reuse the exact same hooks.json structure
- keep hook scripts inside the plugin `hooks/` folder when the behavior belongs only to that plugin
- keep global hooks in `<home>/.yyz/hooks/` when the behavior should apply everywhere

## Workflow

1. Identify whether the request is for a global hook or a plugin hook.
2. Reuse the shared hooks.json structure.
3. Prefer `prompt` when static context is enough.
4. Use `command` only when dynamic logic is necessary.
5. Keep scripts UTF-8 clean.
6. Keep default hooks useful and low-noise.
7. If the request involves plugin scaffolding, coordinate with the `plugin_creator` skill instead of redefining the plugin layout here.
