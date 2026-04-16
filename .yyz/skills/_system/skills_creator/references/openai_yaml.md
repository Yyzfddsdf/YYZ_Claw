# openai.yaml

`agents/openai.yaml` stores optional UI metadata for a skill.

It is an overlay, not the source of truth. If it exists, use it. If it does not exist, fall back to
`SKILL.md` frontmatter and folder defaults.

## Fields

- `interface.display_name`: user-facing name shown in skill lists
- `interface.short_description`: short UI blurb
- `interface.default_prompt`: example prompt that explicitly names the skill
- `interface.icon_small`: optional icon path
- `interface.icon_large`: optional larger icon path
- `interface.brand_color`: optional accent color
- `policy.allow_implicit_invocation`: whether the skill can be auto-injected

## Rules

- Quote string values.
- Keep keys unquoted.
- Keep the prompt short and action-oriented.
- Use paths relative to the skill folder.
- Keep the file small and metadata-only.

## Example

```yaml
interface:
  display_name: "PDF Processing"
  short_description: "Extract, edit, and generate PDFs"
  default_prompt: "Use $pdf-processing to inspect and edit a PDF."
policy:
  allow_implicit_invocation: true
```
