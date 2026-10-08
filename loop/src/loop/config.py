"""A repo's settings for the loop, read from `loop.toml` at the root of its main checkout.

An unknown key refuses the file, so a typo cannot fall back to a default.
"""

from __future__ import annotations

import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .jira import Jira
from .tracker import Tracker

FILE = "loop.toml"
# The engine reads these secrets itself. A repo adds the ones its agents need.
REQUIRED_SECRETS = ("JIRA_EMAIL", "JIRA_API_TOKEN", "NTFY_TOPIC")


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
    main_branch: str
    agent_hint: str
    tools: tuple[str, ...]
    watch_port: int
    stack: Stack | None
    secrets: Mapping[str, Secret]
    state_dir: Path

    def stack_env(self, slot: int, key: str) -> dict[str, str]:
        """The env vars that give a worktree its own Compose project and ports."""
        if self.stack is None:
            return {}
        env = {port: str(base + self.stack.port_step * slot) for port, base in self.stack.ports.items()}
        # Compose accepts lowercase project names only.
        env["COMPOSE_PROJECT_NAME"] = f"{self.name}-{key.lower()}"
        return env

    def tracker(self, secrets: Mapping[str, str]) -> Tracker:
        return Jira(self.tracker_url, secrets["JIRA_EMAIL"], secrets["JIRA_API_TOKEN"])


def load(repo: Path, state_dir: Path | None = None) -> Config:
    path = repo / FILE
    try:
        data = tomllib.loads(path.read_text())
    except FileNotFoundError as error:
        raise ConfigError(f"{path} is missing. The setup-loop skill writes it.") from error
    except tomllib.TOMLDecodeError as error:
        raise ConfigError(f"{path} is not valid TOML: {error}") from error
    try:
        return _parse(repo, data, state_dir)
    except (KeyError, TypeError, ValueError) as error:
        raise ConfigError(f"{path}: {error}") from error


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
        parallel=limits.number("parallel", 2),
        agent_timeout_minutes=limits.number("agent_timeout_minutes", 90),
        fix_attempts=limits.number("fix_attempts", 2),
        circuit_breaker=limits.number("circuit_breaker", 2),
        ntfy_url=notify.text("url", "https://ntfy.sh"),
        ui_path=ui.text("path", None),
        ui_skill=ui.text("skill", "ui-review"),
        main_branch=top.text("main_branch", "main"),
        agent_hint=top.text("agent_hint", ""),
        tools=top.texts("tools", ()),
        watch_port=watch.number("port", 8790),
        stack=stack,
        secrets=secrets,
        state_dir=state_dir or Path.home() / ".local/state" / f"{name}-loop",
    )
    for table in (top, tracker, gates, limits, notify, ui, stack_table, watch, secrets_table):
        table.done()
    return config


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

    def table(self, key: str, optional: bool = False) -> _Table:
        value = self._get(key, {} if optional else _REQUIRED, dict)
        return _Table(value, f"{self.path}{key}.")

    def done(self) -> None:
        unknown = sorted(set(self.data) - self.read)
        if unknown:
            raise KeyError(f"unknown key {', '.join(self.path + key for key in unknown)}")
