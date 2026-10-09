"""The `loop` command. It builds one Epic unattended, with the settings in the repo's `loop.toml`.

loop start <Epic key>   starts a run in its own tmux session
loop run <Epic key>     the run itself, which `loop start` runs in that session
loop secrets            copies the secrets from Bitwarden to this host, after `bw unlock`
loop watch              serves a web page of the runs on this host, which `loop start` opens
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from . import config as config_file
from . import watch as watch_page
from .config import Config, ConfigError
from .run import run
from .tracker import TrackerError
from .update import Stale, source_checkout, update

TOOLS = ("git", "claude", "gh", "timeout")
SECRETS_FILE = watch_page.SECRETS_FILE
RUN_LOCK = watch_page.RUN_LOCK
START_POLLS = 60
START_POLL_SECONDS = 2
WATCH_POLLS = 20


class Refused(Exception):
    pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="loop", description="Builds one Epic unattended.")
    parser.add_argument("command", choices=("start", "run", "secrets", "watch"))
    parser.add_argument("epic", metavar="<Epic key>", nargs="?")
    parser.add_argument("--repo", type=Path, help="the main checkout. Defaults to the one around this folder")
    arguments = sys.argv[1:] if argv is None else argv
    args = parser.parse_args(arguments)
    if args.command in ("start", "run") and not re.fullmatch(r"[A-Z]+-\d+", args.epic or ""):
        print("Usage: loop start <Epic key>, for example loop start PITCH-42", file=sys.stderr)
        return 2
    try:
        repo = args.repo.resolve() if args.repo else main_checkout()
        if args.command == "start" and (checkout := source_checkout()) is not None:
            updated = update(checkout)
            print(updated.message, flush=True)
            if updated.new_code:
                # This process still runs the old code, which can refuse a loop.toml key that is new.
                os.execv(sys.executable, [sys.executable, "-m", "loop", *arguments])
        config = config_file.load(repo)
        if args.command == "secrets":
            return copy_secrets(config)
        if args.command == "watch":
            return watch(config)
        if args.command == "start":
            return start(args.epic, config)
        check_tools(config)
        secrets = read_secrets(config)
        check_services(config, secrets)
        with one_run(config.state_dir, args.epic), awake(config.name, args.epic):
            return run(args.epic, config, secrets)
    except (Refused, ConfigError, Stale) as error:
        print(f"The loop refuses to run. {error}", file=sys.stderr)
        return 2


def main_checkout() -> Path:
    """The main checkout of the repo around this folder, also from inside one of its worktrees."""
    result = subprocess.run(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], capture_output=True, text=True
    )
    if result.returncode != 0:
        raise Refused("This folder is not in a git checkout. Run the loop from the repo, or pass --repo.")
    return Path(result.stdout.strip()).parent


def check_tools(config: Config) -> None:
    """Every prerequisite, before the run starts."""
    inhibitor = "caffeinate" if sys.platform == "darwin" else "systemd-inhibit"
    bitwarden = not secrets_file(config).exists()
    needed = (
        *TOOLS,
        *(["bw"] if bitwarden else []),
        *config.tools,
        *(["docker"] if config.stack else []),
        inhibitor,
    )
    missing = [tool for tool in dict.fromkeys(needed) if shutil.which(tool) is None]
    if missing:
        raise Refused(f"These commands are missing: {', '.join(missing)}.")
    problems = []
    if config.stack and _quiet(["docker", "info"]) != 0:
        problems.append("Docker does not answer. Start Docker, or check the docker group.")
    if _quiet(["gh", "auth", "status"]) != 0:
        problems.append("The GitHub CLI is not signed in. Run `gh auth login`.")
    if bitwarden and not bitwarden_unlocked():
        problems.append(
            "Bitwarden is locked. Run `export BW_SESSION=$(bw unlock --raw)`, then `loop secrets`."
        )
    if problems:
        raise Refused(" ".join(problems))


def secrets_file(config: Config) -> Path:
    return config.state_dir / SECRETS_FILE


def bitwarden_unlocked() -> bool:
    status = subprocess.run(["bw", "status"], capture_output=True, text=True).stdout
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
    """The secrets from the file of `loop secrets`, or else from Bitwarden."""
    path = secrets_file(config)
    if not path.exists():
        return bitwarden_secrets(config)
    secrets = json.loads(path.read_text())
    missing = [env for env in config.secrets if not secrets.get(env)]
    if missing:
        raise Refused(
            f"{path} has no value for {', '.join(missing)}. "
            "Run `export BW_SESSION=$(bw unlock --raw)`, then `loop secrets`."
        )
    return {env: secrets[env] for env in config.secrets}


def bitwarden_secrets(config: Config) -> dict[str, str]:
    _quiet(["bw", "sync"])
    secrets: dict[str, str] = {}
    missing: list[str] = []
    for env, secret in config.secrets.items():
        result = subprocess.run(["bw", "get", secret.field, secret.item], capture_output=True, text=True)
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
def one_run(state_dir: Path, epic_key: str) -> Iterator[None]:
    """Refuses a second run of this repo on this host. KC keeps to one run across hosts."""
    state_dir.mkdir(parents=True, exist_ok=True)
    with (state_dir / RUN_LOCK).open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Refused("Another run is active on this host.") from error
        # `loop watch` reads which run is active from the lock, and does not take the lock itself.
        lock.truncate(0)
        lock.write(json.dumps({"pid": os.getpid(), "epic": epic_key}))
        lock.flush()
        try:
            yield
        finally:
            lock.truncate(0)


@contextmanager
def awake(name: str, epic_key: str) -> Iterator[None]:
    """Holds off sleep until this process ends."""
    pid = str(os.getpid())
    if sys.platform == "darwin":
        command = ["caffeinate", "-ims", "-w", pid]
    else:
        command = [
            "systemd-inhibit", "--what=sleep:idle", f"--who={name}-loop",
            f"--why=The loop builds {epic_key}", "--mode=block",
            "tail", f"--pid={pid}", "-f", "/dev/null",
        ]  # fmt: skip
    inhibitor = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        inhibitor.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    else:
        message = inhibitor.stderr.read().decode() if inhibitor.stderr else ""
        raise Refused(f"`{command[0]}` cannot hold off sleep: {message.strip()}")
    try:
        yield
    finally:
        inhibitor.terminate()


def start(epic_key: str, config: Config) -> int:
    """Starts `loop run` in its own tmux session, so the run outlives the agent or shell that starts it."""
    bw_session = os.environ.get("BW_SESSION")
    if not bw_session and not secrets_file(config).exists():
        raise Refused(
            "This host has no secrets file. Run `export BW_SESSION=$(bw unlock --raw)`, then `loop secrets`."
        )
    if shutil.which("tmux") is None:
        raise Refused("tmux is missing.")
    session = f"{config.name}-loop"
    target = f"={session}:"
    if _quiet(["tmux", "has-session", "-t", f"={session}"]) == 0:
        if _tmux(["display-message", "-p", "-t", target, "#{pane_dead}"]) == "1":
            _tmux(["kill-session", "-t", f"={session}"])
        else:
            raise Refused(f"A loop run is active. See it with `tmux attach -t {session}`.")
    command = shlex.join([sys.executable, "-m", "loop", "run", epic_key, "--repo", str(config.repo)])
    repo = str(config.repo)
    _tmux(["new-session", "-d", "-s", session, "-c", repo])
    _tmux(["set-option", "-p", "-t", target, "remain-on-exit", "on"])
    # A tmux pane takes its env from the tmux server, so BW_SESSION goes in with -e.
    session_env = ["-e", f"BW_SESSION={bw_session}"] if bw_session else []
    _tmux(["respawn-pane", "-k", "-t", target, "-c", repo, *session_env, command])

    # The run prints "<time> <Epic key> start ok" once its checks pass. A refusal ends the pane first.
    # A short run can also end before the first look, so the line counts before the dead pane does.
    for _ in range(START_POLLS):
        time.sleep(START_POLL_SECONDS)
        dead = _tmux(["display-message", "-p", "-t", target, "#{pane_dead}"]) == "1"
        pane = _tmux(["capture-pane", "-p", "-S", "-", "-t", target])
        if f" {epic_key} start ok" in pane:
            page = open_watch(config, epic_key)
            print(f"The loop is building {epic_key}. Watch it at {page}, or with `tmux attach -t {session}`.")
            return 0
        if dead:
            print("\n".join(line for line in pane.splitlines() if line), file=sys.stderr)
            print("The loop did not start.", file=sys.stderr)
            return 1
    print(
        f"The loop has not started after 2 minutes. See it with `tmux attach -t {session}`.", file=sys.stderr
    )
    return 1


def watch(config: Config) -> int:
    """Serves the page until the process stops. It reads the state folder and changes nothing."""
    try:
        servers = watch_page.serve(config.state_dir, config.watch_port)
    except OSError as error:
        raise Refused(f"loop watch cannot listen on port {config.watch_port}: {error}") from error
    for server in servers:
        host = str(server.server_address[0])
        print(f"loop watch serves the {config.name} runs at http://{host}:{config.watch_port}/")
    sys.stdout.flush()
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
    return 0


def open_watch(config: Config, epic_key: str) -> str:
    """Starts `loop watch` when nothing answers on its port, opens the page, and returns its address."""
    page = watch_page.url(config.watch_port, epic_key)
    if not watch_answers(config.watch_port):
        session = f"{config.name}-watch"
        # A session whose server does not answer is left from a watch that failed.
        _tmux(["kill-session", "-t", f"={session}"])
        command = shlex.join([sys.executable, "-m", "loop", "watch", "--repo", str(config.repo)])
        _tmux(["new-session", "-d", "-s", session, "-c", str(config.repo), command])
        for _ in range(WATCH_POLLS):
            if watch_answers(config.watch_port):
                break
            time.sleep(0.25)
    opener = "open" if sys.platform == "darwin" else "xdg-open"
    display = sys.platform == "darwin" or os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
    if display and shutil.which(opener):
        subprocess.Popen(
            [opener, page], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True
        )
    # 127.0.0.1 opens only on this host. The tailnet address also opens on the phone and the other host.
    return watch_page.url(config.watch_port, epic_key, watch_page.addresses()[-1])


def watch_answers(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/epics", timeout=2):
            return True
    except OSError:
        return False


def _tmux(args: list[str]) -> str:
    return subprocess.run(["tmux", *args], capture_output=True, text=True).stdout.strip()


def _quiet(command: list[str], cwd: Path | None = None) -> int:
    return subprocess.run(command, cwd=cwd, capture_output=True).returncode
