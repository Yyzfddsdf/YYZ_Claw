#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path


def parse_frontmatter(skill_md: str) -> dict[str, str]:
    lines = skill_md.splitlines()
    if not lines or lines[0].strip() != "---":
        raise SystemExit("SKILL.md missing frontmatter start.")

    data: dict[str, str] = {}
    for line in lines[1:]:
        stripped = line.strip()
        if stripped == "---":
            break
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip().strip('"').strip("'")
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description="Quick validate a skill folder.")
    parser.add_argument("skill_folder", help="Skill directory path")
    args = parser.parse_args()

    skill_root = Path(args.skill_folder).expanduser().resolve()
    skill_md_path = skill_root / "SKILL.md"

    errors: list[str] = []
    warnings: list[str] = []

    if not skill_md_path.exists():
        errors.append("SKILL.md is missing")
    else:
        frontmatter = parse_frontmatter(skill_md_path.read_text(encoding="utf-8"))
        if not frontmatter.get("name"):
            errors.append("frontmatter.name is required")
        if not frontmatter.get("description"):
            errors.append("frontmatter.description is required")

    if errors:
        for item in errors:
            print(f"error: {item}")
        return 1

    for item in warnings:
        print(f"warning: {item}")

    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
