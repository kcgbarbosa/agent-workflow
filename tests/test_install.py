"""install.sh links the repo into a fresh home and is safe to run again.

Every run gets a temp HOME and a fake uv, so nothing is installed for real and the checkout is never touched.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

BASE_REF_WARNING = '"worktree": {"baseRef": "head"}'


@pytest.fixture
def home(tmp_path: Path) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    return home


@pytest.fixture
def run(tmp_path: Path, home: Path, repo: Path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    uv = bin_dir / "uv"
    # Records its arguments, so the test can see the loop command would be installed.
    uv.write_text(f'#!/bin/sh\necho "$@" >> "{tmp_path / "uv.log"}"\n')
    uv.chmod(0o755)
    env = {**os.environ, "HOME": str(home), "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"}

    def run() -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [str(repo / "install.sh")], env=env, capture_output=True, text=True, cwd=tmp_path
        )
        assert result.returncode == 0, result.stderr
        return result

    return run


def skills(repo: Path) -> list[Path]:
    return sorted(p for p in (repo / "skills").iterdir() if p.is_dir() and not p.name.startswith("."))


def tiers(repo: Path) -> list[Path]:
    return sorted((repo / "agents").glob("*.md"))


def snapshot(root: Path) -> dict[str, str]:
    """Each entry under root, with its link target or kind, to compare two runs."""
    entries = {}
    for path in sorted(root.rglob("*")):
        key = str(path.relative_to(root))
        if path.is_symlink():
            entries[key] = "-> " + os.readlink(path)
        else:
            entries[key] = "dir" if path.is_dir() else "file"
    return entries


def test_links_every_skill_tier_and_agents_md(run, home: Path, repo: Path, tmp_path: Path) -> None:
    run()
    claude = home / ".claude"
    for skill in skills(repo):
        link = claude / "skills" / skill.name
        assert link.is_symlink() and link.resolve() == skill.resolve(), skill.name
    for tier in tiers(repo):
        link = claude / "agents" / tier.name
        assert link.is_symlink() and link.resolve() == tier.resolve(), tier.name
    assert (claude / "CLAUDE.md").is_symlink()
    assert (claude / "CLAUDE.md").resolve() == (repo / "AGENTS.md").resolve()
    assert f"tool install --quiet --editable {repo}/loop" in (tmp_path / "uv.log").read_text()


def test_removes_stale_repo_links_and_keeps_others(run, home: Path, repo: Path, tmp_path: Path) -> None:
    claude = home / ".claude"
    (claude / "skills").mkdir(parents=True)
    (claude / "agents").mkdir()
    # Paths under the repo that do not exist, as after a skill or tier is removed.
    (claude / "skills" / "gone").symlink_to(repo / "skills" / "no-such-skill")
    (claude / "agents" / "gone.md").symlink_to(repo / "agents" / "no-such-tier.md")
    # Links to elsewhere belong to someone else, even when they dangle.
    elsewhere = tmp_path / "elsewhere"
    (claude / "skills" / "mine").symlink_to(elsewhere / "skill")
    (claude / "agents" / "mine.md").symlink_to(elsewhere / "tier.md")

    run()

    assert not (claude / "skills" / "gone").is_symlink()
    assert not (claude / "agents" / "gone.md").is_symlink()
    assert os.readlink(claude / "skills" / "mine") == str(elsewhere / "skill")
    assert os.readlink(claude / "agents" / "mine.md") == str(elsewhere / "tier.md")


def test_skips_real_files_and_names_them(run, home: Path, repo: Path) -> None:
    claude = home / ".claude"
    skill = skills(repo)[0].name
    tier = tiers(repo)[0].name
    (claude / "skills" / skill).mkdir(parents=True)
    (claude / "skills" / skill / "keep.txt").write_text("mine")
    (claude / "agents").mkdir()
    (claude / "agents" / tier).write_text("my tier")
    (claude / "CLAUDE.md").write_text("my rules")

    stderr = run().stderr

    assert not (claude / "skills" / skill).is_symlink()
    assert (claude / "skills" / skill / "keep.txt").read_text() == "mine"
    assert not (claude / "agents" / tier).is_symlink()
    assert (claude / "agents" / tier).read_text() == "my tier"
    assert not (claude / "CLAUDE.md").is_symlink()
    assert (claude / "CLAUDE.md").read_text() == "my rules"
    for name in (f"skipped {skill}", f"skipped the {tier} tier", "skipped CLAUDE.md"):
        assert name in stderr


def test_warns_when_base_ref_is_missing(run) -> None:
    assert BASE_REF_WARNING in run().stderr


def test_no_warning_when_base_ref_is_set(run, home: Path) -> None:
    (home / ".claude").mkdir()
    (home / ".claude" / "settings.json").write_text('{"worktree": {"baseRef": "head"}}\n')
    assert BASE_REF_WARNING not in run().stderr


def test_second_run_changes_nothing(run, home: Path) -> None:
    first = run()
    before = snapshot(home)
    second = run()
    assert snapshot(home) == before
    assert second.stderr == first.stderr
