"""No tracked text holds an em dash. AGENTS.md bans them."""

from __future__ import annotations

from pathlib import Path

EM_DASH = "\u2014"
# The rule names the character it bans. That one sentence may keep it.
RULE = f"Never use em dashes ({EM_DASH}) in any writing."


def em_dash_lines(path: Path, repo: Path) -> list[int]:
    data = path.read_bytes()
    if b"\0" in data:
        return []
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return []
    if path == repo / "AGENTS.md":
        text = text.replace(RULE, "", 1)
    return [number for number, line in enumerate(text.splitlines(), 1) if EM_DASH in line]


def test_no_em_dashes(repo: Path, tracked: list[Path]) -> None:
    failures = []
    for path in tracked:
        relative = path.relative_to(repo)
        if relative.parts[0] == "licenses":
            continue
        failures += [f"{relative}:{number}" for number in em_dash_lines(path, repo)]
    assert not failures, "Em dashes, rewrite with commas, periods, or a new sentence:\n" + "\n".join(failures)


def test_rule_is_still_in_agents_md(repo: Path) -> None:
    # If the rule is reworded, the allowance above no longer matches it and the check fails on AGENTS.md.
    assert RULE in (repo / "AGENTS.md").read_text(encoding="utf-8")
