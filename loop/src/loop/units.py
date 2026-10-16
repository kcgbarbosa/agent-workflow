"""The systemd user units of the loop (loop.md rule 12): a unit for each Epic run, and the dashboard."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

from . import process

EPIC_KEY = r"[A-Z][A-Z0-9]*-\d+"
ENV = ("PATH", "HOME", "LANG", "SSH_AUTH_SOCK")
RUN_PROPERTIES = ("KillMode=mixed", "TimeoutStopSec=10min")
WATCH_PROPERTIES = ("Restart=always", "RestartSec=5")


class UnitError(Exception):
    pass


def run_unit(name: str, epic_key: str) -> str:
    return f"loop-{name}-{epic_key}.service"


def runs(name: str) -> list[str]:
    """The Epic keys of the project's run units that systemd has loaded. `--collect` unloads a run when it
    ends, also when it fails."""
    listed = systemctl("list-units", "--plain", "--no-legend", f"loop-{name}-*")
    unit = re.compile(rf"loop-{re.escape(name)}-({EPIC_KEY})\.service")
    return [found[1] for line in listed.splitlines() if (found := unit.fullmatch(line.split(" ", 1)[0]))]


def start_run(repo: Path, name: str, epic_key: str, base: str | None) -> str:
    """Starts `loop run` in its unit, and returns the unit once it is active."""
    on = ["--on", base] if base else []
    command = [sys.executable, "-m", "loop", "run", epic_key, "--repo", str(repo), *on]
    unit = run_unit(name, epic_key)
    run_in_unit(unit, repo, command, RUN_PROPERTIES)
    return unit


def stop_run(name: str, epic_key: str) -> bool:
    """Stops the run's unit, and returns once the run has ended. False when no run of the Epic is active."""
    if epic_key not in runs(name):
        return False
    systemctl("stop", run_unit(name, epic_key))
    return True


def watch_unit(port: int) -> str:
    """One dashboard serves every project on the host, and each port has its own."""
    return f"loop-watch-{port}.service"


def start_watch(repo: Path, port: int, restart: bool) -> None:
    """Starts the dashboard when it is not active, or restarts it on the loop's new code."""
    unit = watch_unit(port)
    if systemctl("is-active", unit, check=False).strip() == "active":
        if restart:
            systemctl("restart", unit)
        return
    run_in_unit(unit, repo, [sys.executable, "-m", "loop", "watch", "--repo", str(repo)], WATCH_PROPERTIES)


def run_in_unit(unit: str, cwd: Path, command: list[str], properties: tuple[str, ...]) -> None:
    env = [f"--setenv={name}={os.environ[name]}" for name in ENV if name in os.environ]
    options = [f"--property={item}" for item in properties]
    systemd_run = [
        "systemd-run", "--user", "--collect", "--quiet", "--service-type=exec", f"--unit={unit}",
        f"--working-directory={cwd}",
    ]  # fmt: skip
    try:
        result = process.run([*systemd_run, *env, *options, *command])
    except OSError as error:
        raise UnitError(f"systemd-run does not run: {error}") from error
    if result.returncode != 0:
        raise UnitError(f"systemd-run cannot start {unit}: {result.stderr.strip()}")


def systemctl(*args: str, check: bool = True) -> str:
    try:
        result = process.run(["systemctl", "--user", *args])
    except OSError as error:
        raise UnitError(f"systemctl does not run: {error}") from error
    if check and result.returncode != 0:
        raise UnitError(f"systemctl {' '.join(args)}: {result.stderr.strip()}")
    return result.stdout
