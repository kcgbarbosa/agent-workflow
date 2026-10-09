"""The co-author check fails on a Claude trailer in a pull request's own commits or body, nowhere else."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

TRAILER = "Co-authored-by: Claude <noreply@anthropic.com>"


@pytest.fixture
def git_env(tmp_path: Path) -> dict[str, str]:
    # Keep the runner's own git config, such as commit signing, out of the scratch repo.
    config = tmp_path / "gitconfig"
    config.write_text("[user]\n\tname = Test\n\temail = test@example.com\n")
    return {**os.environ, "GIT_CONFIG_GLOBAL": str(config), "GIT_CONFIG_NOSYSTEM": "1"}


@pytest.fixture
def scratch(tmp_path: Path, git_env: dict[str, str]):
    work = tmp_path / "work"
    work.mkdir()

    def git(*args: str) -> str:
        result = subprocess.run(["git", *args], cwd=work, env=git_env, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    git("init", "-q")
    git("commit", "-q", "--allow-empty", "-m", f"old commit on main\n\n{TRAILER}")
    return work, git


def check(work: Path, env: dict[str, str], repo: Path, base: str, head: str, body: str = ""):
    script = repo / ".github" / "scripts" / "check-co-authors.sh"
    env = {**env, "BASE_SHA": base, "HEAD_SHA": head, "PR_BODY": body}
    return subprocess.run([str(script)], cwd=work, env=env, capture_output=True, text=True)


def test_passes_on_clean_commits_despite_old_trailers(scratch, git_env, repo: Path) -> None:
    work, git = scratch
    base = git("rev-parse", "HEAD")
    git("commit", "-q", "--allow-empty", "-m", "feat: clean\n\nClaude-Session: https://example.com")
    result = check(work, git_env, repo, base, git("rev-parse", "HEAD"), body="A clean body.")
    assert result.returncode == 0, result.stderr


def test_names_each_commit_with_a_trailer(scratch, git_env, repo: Path) -> None:
    work, git = scratch
    base = git("rev-parse", "HEAD")
    git("commit", "-q", "--allow-empty", "-m", "feat: one\n\nco-authored-by: claude <x@y.z>")
    first = git("log", "-1", "--format=%h")
    git("commit", "-q", "--allow-empty", "-m", "feat: two")
    git("commit", "-q", "--allow-empty", "-m", "feat: three\n\nCo-Authored-By: X <noreply@anthropic.com>")
    third = git("log", "-1", "--format=%h")
    result = check(work, git_env, repo, base, git("rev-parse", "HEAD"))
    assert result.returncode == 1
    assert f"{first} feat: one" in result.stderr
    assert f"{third} feat: three" in result.stderr
    assert "feat: two" not in result.stderr
    assert "Remove" in result.stderr


def test_fails_on_a_trailer_in_the_body(scratch, git_env, repo: Path) -> None:
    work, git = scratch
    head = git("rev-parse", "HEAD")
    result = check(work, git_env, repo, head, head, body=f"Summary\r\n\r\n{TRAILER}\r\n")
    assert result.returncode == 1
    assert "body" in result.stderr


def test_body_is_never_run_as_code(scratch, git_env, repo: Path, tmp_path: Path) -> None:
    work, git = scratch
    head = git("rev-parse", "HEAD")
    marker = tmp_path / "ran"
    body = f'$(touch {marker}) `touch {marker}` "; touch {marker}'
    result = check(work, git_env, repo, head, head, body=body)
    assert result.returncode == 0, result.stderr
    assert not marker.exists()
