#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path
from textwrap import dedent


def extract_skill_frontmatter(skill_md: str) -> dict[str, str]:
    lines = skill_md.splitlines()
    if not lines or lines[0].strip() != "---":
        raise SystemExit("SKILL.md is missing frontmatter.")

    frontmatter: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if ":" not in line:
          continue
        key, value = line.split(":", 1)
        frontmatter[key.strip()] = value.strip().strip('"').strip("'")
    return frontmatter


def yaml_quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def parse_interface_items(items: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in items:
        if "=" not in item:
            raise SystemExit(f"Invalid --interface value: {item!r}. Expected key=value.")
        key, value = item.split("=", 1)
        result[key.strip()] = value.strip()
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Regenerate agents/openai.yaml for a skill.")
    parser.add_argument("skill_folder", help="Skill directory path")
    parser.add_argument(
        "--interface",
        action="append",
        default=[],
        help="Repeated key=value pairs that override generated interface fields"
    )
    args = parser.parse_args()

    skill_root = Path(args.skill_folder).expanduser().resolve()
    skill_md_path = skill_root / "SKILL.md"
    if not skill_md_path.exists():
        raise SystemExit("SKILL.md not found.")

    frontmatter = extract_skill_frontmatter(skill_md_path.read_text(encoding="utf-8"))
    overrides = parse_interface_items(args.interface)

    skill_name = frontmatter.get("name") or skill_root.name
    description = frontmatter.get("description") or "Create or update a skill"
    display_name = overrides.get("display_name", skill_name.replace("-", " ").title())
    short_description = overrides.get("short_description", description)
    default_prompt = overrides.get(
        "default_prompt",
        f"Use ${skill_name} to work on this skill."
    )

    agents_dir = skill_root / "agents"
    agents_dir.mkdir(parents=True, exist_ok=True)
    (agents_dir / "openai.yaml").write_text(
        dedent(
            f"""\
            interface:
              display_name: {yaml_quote(display_name)}
              short_description: {yaml_quote(short_description)}
              default_prompt: {yaml_quote(default_prompt)}
            policy:
              allow_implicit_invocation: true
            """
        ).strip() + "\n",
        encoding="utf-8"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
