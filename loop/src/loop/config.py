"""A repo's settings for the loop, read from `loop.toml` at the root of its main checkout.

An unknown key refuses the file, so a typo cannot fall back to a default.
"""

from __future__ import annotations

import json
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from .jira import Jira

FILE = "loop.toml"
SECRETS_FILE = "secrets.json"
# The engine reads these secrets itself. A repo adds the ones its agents need.
REQUIRED_SECRETS = ("JIRA_EMAIL", "JIRA_API_TOKEN", "NTFY_TOPIC")
WATCH_PORT = 8790
# The UI review's own folder in a run folder. The loop attaches only it, because an agent can save other
# images in the run folder, such as the screenshots of each acceptance run.
SHOTS_DIR = "screenshots"
# How long the forecast keeps what it read from Jira, so a page that stays open reads Jira at most that often.
BACKLOG_MINUTES = 5
# The window each agent run compacts at, so a long ticket never sends more than this on each turn.
CONTEXT_TOKENS = 200_000
# The heading of the list in the ticket text that each acceptance test covers, one test per line.
ACCEPTANCE_HEADING = "What the user sees"


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Secret:
    item: str
    field: str


@dataclass(frozen=True)
class Stack:
    """A Docker Compose stack per worktree. Each slot moves every port by `port_step`."""

    ports: Mapping[str, int]
    port_step: int


@dataclass(frozen=True)
class Demo:
    """The always-on demo. `command` points it at a branch, and each `{branch}` in it names the branch."""

    command: tuple[str, ...]
    url: str


@dataclass(frozen=True)
class PlanSpan:
    """The Claude plan from `since` on. A date with no time leaves the runs of that day to either plan."""

    plan: str
    since: datetime
    exact: bool


# The plans `[watch]` `plans` may name. `forecast.PLANS` holds what each one gives and costs.
PLAN_KEYS = ("pro", "max-5x", "max-20x")


@dataclass(frozen=True)
class Config:
    """The defaults live in `_parse`, so the file is the one place a value comes from."""

    repo: Path
    name: str
    tracker_url: str
    in_progress: str
    name_landed_keys_only: bool
    landed_status: str
    ticket_gate: tuple[str, ...]
    merge_gate: tuple[str, ...]
    gate_timeout_minutes: int
    parallel: int
    agent_timeout_minutes: int
    fix_attempts: int
    circuit_breaker: int
    ntfy_url: str
    ui_path: str | None
    ui_skill: str
    ui_accepted_unchecked: tuple[str, ...]
    acceptance_list: tuple[str, ...] | None
    main_branch: str
    agent_model: str
    agent_effort: str
    agent_hint: str
    tools: tuple[str, ...]
    plans: tuple[PlanSpan, ...]
    stack: Stack | None
    demo: Demo | None
    secrets: Mapping[str, Secret]
    state_dir: Path

    def stack_env(self, slot: int, key: str) -> dict[str, str]:
        if self.stack is None:
            return {}
        env = {port: str(base + self.stack.port_step * slot) for port, base in self.stack.ports.items()}
        # Compose accepts lowercase project names only.
        env["COMPOSE_PROJECT_NAME"] = f"{self.name}-{key.lower()}"
        return env

    def jira(self, secrets: Mapping[str, str]) -> Jira:
        return Jira(self.tracker_url, secrets["JIRA_EMAIL"], secrets["JIRA_API_TOKEN"])


def load(repo: Path, state_dir: Path | None = None) -> Config:
    data = _read(repo)
    try:
        return _parse(repo, data, state_dir)
    except (KeyError, TypeError, ValueError) as error:
        raise ConfigError(f"{repo / FILE}: {error}") from error


def peek(repo: Path) -> str:
    """The name, with no check of the other keys, so that `loop start` on the old code hands a file with a
    new key to the new code."""
    top = _Table(_read(repo), "")
    try:
        name: str = top.text("name")
        return name
    except (KeyError, TypeError, ValueError) as error:
        raise ConfigError(f"{repo / FILE}: {error}") from error


def state_dir_of(name: str) -> Path:
    return Path.home() / ".local/state" / f"{name}-loop"


def stored_secrets(state_dir: Path) -> dict[str, str]:
    """The secrets that `loop secrets` wrote, or none when the file is missing or unreadable."""
    try:
        secrets = json.loads((state_dir / SECRETS_FILE).read_text())
    except OSError, json.JSONDecodeError:
        return {}
    return {str(name): str(value) for name, value in secrets.items()} if isinstance(secrets, dict) else {}


def _read(repo: Path) -> dict[str, Any]:
    path = repo / FILE
    try:
        return tomllib.loads(path.read_text())
    except FileNotFoundError as error:
        raise ConfigError(f"{path} is missing. The setup-loop skill writes it.") from error
    except tomllib.TOMLDecodeError as error:
        raise ConfigError(f"{path} is not valid TOML: {error}") from error


