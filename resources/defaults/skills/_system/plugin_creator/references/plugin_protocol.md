# YYZ_Claw Plugin Protocol

This reference captures the supported plugin manifest and runtime behavior.

## Supported manifest locations

YYZ_Claw scans plugin directories under `<home>/.yyz/plugins` and accepts these manifest paths:

1. `.plugin/plugin.json`
2. `plugin.json`
3. `.claude-plugin/plugin.json`
4. `.codex-plugin/plugin.json`

Prefer `.plugin/plugin.json` when scaffolding YYZ_Claw plugins. `.codex-plugin/plugin.json` is supported only for compatibility with imported Codex plugin bundles.

## Runtime behavior

- Enabled plugins are injected through `plugin_context`.
- Plugin descriptions use `interface.longDescription` first, then `description`.
- `interface.shortDescription` is UI-only.
- Plugin rules are injected into `plugin_context`.
- Plugin skills are listed under their parent plugin and viewed with `skill_view`.
- MCP and hooks are placeholders until execution logic is added.
- `.app.json` is ignored.

## Asset behavior

- Plugin card icons use `interface.composerIcon`, then `interface.logo`.
- Plugin assets are resolved from the plugin root.
- Plugin skill icons use `agents/openai.yaml` fields `icon_small` and `icon_large`.
- Plugin skill assets are resolved from the skill root.
- Only `.svg` and `.png` image assets are supported by the current asset endpoints.
