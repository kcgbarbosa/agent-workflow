"""The subagent tiers, one Markdown file each in the agents folder of agent-workflow.

`install.sh` links the same files into `~/.claude/agents`, and the loop gives them to each agent run with
`--agents`, so a tier has one home. `loop` is an editable install, so this folder is in its checkout.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

FOLDER = Path(__file__).resolve().parents[3] / "agents"
# The frontmatter keys that hold a list, an integer, or a flag. Every other key holds text.
LISTS = {"tools", "disallowedTools", "skills"}
INTEGERS = {"maxTurns"}
FLAGS = {"omitClaudeMd", "background"}


class TierError(Exception):
    pass


def files() -> list[Path]:
    return sorted(FOLDER.glob("*.md"))


def parse(text: str) -> dict[str, Any]:
    """One tier file as an `--agents` definition: its frontmatter keys, and its body as `prompt`.

    The frontmatter is one `key: value` line per key, the subset of YAML that the tier files use.
    """
    lines = text.splitlines()
    if not lines or lines[0] != "---" or "---" not in lines[1:]:
        raise TierError("A tier file starts with frontmatter between two `---` lines.")
    end = lines.index("---", 1)
    tier: dict[str, Any] = {}
    for line in lines[1:end]:
        key, separator, value = line.partition(": ")
        if not separator or not value.strip():
            raise TierError(f"This frontmatter line is not `key: value`: {line}")
        value = value.strip()
        if key in LISTS:
            tier[key] = [part.strip() for part in value.split(",")]
        elif key in INTEGERS:
            tier[key] = int(value)
        elif key in FLAGS:
            tier[key] = value == "true"
        else:
            tier[key] = value
    tier["prompt"] = "\n".join(lines[end + 1 :]).strip()
    return tier


def load() -> dict[str, dict[str, Any]]:
    """Every tier by name, in the form `--agents` takes."""
    tiers = {}
    for path in files():
        tier = parse(path.read_text())
        name = tier.pop("name", None)
        if name != path.stem:
            raise TierError(f"{path} names the tier {name}. Name it after its file.")
        tiers[name] = tier
    return tiers
