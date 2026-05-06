#!/usr/bin/env python3
"""Add a plugin skill to an existing YYZ_Claw plugin."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def slugify(value: str) -> str:
    text = "".join(ch.lower() if ch.isalnum() else "-" for ch in value.strip())
    while "--" in text:
        text = text.replace("--", "-")
    return text.strip("-") or "my-skill"


def yyz_root() -> Path:
    return Path(os.environ.get("YYZ_CLAW_HOME") or Path.home() / ".yyz")


def write_text(path: Path, content: str, force: bool) -> None:
    if path.exists() and not force:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def find_plugin_root(args: argparse.Namespace) -> Path:
    if args.plugin_root:
        return Path(args.plugin_root).expanduser().resolve()
    if args.plugin:
        return (yyz_root() / "plugins" / slugify(args.plugin)).resolve()
    raise SystemExit("Either --plugin-root or --plugin is required.")


def read_plugin_name(plugin_root: Path) -> str:
    for relative in [".plugin/plugin.json", "plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]:
        manifest_path = plugin_root / relative
        if manifest_path.exists():
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            return str(data.get("name") or plugin_root.name)
    return plugin_root.name


def svg_icon(label: str, color: str, size: int) -> str:
    initial = (label.strip()[:1] or "S").upper()
    font_size = max(18, size // 2)
    radius = max(8, size // 6)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}" role="img" aria-label="{label}">
  <rect width="{size}" height="{size}" rx="{radius}" fill="{color}"/>
  <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="Arial, sans-serif" font-size="{font_size}" font-weight="700" fill="#ffffff">{initial}</text>
</svg>
"""


def main() -> None:
    parser = argparse.ArgumentParser(description="Add a skill to a YYZ_Claw plugin.")
    parser.add_argument("--plugin", default="", help="Plugin id under <home>/.yyz/plugins.")
    parser.add_argument("--plugin-root", default="", help="Explicit plugin root path.")
    parser.add_argument("--name", required=True, help="Plugin skill id.")
    parser.add_argument("--display-name", default="")
    parser.add_argument("--description", default="")
    parser.add_argument("--version", default="1.0.0")
    parser.add_argument("--author-name", default="Your Name")
    parser.add_argument("--license", default="MIT")
    parser.add_argument("--brand-color", default="#2563eb")
    parser.add_argument("--default-prompt", default="")
    parser.add_argument("--allow-implicit-invocation", default="true", choices=["true", "false"])
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    plugin_root = find_plugin_root(args)
    plugin_name = read_plugin_name(plugin_root)
    skill_name = slugify(args.name)
    display_name = args.display_name or skill_name.replace("-", " ").title()
    description = args.description or "Describe exactly when this plugin skill should be used."
    default_prompt = args.default_prompt or f"Use plugin:{plugin_name}/{skill_name} for this workflow."
    skill_root = plugin_root / "skills" / skill_name

    write_text(
        skill_root / "SKILL.md",
        "---\n"
        f"name: {skill_name}\n"
        f"description: {description}\n"
        f"version: {args.version}\n"
        f"author: {args.author_name}\n"
        f"license: {args.license}\n"
        "---\n\n"
        f"# {display_name}\n\n"
        "Use this skill when the user's request matches the plugin workflow.\n\n"
        "## Workflow\n\n"
        "1. Inspect the request and available workspace context.\n"
        "2. Load bundled references or scripts only when needed.\n"
        "3. Produce or modify the requested artifact.\n"
        "4. Verify the output before final response.\n",
        args.force,
    )
    write_text(
        skill_root / "agents" / "openai.yaml",
        "interface:\n"
        f'  display_name: "{display_name}"\n'
        '  short_description: "Short UI-only skill description."\n'
        f'  default_prompt: "{default_prompt}"\n'
        '  icon_small: "assets/icon-small.svg"\n'
        '  icon_large: "assets/icon-large.svg"\n'
        f'  brand_color: "{args.brand_color}"\n'
        "policy:\n"
        f"  allow_implicit_invocation: {args.allow_implicit_invocation}\n",
        args.force,
    )
    write_text(skill_root / "assets" / "icon-small.svg", svg_icon(display_name, args.brand_color, 64), args.force)
    write_text(skill_root / "assets" / "icon-large.svg", svg_icon(display_name, args.brand_color, 256), args.force)
    print(str(skill_root))


if __name__ == "__main__":
    main()
