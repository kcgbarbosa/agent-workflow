"""`loop start` brings the loop's own checkout up to date first."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from conftest import sh, write_config

from loop import cli
from loop.update import Stale, update


@pytest.fixture
def checkout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    """A clone of agent-workflow, and a second clone that pushes new commits to the same origin."""
    gitconfig = tmp_path / "gitconfig"
    gitconfig.write_text(
        "[user]\n\tname = Loop Test\n\temail = loop@example.com\n[init]\n\tdefaultBranch = main\n"
    )
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(gitconfig))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    origin = tmp_path / "origin.git"
    sh(tmp_path, "git", "init", "-q", "--bare", str(origin))
    local = tmp_path / "local"
    sh(tmp_path, "git", "clone", "-q", str(origin), str(local))
    commit(local, "run.py", "one")
    sh(local, "git", "push", "-q", "origin", "main")
    other = tmp_path / "other"
    sh(tmp_path, "git", "clone", "-q", str(origin), str(other))
    return local, other


def commit(repo: Path, name: str, text: str) -> None:
    (repo / name).write_text(text)
    sh(repo, "git", "add", "-A")
    sh(repo, "git", "commit", "-q", "-m", f"change {name}")


def test_a_clean_checkout_that_is_behind_takes_the_new_commits(checkout: tuple[Path, Path]) -> None:
    local, other = checkout
    commit(other, "run.py", "two")
    sh(other, "git", "push", "-q", "origin", "main")

    assert update(local) == ("The loop took 1 new commit from origin.", True)
    assert (local / "run.py").read_text() == "two"


def test_a_current_checkout_stays_as_it_is(checkout: tuple[Path, Path]) -> None:
    local, _ = checkout
    assert update(local) == ("The loop is current.", False)


def test_a_checkout_with_changes_is_not_overwritten(checkout: tuple[Path, Path]) -> None:
    local, other = checkout
    commit(other, "run.py", "two")
    sh(other, "git", "push", "-q", "origin", "main")
    (local / "run.py").write_text("a local edit")

    with pytest.raises(Stale, match="not committed"):
        update(local)
    assert (local / "run.py").read_text() == "a local edit"


def test_a_checkout_that_diverged_from_origin_refuses(checkout: tuple[Path, Path]) -> None:
    local, other = checkout
    commit(other, "run.py", "two")
    sh(other, "git", "push", "-q", "origin", "main")
    commit(local, "notes.md", "local")

    with pytest.raises(Stale, match="both have new commits"):
        update(local)


def test_a_checkout_on_another_branch_runs_as_it_is(checkout: tuple[Path, Path]) -> None:
    local, other = checkout
    commit(other, "run.py", "two")
    sh(other, "git", "push", "-q", "origin", "main")
    sh(local, "git", "switch", "-q", "-c", "feat/try-a-fix")

    updated = update(local)
    assert "branch feat/try-a-fix" in updated.message and not updated.new_code
    assert (local / "run.py").read_text() == "one"


def test_start_takes_the_new_loop_before_it_reads_loop_toml(
    checkout: tuple[Path, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    local, other = checkout
    commit(other, "run.py", "two")
    sh(other, "git", "push", "-q", "origin", "main")
    repo = tmp_path / "demo"
    repo.mkdir()
    write_config(repo)
    # A key that only the new loop knows. The old code refuses it.
    toml = repo / "loop.toml"
    toml.write_text('new_key = "x"\n' + toml.read_text())
    monkeypatch.setattr(cli, "source_checkout", lambda: local)
    restarts: list[list[str]] = []

    def execv(path: str, args: list[str]) -> None:
        restarts.append(args)
        raise SystemExit(0)

    monkeypatch.setattr(os, "execv", execv)

    with pytest.raises(SystemExit):
        cli.main(["start", "DEMO-1", "--repo", str(repo)])

    assert (local / "run.py").read_text() == "two"
    assert restarts == [[sys.executable, "-m", "loop", "start", "DEMO-1", "--repo", str(repo)]]
