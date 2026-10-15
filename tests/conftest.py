"""Shared helpers for the repo-level checks. They need git and nothing from the loop package."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]


@pytest.fixture
def repo() -> Path:
    return REPO


@pytest.fixture
def tracked() -> list[Path]:
    """Every tracked file still on disk. Only git knows which files are the repo's own."""
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=REPO, capture_output=True, text=True, check=True
    ).stdout
    return [REPO / name for name in out.split("\0") if name and (REPO / name).is_file()]


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, check=True).stdout


@pytest.fixture(autouse=True, scope="session")
def checkout_unchanged():
    """No test may change the checkout. It compares with the start, so an edit made before the run does not fail it."""
    # The diff also shows a new change to a file that was already dirty.
    before = git("status", "--porcelain", "--untracked-files=all") + git("diff", "HEAD")
    yield
    after = git("status", "--porcelain", "--untracked-files=all") + git("diff", "HEAD")
    assert after == before, f"the tests changed the checkout:\n{git('status', '--short')}"
