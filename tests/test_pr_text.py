"""The pull request checks fail on a ticket key, a title that is not `type(scope): subject`, and an em dash."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SCRIPTS = REPO / ".github" / "scripts"


@pytest.fixture
def work(tmp_path: Path) -> tuple[Path, dict[str, str]]:
    config = tmp_path / "gitconfig"
    config.write_text("[user]\n\tname = Test\n\temail = test@example.com\n")
    env = {**os.environ, "GIT_CONFIG_GLOBAL": str(config), "GIT_CONFIG_NOSYSTEM": "1"}
    folder = tmp_path / "work"
    folder.mkdir()
    for args in (["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "first"]):
        subprocess.run(["git", *args], cwd=folder, env=env, check=True, capture_output=True)
    (folder / "projects").write_text("PITCH\nGAL\n")
    return folder, env


def keys(
    work: tuple[Path, dict[str, str]], text: str, message: str = "second"
) -> subprocess.CompletedProcess[str]:
    folder, env = work
    subprocess.run(["git", "commit", "-q", "--allow-empty", "-m", message], cwd=folder, env=env, check=True)
    env = {**env, "TICKET_PROJECTS_FILE": str(folder / "projects")}
    return subprocess.run(
        [str(SCRIPTS / "check-pr-keys.sh"), "HEAD~1..HEAD"],
        cwd=folder, env=env, input=text, capture_output=True, text=True,
    )  # fmt: skip


def title(title: str, body: str = "") -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "TITLE": title, "BODY": body}
    return subprocess.run([str(SCRIPTS / "check-pr-title.sh")], env=env, capture_output=True, text=True)


def test_a_key_in_the_text_fails(work: tuple[Path, dict[str, str]]) -> None:
    result = keys(work, "fix(loop): stop it\nIn PITCH-13, a restart did it.")

    assert result.returncode == 1 and "PITCH-13" in result.stderr


def test_a_key_in_a_commit_message_fails(work: tuple[Path, dict[str, str]]) -> None:
    result = keys(work, "fix(loop): stop it\n", message="fix(GAL-4): stop it")

    assert result.returncode == 1 and "GAL-4" in result.stderr


def test_text_with_no_key_passes(work: tuple[Path, dict[str, str]]) -> None:
    assert keys(work, "fix(loop): stop it\nA restart did it. See UTF-8 and ADR-0023.").returncode == 0


def test_a_title_needs_a_type() -> None:
    assert title("fix(loop): stop a stuck session").returncode == 0
    assert title("ci: guard the title").returncode == 0
    assert title("Stop a stuck session").returncode == 1


def test_an_em_dash_in_the_title_or_the_body_fails() -> None:
    assert title("fix(loop): stop it — now").returncode == 1
    assert title("fix(loop): stop it", "It stops — now.").returncode == 1
