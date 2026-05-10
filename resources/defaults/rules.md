# Approval Rules

## always_review

### shell
- command: ^(?:git\s+push\b|rm\s+-rf\b|del(?:\s+|$)|rmdir(?:\s+|$))

## confirm_review

### file_edit
- tool: Write
- tool: Edit
- tool: NotebookEdit
- tool: Bash
- tool: PowerShell