def _parse(repo: Path, data: dict[str, Any], state_dir: Path | None) -> Config:
    top = _Table(data, "")
    name = top.text("name")
    tracker = top.table("tracker")
    if tracker.text("kind") != "jira":
        raise ValueError("tracker.kind: the loop has a Jira adapter only")
    gates = top.table("gates")
    limits = top.table("limits", optional=True)
    notify = top.table("notify", optional=True)
    ui = top.table("ui", optional=True)
    stack_table = top.table("stack", optional=True)
    watch = top.table("watch", optional=True)
    agent = top.table("agent", optional=True)
    demo_table = top.table("demo", optional=True)
    acceptance = top.table("acceptance", optional=True)
    secrets_table = top.table("secrets")

    secrets = {}
    for env in secrets_table.keys():
        entry = secrets_table.table(env)
        secrets[env] = Secret(entry.text("item"), entry.text("field"))
        entry.done()
    missing = [env for env in REQUIRED_SECRETS if env not in secrets]
    if missing:
        raise ValueError(f"secrets: the engine needs {', '.join(missing)}")

    stack = None
    if stack_table:
        ports = stack_table.table("ports")
        stack = Stack({port: ports.number(port) for port in ports.keys()}, stack_table.number("port_step"))
        ports.done()

    demo = None
    if "demo" in data:
        command = demo_table.texts("command")
        if not command:
            raise ValueError("demo.command must not be empty")
        demo = Demo(command, demo_table.text("url"))

    acceptance_list = None
    if "acceptance" in data:
        acceptance_list = acceptance.texts("list")
        if not acceptance_list:
            raise ValueError("acceptance.list must not be empty")

    config = Config(
        repo=repo,
        name=name,
        tracker_url=tracker.text("url"),
        in_progress=tracker.text("in_progress", "In Progress"),
        name_landed_keys_only=tracker.flag("name_landed_keys_only", False),
        landed_status=tracker.text("landed", "In Review"),
        ticket_gate=gates.texts("ticket"),
        merge_gate=gates.texts("merge"),
        gate_timeout_minutes=gates.number("timeout_minutes", 60),
        parallel=limits.number("parallel", 1),
        agent_timeout_minutes=limits.number("agent_timeout_minutes", 90),
        fix_attempts=limits.number("fix_attempts", 2),
        circuit_breaker=limits.number("circuit_breaker", 2),
        ntfy_url=notify.text("url", "https://ntfy.sh"),
        ui_path=ui.text("path", None),
        ui_skill=ui.text("skill", "ui-review"),
        ui_accepted_unchecked=ui.texts("accepted_unchecked", ()),
        acceptance_list=acceptance_list,
        main_branch=top.text("main_branch", "main"),
        agent_model=agent.text("model", "claude-opus-5-5"),
        agent_effort=agent.text("effort", "high"),
        agent_hint=top.text("agent_hint", ""),
        tools=top.texts("tools", ()),
        plans=_plans(watch.tables("plans")),
        stack=stack,
        demo=demo,
        secrets=secrets,
        state_dir=state_dir or state_dir_of(name),
    )
    tables = (
        top,
        tracker,
        gates,
        limits,
        notify,
        ui,
        stack_table,
        watch,
        agent,
        demo_table,
        acceptance,
        secrets_table,
    )
    for table in tables:
        table.done()
    return config


def _plans(entries: list[_Table]) -> tuple[PlanSpan, ...]:
    spans = []
    for entry in entries:
        plan = entry.text("plan")
        if plan not in PLAN_KEYS:
            raise ValueError(f"{entry.path}plan must be one of {', '.join(PLAN_KEYS)}")
        since = entry._get("since", _REQUIRED, (str, date))
        entry.done()
        if isinstance(since, str):
            since = datetime.fromisoformat(since) if "T" in since else date.fromisoformat(since)
        if isinstance(since, datetime):
            spans.append(PlanSpan(plan, since if since.tzinfo else since.replace(tzinfo=UTC), True))
        else:
            spans.append(PlanSpan(plan, datetime(since.year, since.month, since.day, tzinfo=UTC), False))
    return tuple(sorted(spans, key=lambda span: span.since))


_REQUIRED: Any = object()


class _Table:
    """One TOML table. Each read marks its key as known, and `done` refuses the keys nobody read."""

    def __init__(self, data: Any, path: str) -> None:
        if not isinstance(data, dict):
            raise TypeError(f"{path.rstrip('.') or 'the file'} must be a table")
        self.data: dict[str, Any] = data
        self.path = path
        self.read: set[str] = set()

    def __bool__(self) -> bool:
        return bool(self.data)

    def keys(self) -> list[str]:
        self.read |= set(self.data)
        return list(self.data)

    def _get(self, key: str, default: Any, kind: type | tuple[type, ...]) -> Any:
        self.read.add(key)
        if key not in self.data:
            if default is _REQUIRED:
                raise KeyError(f"{self.path}{key} is missing")
            return default
        value = self.data[key]
        if not isinstance(value, kind) or isinstance(value, bool):
            raise TypeError(f"{self.path}{key} has the wrong type")
        return value

    def text(self, key: str, default: Any = _REQUIRED) -> Any:
        return self._get(key, default, str)

    def flag(self, key: str, default: Any = _REQUIRED) -> bool:
        self.read.add(key)
        value = self.data.get(key, default)
        if value is _REQUIRED:
            raise KeyError(f"{self.path}{key} is missing")
        if not isinstance(value, bool):
            raise TypeError(f"{self.path}{key} has the wrong type")
        return value

    def number(self, key: str, default: Any = _REQUIRED) -> int:
        value: int = self._get(key, default, int)
        return value

    def texts(self, key: str, default: Any = _REQUIRED) -> tuple[str, ...]:
        value = self._get(key, default, (list, tuple))
        if not all(isinstance(item, str) for item in value):
            raise TypeError(f"{self.path}{key} must be a list of strings")
        return tuple(value)

    def tables(self, key: str) -> list[_Table]:
        """An optional array of tables, such as `plans = [{ ... }]`."""
        value = self._get(key, [], list)
        return [_Table(item, f"{self.path}{key}[{number}].") for number, item in enumerate(value)]

    def table(self, key: str, optional: bool = False) -> _Table:
        value = self._get(key, {} if optional else _REQUIRED, dict)
        return _Table(value, f"{self.path}{key}.")

    def done(self) -> None:
        unknown = sorted(set(self.data) - self.read)
        if unknown:
            raise KeyError(f"unknown key {', '.join(self.path + key for key in unknown)}")
