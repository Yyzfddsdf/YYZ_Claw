---
name: skills_creator
description: Guide for creating effective skills. Use when creating or updating a skill that extends Codex with specialized knowledge, workflows, or tool integrations.
---

# Skills Creator

This skill provides guidance for creating, updating, and validating effective skills.

## About Skills

Skills are modular, self-contained folders that extend Codex's capabilities by providing
specialized knowledge, workflows, and tools. Think of them as onboarding guides for specific
domains or tasks.

### What Skills Provide

1. Specialized workflows
2. Tool integrations
3. Domain expertise
4. Bundled resources

## Core Principles

### Concise is Key

Only add context Codex really needs. Prefer short instructions and move details into bundled
references.

### Set Appropriate Degrees of Freedom

Use high freedom for flexible text guidance, medium freedom for pseudocode or scripts with
parameters, and low freedom for fragile workflows that need a specific sequence.

### Protect Validation Integrity

When revising a skill, validate the result against realistic tasks and keep the evaluation focused
on the skill behavior, not on recreating the answer from the prompt.

## Anatomy of a Skill

Every skill consists of a required `SKILL.md` file and optional bundled resources:

```text
skill-name/
├── SKILL.md
├── agents/
│   └── openai.yaml
└── Bundled Resources
    ├── scripts/
    ├── references/
    └── assets/
```

### `SKILL.md`

- Frontmatter contains the skill's identity and baseline description.
- Keep the body focused on core workflow guidance.
- Put detailed examples and reference material elsewhere when possible.
- `SKILL.md` is the authoritative definition of the skill.

### `agents/openai.yaml`

- Use this for optional UI-facing metadata and invocation hints.
- If it exists, use it.
- If it is missing, fall back to `SKILL.md` frontmatter and folder defaults.
- Do not make the skill depend on this file.
- The bundled generator is `scripts/generate_openai_yaml.py`.

### Bundled Resources

#### `scripts/`

Use scripts for deterministic or repeatedly rewritten workflows. In this repo, the scaffold and
validation helpers live here:

- `scripts/init_skill.py`
- `scripts/generate_openai_yaml.py`
- `scripts/quick_validate.py`

`scripts/init_skill.py` can generate both `SKILL.md` and `agents/openai.yaml`, but the YAML file is
optional in the skill contract.

#### `references/`

Use references for detailed docs, schemas, and examples. In this repo, `references/openai_yaml.md`
describes the UI metadata format.

#### `assets/`

Use assets for files that the skill may copy, render, or emit in final output.

## What Not To Include

Do not add extra documentation files such as README.md, CHANGELOG.md, or installation guides unless
they are directly needed by the skill.
