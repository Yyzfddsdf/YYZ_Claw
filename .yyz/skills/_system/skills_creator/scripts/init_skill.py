#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
from pathlib import Path
from textwrap import dedent


def parse_interface_items(items: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in items:
      if "=" not in item:
        raise SystemExit(f"Invalid --interface value: {item!r}. Expected key=value.")
      key, value = item.split("=", 1)
      key = key.strip()
      value = value.strip()
      if not key:
        raise SystemExit("Interface key cannot be empty.")
      result[key] = value
    return result


def yaml_quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def build_skill_md(skill_name: str, display_name: str, short_description: str, default_prompt: str) -> str:
    return dedent(
        f"""\
        ---
        name: {skill_name}
        description: {short_description}
        ---

        # {display_name}

        Write the minimum instructions needed for another agent to use this skill.

        ## Purpose

        Describe the task this skill solves and when to use it.

        ## Workflow

        1. Read the bundled references if needed.
        2. Use the scripts for deterministic steps.
        3. Keep the instructions concise and procedural.

        ## Bundled resources

        - `references/` for detailed guidance
        - `scripts/` for repeatable steps
        - `assets/` for output files or templates
        """
    ).strip() + "\n"


def build_openai_yaml(
    display_name: str,
    short_description: str,
    default_prompt: str,
    icon_small: str,
    icon_large: str,
    brand_color: str
) -> str:
    return dedent(
        f"""\
        interface:
          display_name: {yaml_quote(display_name)}
          short_description: {yaml_quote(short_description)}
          default_prompt: {yaml_quote(default_prompt)}
          icon_small: {yaml_quote(icon_small)}
          icon_large: {yaml_quote(icon_large)}
          brand_color: {yaml_quote(brand_color)}
        policy:
          allow_implicit_invocation: true
        """
    ).strip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Initialize a standard skill folder.")
    parser.add_argument("skill_name", help="Skill name in lowercase hyphen-case")
    parser.add_argument("--path", required=True, help="Output directory that will contain the skill")
    parser.add_argument(
        "--resources",
        default="",
        help="Comma-separated resource directories to create: scripts,references,assets"
    )
    parser.add_argument("--examples", action="store_true", help="Create placeholder examples")
    parser.add_argument(
        "--interface",
        action="append",
        default=[],
        help="Repeated key=value pairs for UI metadata"
    )
    args = parser.parse_args()

    skill_name = args.skill_name.strip()
    if not skill_name:
      raise SystemExit("skill_name is required")

    output_root = Path(args.path).expanduser().resolve()
    skill_root = output_root / skill_name
    skill_root.mkdir(parents=True, exist_ok=True)

    interface = parse_interface_items(args.interface)
    display_name = interface.get("display_name", skill_name.replace("-", " ").title())
    short_description = interface.get("short_description", f"Create and update {skill_name}")
    default_prompt = interface.get("default_prompt", f"Use ${skill_name} to work on this skill.")
    icon_small = interface.get("icon_small", "assets/icon-small.svg")
    icon_large = interface.get("icon_large", "assets/icon-large.svg")
    brand_color = interface.get("brand_color", "#2563eb")

    (skill_root / "SKILL.md").write_text(
      build_skill_md(skill_name, display_name, short_description, default_prompt),
      encoding="utf-8"
    )

    resources = {item.strip() for item in args.resources.split(",") if item.strip()}
    if not resources:
      resources = {"references", "scripts", "assets"}

    for resource_name in resources:
      (skill_root / resource_name).mkdir(parents=True, exist_ok=True)

    agents_dir = skill_root / "agents"
    agents_dir.mkdir(parents=True, exist_ok=True)
    (agents_dir / "openai.yaml").write_text(
      build_openai_yaml(
        display_name,
        short_description,
        default_prompt,
        icon_small,
        icon_large,
        brand_color
      ),
      encoding="utf-8"
    )

    if args.examples:
      if "references" in resources:
        (skill_root / "references" / "example.md").write_text(
          "# Example\n\nAdd the reference material needed by the skill.\n",
          encoding="utf-8"
        )
      if "scripts" in resources:
        (skill_root / "scripts" / "example.py").write_text(
          "#!/usr/bin/env python3\nprint('example')\n",
          encoding="utf-8"
        )
      if "assets" in resources:
        (skill_root / "assets" / "example.txt").write_text(
          "example asset\n",
          encoding="utf-8"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
