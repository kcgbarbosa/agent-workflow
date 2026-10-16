"""The subagent tiers, one Markdown file each in the agents folder of agent-workflow.

`install.sh` links the files into `~/.claude/agents`, where every agent run finds them. The loop reads them
only for the start line. `loop` is an editable install, so this folder is in its checkout.
"""

from __future__ import annotations

from pathlib import Path

FOLDER = Path(__file__).resolve().parents[3] / "agents"


class TierError(Exception):
    pass


def files() -> list[Path]:
    return sorted(FOLDER.glob("*.md"))


def parse(text: str) -> dict[str, str]:
    """One tier file: its frontmatter keys, and its body as `prompt`.

    The frontmatter is one `key: value` line per key, the subset of YAML that the tier files use.
    """
    lines = text.splitlines()
    if not lines or lines[0] != "---" or "---" not in lines[1:]:
        raise TierError("A tier file starts with frontmatter between two `---` lines.")
    end = lines.index("---", 1)
    tier = {}
    for line in lines[1:end]:
        key, separator, value = line.partition(": ")
        if not separator or not value.strip():
            raise TierError(f"This frontmatter line is not `key: value`: {line}")
        tier[key] = value.strip()
    tier["prompt"] = "\n".join(lines[end + 1 :]).strip()
    return tier


def load() -> dict[str, dict[str, str]]:
    tiers = {}
    for path in files():
        tier = parse(path.read_text())
        name = tier.pop("name", None)
        if name != path.stem:
            raise TierError(f"{path} names the tier {name}. Name it after its file.")
        tiers[name] = tier
    return tiers
