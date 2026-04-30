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

- Use this for optional UI-facing metadata, brand presentation, and invocation hints.
- If it exists, use it.
- If it is missing, fall back to `SKILL.md` frontmatter and folder defaults.
- Do not make the skill depend on this file.
- The bundled generator is `scripts/generate_openai_yaml.py`.
- `icon_small` and `icon_large` are not auto-discovered. They must be explicitly specified in `openai.yaml`.
- Recommended icon paths are `assets/icon-small.svg` and `assets/icon-large.svg`; `.svg` and `.png` are both supported.
- `brand_color` is a UI accent color for skill cards/details. It is not model behavior and should not be used as an instruction.

Minimal template:

```yaml
interface:
  display_name: "Your Skill Name"
  short_description: "One-line summary of what this skill does"
  default_prompt: "Use $your-skill-name to complete this task."
  icon_small: "assets/icon-small.svg"
  icon_large: "assets/icon-large.svg"
  brand_color: "#2563eb"
policy:
  allow_implicit_invocation: true
```

### Bundled Resources

Bundled resources are lazy-loaded. Do not rely on directory discovery or hidden bundle file lists.
When adding any important bundled file, `SKILL.md` must mention it by relative path and explain
when to use it.

Examples:

- `references/schema.md`: read when validating the config format.
- `scripts/quick_validate.py`: run after editing the skill.
- `assets/template.docx`: copy when generating the deliverable.

#### `scripts/`

Use scripts for deterministic or repeatedly rewritten workflows. In this repo, the scaffold and
validation helpers live here:

- `scripts/init_skill.py`
- `scripts/generate_openai_yaml.py`
- `scripts/quick_validate.py`

`scripts/init_skill.py` can generate both `SKILL.md` and `agents/openai.yaml`, but the YAML file is
optional in the skill contract.

#### Scaffold Path Default

- Default global scope is user-home level: `--path <home>/.yyz/skills`.
- Expected default output is `<home>/.yyz/skills/<skill-name>` with no extra middle folder.
- If `YYZ_CLAW_HOME` is set, use `<YYZ_CLAW_HOME>/skills/<skill-name>` as the active global resource root.
- The project/workplace root is for code files and command execution; do not create or use a project-root `.yyz` unless the user explicitly gives a custom path.
- System skills live under `_system`: `<home>/.yyz/skills/_system/<skill-name>`.
- Only use `_system/` for built-in or platform-level skills. Do not place ordinary user/project skills under `_system/`.
- Category nesting is optional (for example `<home>/.yyz/skills/user`).
- Do not add folders like `user/` unless category nesting is intentionally required.

#### `references/`

Use references for detailed docs, schemas, and examples. In this repo, `references/openai_yaml.md`
describes the UI metadata format.

#### `assets/`

Use assets for files that the skill may copy, render, or emit in final output. For UI icons, prefer:

- `assets/icon-small.svg` or `assets/icon-small.png` for skill lists.
- `assets/icon-large.svg` or `assets/icon-large.png` for detail views.
- Always reference these icons explicitly from `agents/openai.yaml`; there is no implicit default path.

## What Not To Include

Do not add extra documentation files such as README.md, CHANGELOG.md, or installation guides unless
they are directly needed by the skill.
