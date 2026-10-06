"""The loop tests drive full runs against a temporary git repo, a fake Jira, and a fake `claude` command.

The fake commands in `bin/` come first on PATH, so no test calls the real Jira, ntfy, GitHub, or `claude`.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from fake_jira import FakeJira

from loop import config
from loop.run import run

BIN = Path(__file__).parent / "bin"
EPIC = "DEMO-1"
SECRETS = {"JIRA_EMAIL": "kc@example.com", "JIRA_API_TOKEN": "secret-token", "NTFY_TOPIC": "secret-topic"}


CONFIG = """
name = "demo"
agent_hint = "Run the tests with `make test`."
tools = ["make"]

[tracker]
kind = "jira"
url = "{tracker_url}"

[gates]
ticket = ["make", "lint", "test"]
merge = ["make", "check"]

[limits]
parallel = {parallel}

[notify]
url = "{tracker_url}/ntfy"

[ui]
path = "frontend/src/"

[stack]
port_step = 10
ports = {{ DB_PORT = 55432, API_PORT = 8000 }}

[secrets]
JIRA_EMAIL = {{ item = "demo-jira", field = "username" }}
JIRA_API_TOKEN = {{ item = "demo-jira", field = "password" }}
NTFY_TOPIC = {{ item = "demo-ntfy-topic", field = "password" }}
"""


def write_config(repo: Path, tracker_url: str = "http://127.0.0.1:9", parallel: int = 2) -> None:
    (repo / config.FILE).write_text(CONFIG.format(tracker_url=tracker_url, parallel=parallel))


def sh(cwd: Path, *args: str) -> str:
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


@dataclass
class World:
    jira: FakeJira
    repo: Path
    origin: Path
    state: Path
    fakes: Path

    def plan(self, steps: dict[str, list[dict[str, Any]]]) -> None:
        (self.fakes / "plan.json").write_text(json.dumps(steps))

    def run(self, parallel: int = 2) -> int:
        write_config(self.repo, self.jira.url, parallel)
        return run(EPIC, config.load(self.repo, state_dir=self.state), SECRETS)

    def records(self, name: str) -> list[dict[str, Any]]:
        path = self.fakes / f"{name}.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def calls(self, name: str | None = None) -> list[dict[str, Any]]:
        return [call for call in self.records("calls") if name is None or call["name"] == name]

    def epic_log(self) -> list[str]:
        """The subjects on the Epic branch, newest first."""
        branch = sh(
            self.repo, "git", "for-each-ref", "--format=%(refname:short)", f"refs/heads/feat/{EPIC}-*"
        )
        return sh(self.repo, "git", "log", "--format=%s", branch).splitlines()

    def epic_file(self, path: str) -> Path:
        return self.state / EPIC / "worktrees" / EPIC / path

    def decisions(self) -> list[dict[str, Any]]:
        path = self.state / EPIC / "decisions.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()]


@pytest.fixture
def world(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[World]:
    gitconfig = tmp_path / "gitconfig"
    gitconfig.write_text(
        "[user]\n\tname = Loop Test\n\temail = loop@example.com\n[init]\n\tdefaultBranch = main\n"
    )
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(gitconfig))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    fakes = tmp_path / "fakes"
    fakes.mkdir()
    monkeypatch.setenv("FAKE_CLAUDE_DIR", str(fakes))
    # Only the fakes and the folders of the real tools the loop needs. `timeout` is in gnubin on macOS.
    tools = {
        str(Path(found).parent) for tool in ("git", "timeout", "python3") if (found := shutil.which(tool))
    }
    monkeypatch.setenv("PATH", ":".join([str(BIN), *sorted(tools)]))
    monkeypatch.setenv("BW_SESSION", "vault-session-key")

    origin = tmp_path / "origin.git"
    sh(tmp_path, "git", "init", "-q", "--bare", str(origin))
    repo = tmp_path / "demo"
    sh(tmp_path, "git", "clone", "-q", str(origin), str(repo))
    (repo / "README.md").write_text("# Demo\n")
    sh(repo, "git", "add", "-A")
    sh(repo, "git", "commit", "-q", "-m", "chore: start")
    sh(repo, "git", "push", "-q", "origin", "main")

    jira = FakeJira()
    jira.add(EPIC, "The Loop", issue_type="Epic")
    world = World(jira, repo, origin, tmp_path / "state", fakes)
    world.plan({})
    yield world
    jira.close()
