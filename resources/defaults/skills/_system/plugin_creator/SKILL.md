---
name: plugin_creator
description: Create and update YYZ_Claw plugins. Use when scaffolding plugin.json, plugin assets, plugin rules, plugin skills, MCP placeholders, hooks placeholders, or explaining the YYZ_Claw plugin protocol.
version: 1.0.0
author: YYZ_Claw
license: MIT
---

# Plugin Creator

Use this skill when creating or updating a YYZ_Claw plugin under the user resource root, normally `<home>/.yyz/plugins/<plugin-name>`.

## Current Runtime Contract

YYZ_Claw plugins are independent from normal skills.

- Plugins live in `<home>/.yyz/plugins`.
- A plugin is enabled or disabled as a whole.
- Plugin skills are not individually enabled or disabled; they are visible only while the parent plugin is enabled.
- Plugin skills are not copied into `<home>/.yyz/skills`.
- Use `skill_view` with the full plugin skill key, for example `plugin:my-plugin/my-skill`.
- `.app.json` is not supported.
- Hook execution is available. Global hooks and plugin hooks use the same hooks.json format.
- When the task is specifically about authoring hook behavior, read the `_system/hooks` skill first and reuse that format instead of redefining plugin hook conventions here.
- Plugin-level MCP is available.
- When the task is specifically about authoring global or plugin-level MCP, read the `_system/mcp` skill first and reuse that format instead of redefining MCP conventions here.

## Standard Plugin Layout

```text
my-plugin/
  .plugin/
    plugin.json
  assets/
    icon.png
    logo.png
  rules.md
  .mcp.json
  hooks/
    hooks.json
  skills/
    my-skill/
      SKILL.md
      agents/
        openai.yaml
      assets/
        icon-small.png
        icon-large.png
```

## plugin.json Fields

The manifest can live at `.plugin/plugin.json`, `plugin.json`, `.claude-plugin/plugin.json`, or `.codex-plugin/plugin.json`. Prefer `.plugin/plugin.json` for YYZ_Claw plugins.

Required:

- `name`: stable plugin id. This becomes part of plugin skill keys, such as `plugin:my-plugin/my-skill`.
- `description`: required stable one-line plugin description. It is model-facing only when `interface.longDescription` is absent.

Recommended:

- `version`: plugin version. Defaults to `1.0.0` if missing.
- `author`: primary author metadata.
- `skills`: path to plugin skill root. Defaults to `./skills`.
- `rules`: plugin-level rules path or inline rule list.
- `interface.displayName`: UI display name.
- `interface.shortDescription`: UI-only short description.
- `interface.longDescription`: preferred model-facing plugin description when present.
- `interface.composerIcon`: plugin card icon path.
- `interface.logo`: plugin card icon fallback.
- `interface.brandColor`: plugin card accent color. The frontend uses it for enabled borders, active badges, toggles, and fallback icon color.

Optional placeholders:

- `mcpServers`: path to `.mcp.json`. Use the `_system/mcp` skill for the actual MCP file format and scope rules.
- `hooks`: path to `hooks/hooks.json`. Use the `_system/hooks` skill for the actual hook file format and script patterns.

## Model Context Rules

- If `interface.longDescription` exists, it is the plugin description injected into `plugin_context`.
- If `interface.longDescription` does not exist, `description` is injected as the fallback plugin description.
- `interface.shortDescription` is UI-only and must never be injected into model context.
- `author` is UI and metadata. It is not injected into model context by default.
- `rules` content is injected into `plugin_context`.
- Plugin skills are listed inside the parent plugin's `<skills>` block in `plugin_context`.

## Full plugin.json Template

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Required. A stable one-line plugin description.",
  "keywords": ["example", "local", "workflow"],
  "author": {
    "name": "Your Name",
    "email": "you@example.com",
    "url": "https://example.com/"
  },
  "skills": "./skills",
  "mcpServers": "./.mcp.json",
  "hooks": "./hooks/hooks.json",
  "rules": "./rules.md",
  "interface": {
    "displayName": "My Plugin",
    "shortDescription": "Shown in the plugin center UI only.",
    "longDescription": "Used as the plugin runtime description when present. Write the detailed model-facing purpose and boundaries here.",
    "developerName": "Your Name",
    "category": "Productivity",
    "capabilities": ["example workflow", "local files"],
    "brandColor": "#2563eb",
    "composerIcon": "./assets/icon.png",
    "logo": "./assets/logo.png",
    "screenshots": [],
    "defaultPrompt": [
      "Use this plugin to handle an example workflow."
    ]
  }
}
```

## Plugin Skill Template

`SKILL.md` is the model-facing skill body. `agents/openai.yaml` is UI metadata and invocation guidance.

```md
---
name: my-skill
description: Describe exactly when this plugin skill should be used.
version: 1.0.0
author: Your Name
license: MIT
---

