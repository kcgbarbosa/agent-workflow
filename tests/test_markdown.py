"""Relative links in the Markdown files point at files that exist."""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import unquote

FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
INLINE_CODE = re.compile(r"(`+).+?\1")
# [text](target) or ![alt](target), with an optional "title". The text may hold one level of brackets.
LINK = re.compile(r"\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+[\"'][^\"']*[\"'])?\s*\)")
SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")


def links(text: str) -> list[tuple[int, str]]:
    """The inline link targets outside code, each with its line number."""
    found = []
    fence = ""
    for number, line in enumerate(text.splitlines(), 1):
        match = FENCE.match(line)
        if fence:
            # Only a bare fence of the same character, at least as long, closes the block.
            closer = match.group(1) if match and not match.group(2).strip() else ""
            if closer[:1] == fence[0] and len(closer) >= len(fence):
                fence = ""
            continue
        if match:
            fence = match.group(1)
            continue
        for match in LINK.finditer(INLINE_CODE.sub("", line)):
            found.append((number, match.group(1) or match.group(2)))
    return found


def is_local(target: str) -> bool:
    return not SCHEME.match(target) and not target.startswith("#")


def broken_links(path: Path) -> list[str]:
    broken = []
    for number, target in links(path.read_text(encoding="utf-8")):
        if not is_local(target):
            continue
        relative = unquote(target.split("#", 1)[0])
        if not (path.parent / relative).exists():
            broken.append(f"line {number}: {target}")
    return broken


def test_relative_links_resolve(repo: Path, tracked: list[Path]) -> None:
    failures = []
    for path in tracked:
        if path.suffix == ".md":
            failures += [f"{path.relative_to(repo)} {item}" for item in broken_links(path)]
    assert not failures, "Broken relative links:\n" + "\n".join(failures)


def test_link_parser_skips_code_and_urls() -> None:
    text = "\n".join(
        [
            '[a](a.md) ![b](img/b.png) [c](c.md#part) [d](<d e.md> "title")',
            "`[e](e.md)` [f](https://x.y) [g](mailto:g@x.y) [h](#h)",
            "````md",
            "```",
            "[i](i.md)",
            "```",
            "````",
            "[j](j.md)",
        ]
    )
    local = ["a.md", "img/b.png", "c.md#part", "d e.md", "j.md"]
    targets = [target for _, target in links(text)]
    assert sorted(targets) == sorted([*local, "https://x.y", "mailto:g@x.y", "#h"])
    assert [t for t in targets if is_local(t)] == local
