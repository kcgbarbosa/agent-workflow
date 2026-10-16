"""The one way the loop starts a child process (loop.md rule 3).

Each child gets a session of its own and `/dev/null` as stdin, so it has no controlling terminal: a terminal
can never stop it, and a signal to its process group reaches every process it started. Its output goes to
files, so the loop waits on no pipe that a grandchild holds open.
"""

from __future__ import annotations

import os
import signal
import subprocess
import tempfile
import time
from collections.abc import Callable, Mapping, Sequence
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Literal

# The scenario tests shorten the minute, so a limit in loop.toml can pass in seconds.
MINUTE = 60.0
GRACE_SECONDS = 60.0
POLL_SECONDS = 2.0


@dataclass
class Finished:
    returncode: int
    # Empty when the stream went to a file the caller named.
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False
    stopped: bool = False

    @property
    def ok(self) -> bool:
        """Exit code 0 within the limit. A process can exit 0 on the SIGTERM at its limit."""
        return self.returncode == 0 and not self.timed_out


def run(
    command: Sequence[str],
    cwd: Path | None = None,
    env: Mapping[str, str] | None = None,
    *,
    minutes: float | None = None,
    stdout: Path | None = None,
    stderr: Path | Literal["stdout"] | None = None,
    stop: Callable[[], bool] | None = None,
    on_kill: Callable[[], object] | None = None,
) -> Finished:
    """Runs the command to its end, or to its limit in minutes, or until `stop` returns True.

    A named file gets the stream, and an unnamed stream comes back as text. At the limit or a stop, the
    whole process group ends (SIGTERM, then SIGKILL after the grace time), then `on_kill` runs, such as a
    `docker compose down`, because containers run under dockerd and outlive the group.
    """
    deadline = None if minutes is None else time.monotonic() + minutes * MINUTE
    with ExitStack() as files:
        out = files.enter_context(stream(stdout))
        err = subprocess.STDOUT if stderr == "stdout" else files.enter_context(stream(stderr))
        process = subprocess.Popen(
            command, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
            start_new_session=True,
        )  # fmt: skip
        timed_out = stopped = False
        while True:
            waits = [POLL_SECONDS] if stop else []
            if deadline is not None:
                waits.append(max(0.0, deadline - time.monotonic()))
            try:
                returncode = process.wait(timeout=min(waits) if waits else None)
                break
            except subprocess.TimeoutExpired:
                pass
            if deadline is not None and time.monotonic() >= deadline:
                timed_out = True
            elif stop and stop():
                stopped = True
            else:
                continue
            returncode = end(process)
            break
        if timed_out:
            log = out if isinstance(err, int) else err
            log.seek(0, os.SEEK_END)
            log.write(f"`{command[0]}` ran past its limit of {minutes:g} minutes.\n")
        if (timed_out or stopped) and on_kill:
            on_kill()
        return Finished(returncode, text(out, stdout), text(err, stderr), timed_out, stopped)


def end(process: subprocess.Popen[bytes]) -> int:
    """Ends the process group: SIGTERM, then SIGKILL to what is left after the grace time."""
    signal_group(process, signal.SIGTERM)
    deadline = time.monotonic() + GRACE_SECONDS
    while time.monotonic() < deadline:
        process.poll()
        if not signal_group(process, 0):
            return process.wait()
        time.sleep(0.2)
    signal_group(process, signal.SIGKILL)
    return process.wait()


def signal_group(process: subprocess.Popen[bytes], number: int) -> bool:
    """Sends the signal to the group. Returns False when no process of the group is left."""
    try:
        os.killpg(process.pid, number)
    except ProcessLookupError:
        return False
    return True


def stream(path: Path | None) -> IO[str]:
    return path.open("w") if path else tempfile.TemporaryFile("w+", errors="replace")


def text(file: IO[str] | int, named: object) -> str:
    if named is not None or isinstance(file, int):
        return ""
    file.seek(0)
    return file.read()
