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
