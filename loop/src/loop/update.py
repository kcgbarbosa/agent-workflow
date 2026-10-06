"""Brings the loop's own checkout up to date before a run, so every host runs the merged loop.

`loop` is an editable install, so its code is the agent-workflow checkout it was installed from.
"""

from __future__ import annotations

from pathlib import Path

from .repo import GitError, git, out

BRANCH = "main"


class Stale(Exception):
    pass


def source_checkout() -> Path | None:
    """The agent-workflow checkout this code runs from, or None for an install that is not a checkout."""
    root = Path(__file__).resolve().parents[3]
    if (root / ".git").exists() and (root / "loop" / "pyproject.toml").exists():
        return root
    return None


def update(checkout: Path) -> str:
    """Fast-forwards a clean checkout of main to origin. Returns what happened, or raises Stale.

    A checkout on another branch is a deliberate test of a change, so it runs as it is.
    """
    branch = out(checkout, "branch", "--show-current")
    if branch != BRANCH:
        return f"The loop runs from the branch {branch} of {checkout}, as it is."
    if git(checkout, "fetch", "--quiet", "origin", BRANCH, check=False).returncode != 0:
        raise Stale(f"`git fetch` fails in {checkout}, so the loop cannot check that it is current.")
    behind = int(out(checkout, "rev-list", "--count", f"HEAD..origin/{BRANCH}"))
    ahead = int(out(checkout, "rev-list", "--count", f"origin/{BRANCH}..HEAD"))
    if behind == 0:
        return "The loop is current."
    if ahead:
        raise Stale(f"{checkout} and origin both have new commits on {BRANCH}. Merge them by hand.")
    if out(checkout, "status", "--porcelain", "--untracked-files=no"):
        raise Stale(f"{checkout} is behind origin and has changes that are not committed.")
    try:
        git(checkout, "merge", "--ff-only", "--quiet", f"origin/{BRANCH}")
    except GitError as error:
        raise Stale(f"{checkout} cannot fast-forward to origin: {error}") from error
    return f"The loop took {behind} new commit{'s' if behind > 1 else ''} from origin."
