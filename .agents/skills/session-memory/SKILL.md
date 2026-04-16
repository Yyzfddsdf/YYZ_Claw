---
name: session-memory
description: Must read before starting any project or resuming work. Maintain a concise workspace memory file such as SESSION_MEMORY.md, including the last completed stage, the next step, and any key risks or blockers. This skill must be followed and executed whenever a task depends on preserved context across sessions.
---

# Session Memory

## Purpose

Use this skill to keep the resume point for a task small, current, and easy to pick up later.

## Workflow

1. Find the workspace memory file first, usually `SESSION_MEMORY.md`.
2. Read the current contents before changing them so the new entry reflects the latest state.
3. Replace the file with a concise snapshot, not a step-by-step log.
4. Record only:
   - what was just completed
   - what should happen next
   - any blocker, constraint, or risk that matters for continuation
5. Keep the wording short enough that another run can resume without rereading the whole conversation.
6. Preserve local instructions from `AGENTS.md` and write the file in UTF-8.

## Recommended Memory Shape

Use a structure like this when updating memory:

```md
# SESSION MEMORY

## 上一步实际完成了什么
- ...

## 下一步打算做什么
- ...

## 关键约束 / 风险
- ...
```

## Good Practice

- Update the memory file after finishing a meaningful stage, before long pauses, or before handing work off.
- If the memory file already exists, keep its style consistent instead of rewriting it into a different format.
- If the user gives a different memory-file convention, follow the workspace convention first.