# My Skill

Use this skill when the user's request matches the plugin workflow.

## Workflow

1. Inspect the request and available workspace context.
2. Load bundled references or scripts only when needed.
3. Produce or modify the requested artifact.
4. Verify the output before final response.
```

```yaml
interface:
  display_name: "My Skill"
  short_description: "Short UI-only skill description."
  default_prompt: "Use plugin:my-plugin/my-skill for this workflow."
  icon_small: "assets/icon-small.svg"
  icon_large: "assets/icon-large.svg"
  brand_color: "#2563eb"

policy:
  allow_implicit_invocation: true
```

`policy.allow_implicit_invocation` controls whether `default_prompt` may be listed in model-facing skill summaries. Do not inject the boolean itself as a model instruction.

`interface.brand_color` is used by the skills frontend for skill card accent styling.

## Plugin Skill openai.yaml Fields

`agents/openai.yaml` is optional but recommended for every plugin skill. It is an overlay for UI metadata and lightweight invocation guidance; `SKILL.md` remains the source of truth for model instructions.

`interface.display_name`:

- UI display name shown in the skills panel.
- Does not replace frontmatter `name` in model-facing skill summaries.
- Use a human-readable title, for example `"Document Repair"`.

`interface.short_description`:

- UI-only short description shown in the skills panel.
- It may be used as a fallback description in catalog display.
- Do not treat it as the full model instruction. Put real workflow instructions in `SKILL.md`.

`interface.default_prompt`:

- Example invocation text.
- It is listed in model-facing skill summaries only when `policy.allow_implicit_invocation` is not `false`.
- Keep it short and explicit. For plugin skills, include the full key when useful, for example `"Use plugin:my-plugin/my-skill for this workflow."`

`interface.icon_small`:

- Small skill icon path for compact UI.
- Path is relative to the plugin skill folder.
- Supports `.svg` and `.png`, for example `"assets/icon-small.svg"`.

`interface.icon_large`:

- Larger skill icon path for detail UI.
- Path is relative to the plugin skill folder.
- Supports `.svg` and `.png`, for example `"assets/icon-large.svg"`.

`interface.brand_color`:

- Skill card accent color.
- UI-only. It should be a CSS color such as `#2563eb`.
- It does not describe model behavior.

`policy.allow_implicit_invocation`:

- Boolean policy flag.
- Default is `true` when the field is missing.
- When `true`, `default_prompt` may be shown in model-facing skill summaries.
- When `false`, `default_prompt` is kept for UI/reference but not injected into model-facing skill summaries.
- Do not write this boolean into model prompt text as an instruction.

## Bundled Scripts

Use the bundled scripts instead of hand-writing boilerplate:

- `scripts/init_plugin.py`: creates a complete plugin skeleton.
- `scripts/init_plugin_skill.py`: adds one plugin skill to an existing plugin.

`init_plugin.py` already creates a `hooks/` directory plus `hooks/hooks.json`. When the user wants plugin hooks, scaffold the files here, then switch to the `_system/hooks` skill for the actual event definitions and scripts.

`init_plugin.py` also creates `.mcp.json`. When the user wants plugin-level MCP, scaffold the file here, then switch to the `_system/mcp` skill for the actual MCP server format, `${PLUGIN_ROOT}` usage, and scope decisions.

Example:

```powershell
python C:\Users\HUAWEI\.yyz\skills\_system\plugin_creator\scripts\init_plugin.py --name my-plugin --display-name "My Plugin" --author-name "Your Name"
python C:\Users\HUAWEI\.yyz\skills\_system\plugin_creator\scripts\init_plugin_skill.py --plugin my-plugin --name my-skill --display-name "My Skill"
```

