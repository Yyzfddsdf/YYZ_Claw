# Approval Rules

## always_review

### shell
- command: ^(?:git\s+push\b|rm\s+-rf\b|del(?:\s+|$)|rmdir(?:\s+|$))

## confirm_review

### file_edit
- tool: create_file
- tool: delete_text
- tool: insert_text
- tool: replace_text
- tool: run_terminal

### patch_edit
- tool: apply_patch
