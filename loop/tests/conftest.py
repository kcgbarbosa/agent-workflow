"""The loop tests run `loop run` as a subprocess against a temporary git repo, a fake Jira, and fake commands.

The fake commands in `bin/` come first on PATH, so no test calls the real Jira, ntfy, GitHub, Docker, or
`claude`. The run's home folder is in the test's own folder, so its state and secrets are too.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from fake_jira import FakeJira

from loop import config

BIN = Path(__file__).parent / "bin"
# The kill points of git: before the test repo pushes, and after origin takes a push.
HOOKS = Path(__file__).parent / "hooks"
LOOP_WITH_FAST_CLOCK = Path(__file__).parent / "loop_clock.py"
EPIC = "DEMO-1"
SECRETS = {"JIRA_EMAIL": "kc@example.com", "JIRA_API_TOKEN": "secret-token", "NTFY_TOPIC": "secret-topic"}


CONFIG = """
name = "demo"
agent_hint = "Run the tests with `make test`."
tools = ["make"]

[tracker]
kind = "jira"
url = "{tracker_url}"
name_landed_keys_only = {landed_keys_only}

[gates]
ticket = ["make", "lint", "test"]
merge = ["make", "check"]

[limits]
parallel = {parallel}

[notify]
url = "{tracker_url}/ntfy"

[ui]
path = "frontend/src/"
{ui_extra}

[stack]
port_step = 10
ports = {{ DB_PORT = 55432, API_PORT = 8000 }}

[secrets]
JIRA_EMAIL = {{ item = "demo-jira", field = "username" }}
JIRA_API_TOKEN = {{ item = "demo-jira", field = "password" }}
NTFY_TOPIC = {{ item = "demo-ntfy-topic", field = "password" }}
"""


def write_config(
    repo: Path,
    tracker_url: str = "http://127.0.0.1:9",
    parallel: int = 2,
    landed_keys_only: bool = False,
    extra: str = "",
    ui_extra: str = "",
) -> None:
    """The test config. `extra` adds tables at the end, such as `[agent]`. `ui_extra` adds keys to `[ui]`."""
    text = CONFIG.format(
        tracker_url=tracker_url,
        parallel=parallel,
        landed_keys_only=str(landed_keys_only).lower(),
        ui_extra=ui_extra,
    )
    (repo / config.FILE).write_text(text + extra)


def sh(cwd: Path, *args: str) -> str:
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


@dataclass
class World:
    jira: FakeJira
    repo: Path
    origin: Path
    home: Path
    fakes: Path

    @property
    def state(self) -> Path:
        return self.home / ".local/state/demo-loop"

    def plan(self, steps: dict[str, list[dict[str, Any]]]) -> None:
        (self.fakes / "plan.json").write_text(json.dumps(steps))

    def kill_at(self, point: str, nth: int = 1, signal: str = "SIGKILL") -> None:
        """Sends the signal to the next run when it reaches the point for the nth time (`killpoint`)."""
        (self.fakes / "kill.json").write_text(json.dumps({"at": point, "nth": nth, "signal": signal}))

    def finished(self, name: str) -> int:
        """How many agent runs of the session name returned their status."""
        return sum(1 for record in self.records("finished") if record["name"] == name)

    def run(
        self,
        parallel: int = 2,
        landed_keys_only: bool = False,
        extra: str = "",
        base: str | None = None,
        ui_extra: str = "",
        stdin: int = subprocess.DEVNULL,
    ) -> int:
        """Runs `loop run` and returns its exit code. Its output shows when the test fails."""
        write_config(self.repo, self.jira.url, parallel, landed_keys_only, extra, ui_extra)
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / "secrets.json").write_text(json.dumps(SECRETS))
        on = ["--on", base] if base else []
        command = [sys.executable, str(LOOP_WITH_FAST_CLOCK), "run", EPIC, "--repo", str(self.repo), *on]
        env = {**os.environ, "HOME": str(self.home)}
        finished = subprocess.run(command, env=env, stdin=stdin, capture_output=True, text=True, timeout=300)
        print(finished.stdout, finished.stderr, sep="\n")
        return finished.returncode

    def push_branch(self, branch: str, files: dict[str, str], start: str = "origin/main") -> None:
        """Pushes a commit of the files on the branch, as another Epic's PR branch."""
        sh(self.repo, "git", "switch", "-q", "-C", branch, start)
        for name, text in files.items():
            (self.repo / name).write_text(text)
        sh(self.repo, "git", "add", "-A")
        sh(self.repo, "git", "commit", "-q", "-m", f"feat: {branch}")
        sh(self.repo, "git", "push", "-q", "origin", branch)
        sh(self.repo, "git", "switch", "-q", "main")

    def results(self, ticket: str | None = None, step: str | None = None) -> list[str]:
        """The results in the log, of one ticket or step when named."""
        return [
            line["result"]
            for line in self.decisions()
            if (ticket is None or line["ticket"] == ticket) and (step is None or line["step"] == step)
        ]

    def first_session(self, key: str) -> str:
        """The session of the ticket's first agent run."""
        lines = self.decisions()
        return str(
            next(line["session"] for line in lines if (line["ticket"], line["step"]) == (key, "agent"))
        )

    def run_dir(self, key: str) -> Path:
        return self.state / EPIC / "runs" / key

    def gh(self, *args: str) -> list[dict[str, Any]]:
        """The `gh` calls whose arguments start with these."""
        return [call for call in self.records("gh") if call["args"][: len(args)] == list(args)]

    def prs(self) -> list[dict[str, Any]]:
        """The PRs that the fake `gh` keeps, oldest first."""
        path = self.fakes / "prs.json"
        return list(json.loads(path.read_text())) if path.exists() else []

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
    (origin / "hooks" / "post-receive").symlink_to(HOOKS / "post-receive")
    repo = tmp_path / "demo"
    sh(tmp_path, "git", "clone", "-q", str(origin), str(repo))
    (repo / ".git" / "hooks" / "pre-push").symlink_to(HOOKS / "pre-push")
    (repo / "README.md").write_text("# Demo\n")
    sh(repo, "git", "add", "-A")
    sh(repo, "git", "commit", "-q", "-m", "chore: start")
    sh(repo, "git", "push", "-q", "origin", "main")

    jira = FakeJira()
    jira.add(EPIC, "The Loop", issue_type="Epic")
    world = World(jira, repo, origin, tmp_path / "home", fakes)
    world.plan({})
    yield world
    jira.close()
