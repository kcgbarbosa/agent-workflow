"""Each skill's frontmatter names its folder and describes it. Claude Code finds a skill by both."""

from __future__ import annotations

import re
from pathlib import Path

FIELD = re.compile(r"^([A-Za-z][\w-]*):\s*(.*)$")


def frontmatter(text: str) -> dict[str, str] | None:
    """The top-level fields between the opening `---` lines, or None when there are none."""
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        return None
    fields = {}
    for line in lines[1:]:
        if line == "---":
            return fields
        match = FIELD.match(line)
        if match:
            fields[match.group(1)] = match.group(2).strip().strip("\"'").strip()
    return None


def test_skill_frontmatter(repo: Path) -> None:
    failures = []
    for folder in sorted((repo / "skills").iterdir()):
        skill = folder / "SKILL.md"
        # A mod has .claude-plugin/plugin.json instead of SKILL.md.
        if not skill.is_file():
            continue
        fields = frontmatter(skill.read_text(encoding="utf-8"))
        if fields is None:
            failures.append(f"{folder.name}: no frontmatter between --- lines")
            continue
        if fields.get("name") != folder.name:
            failures.append(f"{folder.name}: name is {fields.get('name')!r}, not the folder name")
        if not fields.get("description"):
            failures.append(f"{folder.name}: no description")
    assert not failures, "\n".join(failures)
