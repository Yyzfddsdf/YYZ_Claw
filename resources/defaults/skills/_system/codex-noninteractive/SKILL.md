---
name: codex-noninteractive
description: Non-interactive Codex CLI execution, session resume by id, JSON output capture, stdin prompt feeding, and safe automation patterns. Use for scripting Codex, continuing a prior session from a session id, or building local wrappers around `codex exec` and `codex exec resume`.
---

# Codex Non-Interactive

Use this skill when the user wants to script Codex from a shell, run it without entering the TUI, continue a prior session by session id, or wrap Codex in another local tool.

## What This Covers

- One-shot non-interactive execution with `codex exec`
- Continuing an existing session with `codex exec resume`
- Reusing a known session id
- Passing prompts by argument or stdin
- Writing the final message to a file
- Using JSONL output for outer automation
- Common flags for directory, model, approval, and sandbox behavior

## Core Commands

### 1. One-shot non-interactive run

```powershell
codex exec "在当前仓库里检查未使用的前端状态并给出修复建议"
```

This creates a non-interactive run and exits after the task finishes.

### 2. Read prompt from stdin

```powershell
@'
请读取 src 目录并总结主要模块职责。
输出不超过 20 行。
'@ | codex exec -
```

Use `-` when the prompt should come from stdin.

### 3. Continue a previous session by id

```powershell
codex exec resume 9b6e7c2e-1111-2222-3333-444455556666 "继续上次未完成的修复，先跑构建再改"
```

This is the main way to续用一个已知会话 id in non-interactive mode.

### 4. Continue the latest session

```powershell
codex exec resume --last "继续处理刚才的问题"
```

Use this only when “latest session” is stable enough for the workflow.

## Session Reuse Rules

If the user wants strict continuation of prior context:

1. Prefer `codex exec resume <SESSION_ID> "..."`.
2. Only use `--last` when the latest session is definitely the right one.
3. Do not use `--ephemeral`, because ephemeral runs are not meant for later continuation.

## Useful Automation Flags

### Working directory

```powershell
codex exec -C D:\Work\YYZ_Claw "检查 backend 的 plugin 注入链路"
```

### Output final answer to a file

```powershell
codex exec -o D:\tmp\codex-last.txt "总结这个仓库的启动方式"
```

This writes the final assistant message to the target file.

### Stream machine-readable events

```powershell
codex exec --json "列出当前仓库的主要构建步骤"
```

Use `--json` when an outer script needs structured event lines.

### Ignore user config

```powershell
codex exec --ignore-user-config "只按当前命令参数运行"
```

Useful when debugging config-related behavior.

### Ignore rules

```powershell
codex exec --ignore-rules "只基于直接提示词运行"
```

Use carefully. This skips user/project exec policy rules.

## Safety / Control Flags

### Approval policy

```powershell
codex exec -a never "扫描项目并输出风险点"
```

`-a never` means command execution failures are returned directly to the model without asking.

### Sandbox selection

```powershell
codex exec -s workspace-write "修复一个前端样式问题"
```

Common values:

- `read-only`
- `workspace-write`
- `danger-full-access`

### Fully bypass approvals and sandbox

```powershell
codex exec --dangerously-bypass-approvals-and-sandbox "执行完整修复并验证"
```

Only use this in an externally trusted environment. It removes the normal safety rails.

## Images

Attach images to the initial non-interactive prompt:

```powershell
codex exec -i D:\tmp\bug.png "分析这张报错截图"
```

Resume with image:

```powershell
codex exec resume 9b6e7c2e-1111-2222-3333-444455556666 -i D:\tmp\after.png "结合新截图继续判断"
```

## Model / Profile

```powershell
codex exec -m gpt-5.5 "审查这个补丁"
codex exec -p default "检查当前工作区"
```

Use `-m` for a direct model override.
Use `-p` for a configured profile.

## Typical Wrapper Patterns

### Pattern A: one-shot local script

```powershell
$prompt = @'
检查当前仓库：
1. 跑构建
2. 找出失败原因
3. 给出最小修复
'@

$prompt | codex exec -C D:\Work\YYZ_Claw -
```

### Pattern B: continue a known thread from another tool

```powershell
$sessionId = "9b6e7c2e-1111-2222-3333-444455556666"
codex exec resume $sessionId "继续处理上次的 plugin 保存问题，先验证再修改"
```

### Pattern C: capture final answer for another program

```powershell
codex exec --json -o D:\tmp\result.txt "输出当前仓库的构建命令"
```

Outer automation can read:

- JSONL event stream from stdout
- final assistant message from `-o`

## When Not To Use This

- Do not use `codex exec` if the task needs long interactive back-and-forth inside the TUI.
- Do not use `--last` when picking the wrong session would be costly.
- Do not use `--ephemeral` if you need later continuation by session id.

## Fast Reference

### Start a non-interactive run

```powershell
codex exec "你的任务"
```

### Start from stdin

```powershell
Get-Content -Path D:\tmp\prompt.txt -Encoding UTF8 | codex exec -
```

### Continue by session id

```powershell
codex exec resume <SESSION_ID> "继续任务"
```

### Continue latest session

```powershell
codex exec resume --last "继续任务"
```

### Save final answer

```powershell
codex exec -o D:\tmp\answer.txt "你的任务"
```

### Emit JSONL

```powershell
codex exec --json "你的任务"
```
