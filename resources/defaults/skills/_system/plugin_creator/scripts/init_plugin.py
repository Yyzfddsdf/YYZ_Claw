#!/usr/bin/env python3
"""Scaffold a YYZ_Claw plugin."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def slugify(value: str) -> str:
    text = "".join(ch.lower() if ch.isalnum() else "-" for ch in value.strip())
    while "--" in text:
        text = text.replace("--", "-")
    return text.strip("-") or "my-plugin"


def yyz_root() -> Path:
    return Path(os.environ.get("YYZ_CLAW_HOME") or Path.home() / ".yyz")


def write_text(path: Path, content: str, force: bool) -> None:
    if path.exists() and not force:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def write_json(path: Path, data: object, force: bool) -> None:
    write_text(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n", force)


def svg_icon(label: str, color: str, size: int) -> str:
    initial = (label.strip()[:1] or "P").upper()
    font_size = max(18, size // 2)
    radius = max(8, size // 6)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}" role="img" aria-label="{label}">
  <rect width="{size}" height="{size}" rx="{radius}" fill="{color}"/>
  <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="Arial, sans-serif" font-size="{font_size}" font-weight="700" fill="#ffffff">{initial}</text>
</svg>
"""


def build_manifest(args: argparse.Namespace, plugin_name: str) -> dict:
    display_name = args.display_name or plugin_name.replace("-", " ").title()
    description = args.description or "Required. A stable one-line plugin description."
    short_description = args.short_description or "Shown in the plugin center UI only."
    long_description = (
        args.long_description
        or "Used as the plugin runtime description when present. Write the detailed model-facing purpose and boundaries here."
    )
    author_name = args.author_name or "Your Name"

    return {
        "name": plugin_name,
        "version": args.version,
        "description": description,
        "keywords": args.keyword,
        "author": {
            "name": author_name,
            "email": args.author_email,
            "url": args.author_url,
        },
        "skills": "./skills",
        "mcpServers": "./.mcp.json",
        "hooks": "./hooks/hooks.json",
        "rules": "./rules.md",
        "interface": {
            "displayName": display_name,
            "shortDescription": short_description,
            "longDescription": long_description,
            "developerName": author_name,
            "category": args.category,
            "capabilities": args.capability,
            "brandColor": args.brand_color,
            "composerIcon": "./assets/icon.svg",
            "logo": "./assets/logo.svg",
            "screenshots": [],
            "defaultPrompt": [args.default_prompt],
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Scaffold a YYZ_Claw plugin.")
    parser.add_argument("--name", required=True, help="Plugin id, for example my-plugin.")
    parser.add_argument("--root", default="", help="Plugin root parent. Defaults to <home>/.yyz/plugins.")
    parser.add_argument("--display-name", default="")
    parser.add_argument("--version", default="1.0.0")
    parser.add_argument("--description", default="")
    parser.add_argument("--short-description", default="")
    parser.add_argument("--long-description", default="")
    parser.add_argument("--author-name", default="")
    parser.add_argument("--author-email", default="")
    parser.add_argument("--author-url", default="")
    parser.add_argument("--category", default="Productivity")
    parser.add_argument("--brand-color", default="#2563eb")
    parser.add_argument("--default-prompt", default="Use this plugin to handle an example workflow.")
    parser.add_argument("--keyword", action="append", default=["example", "local", "workflow"])
    parser.add_argument("--capability", action="append", default=["example workflow", "local files"])
    parser.add_argument("--with-skill", default="", help="Also create an initial plugin skill with this id.")
    parser.add_argument("--force", action="store_true", help="Overwrite existing scaffold files.")
    args = parser.parse_args()

    plugin_name = slugify(args.name)
    plugin_parent = Path(args.root).expanduser() if args.root else yyz_root() / "plugins"
    plugin_root = plugin_parent / plugin_name

    manifest = build_manifest(args, plugin_name)
    display_name = manifest["interface"]["displayName"]

    write_json(plugin_root / ".plugin" / "plugin.json", manifest, args.force)
    write_text(plugin_root / "assets" / "icon.svg", svg_icon(display_name, args.brand_color, 128), args.force)
    write_text(plugin_root / "assets" / "logo.svg", svg_icon(display_name, args.brand_color, 256), args.force)
    write_text(
        plugin_root / "rules.md",
        "# Plugin Rules\n\n"
        "- Use this plugin only for its stated workflow.\n"
        "- Prefer local files and local workspace context.\n"
        "- Plugin hooks use the same hooks.json format as global hooks.\n"
        "- When adding plugin hooks, reuse the _system/hooks skill instead of inventing a new hook format.\n"
        "- Verify generated or modified files before reporting completion.\n",
        args.force,
    )
    write_json(plugin_root / ".mcp.json", {"mcpServers": {}}, args.force)
    write_json(
        plugin_root / "hooks" / "hooks.json",
        {
            "hooks": {
                "SessionStart": [],
                "UserPromptSubmitted": [],
                "PreToolUse": [],
                "PermissionRequest": [],
                "PostToolUse": [],
                "Stop": []
            }
        },
        args.force,
    )
    (plugin_root / "skills").mkdir(parents=True, exist_ok=True)

    if args.with_skill:
      from subprocess import check_call

      script = Path(__file__).with_name("init_plugin_skill.py")
      check_call([
          "python",
          str(script),
          "--plugin-root",
          str(plugin_root),
          "--name",
          args.with_skill,
          "--author-name",
          str(manifest["author"]["name"]),
          "--brand-color",
          args.brand_color,
      ])

    print(str(plugin_root))


if __name__ == "__main__":
    main()
