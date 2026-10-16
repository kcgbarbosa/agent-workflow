"""The `loop` command. It builds one Epic unattended, with the settings in the repo's `loop.toml`.

loop start <Epic key>   starts a run as a systemd user unit
loop stop <Epic key>    stops the run, which logs `stopped` and stops its stacks
loop run <Epic key>     the run itself, which the unit runs
loop secrets            copies the secrets from Bitwarden to this host, after `bw unlock`
loop watch              serves a web page of the runs on this host, as the service that `loop start` starts
loop report [<Epic key>] breaks down what the latest run cost, against the run before it on this host
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from . import config as config_file
from . import process, report, units
from . import watch as watch_page
from .claude import MIN_CLAUDE, claude_version
from .config import Config, ConfigError
from .forecast import Forecaster
from .run import run
from .tracker import TrackerError
from .units import UnitError
from .update import Stale, source_checkout, update

TOOLS = ("git", "claude", "gh", "systemd-inhibit")
SECRETS_FILE = watch_page.SECRETS_FILE
# A check such as `docker info` or `bw status` that has not answered by then is taken as failed.
QUIET_SECONDS = 120
NO_SECRETS = "Run `export BW_SESSION=$(bw unlock --raw)`, then `loop secrets`."


class Refused(Exception):
    pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="loop", description="Builds one Epic unattended.")
    parser.add_argument("command", choices=("start", "stop", "run", "secrets", "watch", "report"))
    parser.add_argument("epic", metavar="<Epic key>", nargs="?")
    parser.add_argument(
        "--against", metavar="<Epic key>", help="report: compare with this Epic's latest run instead"
    )
    parser.add_argument(
        "--on",
        metavar="<branch>",
        help="start, run: stack the Epic on this branch, such as an Epic PR that is not merged yet",
    )
    parser.add_argument("--json", action="store_true", help="report: print JSON")
    parser.add_argument("--repo", type=Path, help="the main checkout. Defaults to the one around this folder")
    args = parser.parse_args(argv)
    if args.command in ("start", "stop", "run") and not re.fullmatch(units.EPIC_KEY, args.epic or ""):
        command = args.command
        print(f"Usage: loop {command} <Epic key>, for example loop {command} TIDE-42", file=sys.stderr)
        return 2
    try:
        repo = args.repo.resolve() if args.repo else main_checkout()
        if args.command == "start":
            new_code = False
            if (checkout := source_checkout()) is not None:
                updated = update(checkout)
                print(updated.message, flush=True)
                new_code = updated.new_code
            return start(repo, args.epic, args.on, new_code)
        if args.command == "stop":
            return stop(repo, args.epic)
        config = config_file.load(repo)
        if args.command == "secrets":
            return copy_secrets(config)
        if args.command == "watch":
            return watch(config)
        if args.command == "report":
            return print_report(config, args.epic, args.against, args.json)
        check_tools(config)
        secrets = read_secrets(config)
        check_services(config, secrets)
        with awake(config.name, args.epic):
            return run(args.epic, config, secrets, args.on)
    except (Refused, ConfigError, Stale, UnitError) as error:
        print(f"The loop refuses to run. {error}", file=sys.stderr)
        return 2


def main_checkout() -> Path:
    """The main checkout of the repo around this folder, also from inside one of its worktrees."""
    result = process.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"])
    if result.returncode != 0:
        raise Refused("This folder is not in a git checkout. Run the loop from the repo, or pass --repo.")
    return Path(result.stdout.strip()).parent


def check_tools(config: Config) -> None:
    """Every prerequisite, before the run starts."""
    needed = (*TOOLS, *config.tools, *(["docker"] if config.stack else []))
    missing = [tool for tool in dict.fromkeys(needed) if shutil.which(tool) is None]
    if missing:
        raise Refused(f"These commands are missing: {', '.join(missing)}.")
    problems = []
    if old_claude := claude_problem(claude_version()):
        problems.append(old_claude)
    if config.stack and _quiet(["docker", "info"]) != 0:
        problems.append("Docker does not answer. Start Docker, or check the docker group.")
    if _quiet(["gh", "auth", "status"]) != 0:
        problems.append("The GitHub CLI is not signed in. Run `gh auth login`.")
    if problems:
        raise Refused(" ".join(problems))


def claude_problem(version: str) -> str | None:
    """Why the loop cannot run this `claude`, or None when it can."""
    if tuple(int(part) for part in version.split(".") if part) >= MIN_CLAUDE:
        return None
    needed = ".".join(map(str, MIN_CLAUDE))
    shown = version or "a version that does not print"
    return f"`claude` is {shown}, and the loop needs {needed} or later. Run `claude update`."


def secrets_file(config: Config) -> Path:
    return config.state_dir / SECRETS_FILE


def bitwarden_unlocked() -> bool:
    status = process.run(["bw", "status"], seconds=QUIET_SECONDS).stdout
    return '"status":"unlocked"' in status.replace(" ", "")


def copy_secrets(config: Config) -> int:
    """Writes the secrets to a file that only this user can read, so that a run needs no unlock."""
    if shutil.which("bw") is None or not bitwarden_unlocked():
        raise Refused("Bitwarden is locked. Run `export BW_SESSION=$(bw unlock --raw)` first.")
    secrets = bitwarden_secrets(config)
    path = secrets_file(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    # O_CREAT sets the mode only on a new file.
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w") as file:
        json.dump(secrets, file)
    print(f"The {config.name} secrets are in {path}. A run needs no unlock now.")
    return 0


def read_secrets(config: Config) -> dict[str, str]:
    """The secrets from the file of `loop secrets`, the only place a run reads them."""
    path = secrets_file(config)
    if not path.exists():
        raise Refused(f"This host has no secrets file. {NO_SECRETS}")
    secrets = json.loads(path.read_text())
    missing = [env for env in config.secrets if not secrets.get(env)]
    if missing:
        raise Refused(f"{path} has no value for {', '.join(missing)}. {NO_SECRETS}")
    return {env: secrets[env] for env in config.secrets}


def bitwarden_secrets(config: Config) -> dict[str, str]:
    _quiet(["bw", "sync"])
    secrets: dict[str, str] = {}
    missing: list[str] = []
    for env, secret in config.secrets.items():
        result = process.run(["bw", "get", secret.field, secret.item], seconds=QUIET_SECONDS)
        if result.returncode == 0 and result.stdout.strip():
            secrets[env] = result.stdout.strip()
        else:
            missing.append(f"{secret.item} ({secret.field})")
    if missing:
        raise Refused(f"Bitwarden has no value for {', '.join(missing)}.")
    return secrets


def check_services(config: Config, secrets: dict[str, str]) -> None:
    try:
        config.tracker(secrets).check_access()
    except TrackerError as error:
        changed = " If a secret changed, run `loop secrets` again." if secrets_file(config).exists() else ""
        raise Refused(f"The tracker refuses the credentials: {error}{changed}") from error
    if _quiet(["git", "ls-remote", "--exit-code", "origin", "HEAD"], cwd=config.repo) != 0:
        raise Refused("The remote origin does not answer.")


@contextmanager
def awake(name: str, epic_key: str) -> Iterator[None]:
    """Holds off sleep until this process ends. It runs beside the run, which is the unit's main process
    (loop.md rule 12)."""
    command = [
        "systemd-inhibit", "--what=sleep:idle", f"--who={name}-loop",
        f"--why=The loop builds {epic_key}", "--mode=block",
        "tail", f"--pid={os.getpid()}", "-f", "/dev/null",
    ]  # fmt: skip
    inhibitor = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        inhibitor.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    else:
        message = inhibitor.stderr.read().decode() if inhibitor.stderr else ""
        raise Refused(f"`systemd-inhibit` cannot hold off sleep: {message.strip()}")
    try:
        yield
    finally:
        inhibitor.terminate()


def start(repo: Path, epic_key: str, base: str | None, new_code: bool) -> int:
    """Starts the run as a systemd user unit, so it outlives the agent or shell that starts it, and the
    dashboard as a user service. The run checks the rest of the prerequisites itself."""
    name, port = config_file.peek(repo)
    if not (config_file.state_dir_of(name) / SECRETS_FILE).exists():
        raise Refused(f"This host has no secrets file. {NO_SECRETS}")
    if active := units.runs(name):
        unit = units.run_unit(name, active[0])
        raise Refused(f"A run is active: {unit}. `loop stop {active[0]}` stops it.")
    unit = units.start_run(repo, name, epic_key, base)
    units.start_watch(repo, port, restart=new_code)
    page = open_watch(port, name, epic_key)
    print(f"The loop is building {epic_key}. Watch it at {page}, or with `journalctl --user -fu {unit}`.")
    return 0


def stop(repo: Path, epic_key: str) -> int:
    name, _ = config_file.peek(repo)
    if not units.stop_run(name, epic_key):
        print(f"No run of {epic_key} is active.", file=sys.stderr)
        return 1
    print(f"The loop stopped {epic_key}. `loop start {epic_key}` goes on with the same tickets.")
    return 0


def watch(config: Config) -> int:
    """Serves the page until the process stops. It changes nothing the loop reads."""
    forecast = Forecaster(config)
    try:
        servers = watch_page.serve(config.state_dir, config.watch_port, forecast=forecast)
    except OSError as error:
        raise Refused(f"loop watch cannot listen on port {config.watch_port}: {error}") from error
    for server in servers:
        host = str(server.server_address[0])
        print(f"loop watch serves the {config.name} runs at http://{host}:{config.watch_port}/")
    sys.stdout.flush()
    forecast.start()
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
    return 0


def print_report(config: Config, epic_key: str | None, against: str | None, as_json: bool) -> int:
    """The breakdown of what a run cost, against the run before it, from the logs on this host."""
    found = watch_page.comparison(config.state_dir, epic_key, against)
    if found is None:
        print(
            f"This host has no run of {epic_key}." if epic_key else "This host has no run.", file=sys.stderr
        )
        return 1
    if as_json:
        print(json.dumps(found, indent=1))
    else:
        print(report.text(found["current"], found["previous"], found["rows"]))
    return 0


def open_watch(port: int, name: str, epic_key: str) -> str:
    """Opens the page on this host's screen, and returns its tailnet address, which opens on any device in the
    tailnet."""
    opener = "xdg-open"
    if (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")) and shutil.which(opener):
        subprocess.Popen(
            [opener, watch_page.url(port, epic_key, project=name)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )  # fmt: skip
    return watch_page.url(port, epic_key, watch_page.addresses()[-1], name)


def _quiet(command: list[str], cwd: Path | None = None) -> int:
    return process.run(command, cwd, seconds=QUIET_SECONDS).returncode
