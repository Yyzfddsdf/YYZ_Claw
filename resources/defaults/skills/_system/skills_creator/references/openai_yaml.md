# openai.yaml

`agents/openai.yaml` stores optional UI metadata for a skill.

It is an overlay, not the source of truth. If it exists, use it. If it does not exist, fall back to
`SKILL.md` frontmatter and folder defaults.

Important: icons are never auto-discovered. If a skill wants an icon, `openai.yaml` must explicitly
set `icon_small` and/or `icon_large`.

## Fields

- `interface.display_name`: user-facing name shown in skill lists
- `interface.short_description`: short UI blurb
- `interface.default_prompt`: example prompt that explicitly names the skill
- `interface.icon_small`: optional icon for skill lists. SVG and PNG are supported.
- `interface.icon_large`: optional larger icon for detail views. SVG and PNG are supported.
- `interface.brand_color`: optional UI accent color for card/detail styling
- `policy.allow_implicit_invocation`: whether the skill can be auto-injected

## Rules

- Quote string values.
- Keep keys unquoted.
- Keep the prompt short and action-oriented.
- Use paths relative to the skill folder.
- Prefer `assets/icon-small.svg` and `assets/icon-large.svg`; PNG equivalents are also valid.
- `icon_small` and `icon_large` may point to `.svg` or `.png` assets inside the skill folder, or to an `http(s)` / `data:image` URL.
- `brand_color` is UI-only. Use a CSS color such as `#2563eb`; it should not describe model behavior.
- Keep the file small and metadata-only.

## Example

```yaml
interface:
  display_name: "PDF Processing"
  short_description: "Extract, edit, and generate PDFs"
  default_prompt: "Use $pdf-processing to inspect and edit a PDF."
  icon_small: "assets/icon-small.svg"
  icon_large: "assets/icon-large.svg"
  brand_color: "#dc2626"
policy:
  allow_implicit_invocation: true
```
