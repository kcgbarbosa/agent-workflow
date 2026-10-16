"""The one function that starts each command a run waits for (loop.md rule 3)."""

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

# The scenario tests shorten the minute, so a limit in loop.toml, and the grace time, pass in seconds.
MINUTE = 60.0
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
    seconds: float | None = None,
    stdout: Path | None = None,
    stderr: Path | Literal["stdout"] | None = None,
    stop: Callable[[], bool] | None = None,
    on_kill: Callable[[], object] | None = None,
) -> Finished:
    """Runs the command to its end, to its limit, or until `stop` returns True.

    A named file gets the stream, and an unnamed stream comes back as text. After the loop ends the process
    group at the limit or a stop, `on_kill` runs.
    """
    deadline = None if seconds is None else time.monotonic() + seconds
    with ExitStack() as files:
        out = files.enter_context(open_stream(stdout))
        err = subprocess.STDOUT if stderr == "stdout" else files.enter_context(open_stream(stderr))
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
            returncode = end_group(process)
            break
        if timed_out and seconds is not None:
            log = out if isinstance(err, int) else err
            log.seek(0, os.SEEK_END)
            log.write(f"`{command[0]}` ran past its time limit of {seconds / MINUTE:g} min.\n")
        if (timed_out or stopped) and on_kill:
            on_kill()
        return Finished(returncode, captured(out, stdout), captured(err, stderr), timed_out, stopped)


def end_group(process: subprocess.Popen[bytes]) -> int:
    """SIGTERM to the process group, then SIGKILL to what is left after a minute."""
    send(process, signal.SIGTERM)
    deadline = time.monotonic() + MINUTE
    while time.monotonic() < deadline:
        process.poll()
        if not group_alive(process):
            return process.wait()
        time.sleep(0.2)
    send(process, signal.SIGKILL)
    return process.wait()


def send(process: subprocess.Popen[bytes], number: signal.Signals) -> None:
    try:
        os.killpg(process.pid, number)
    except ProcessLookupError:
        pass


def group_alive(process: subprocess.Popen[bytes]) -> bool:
    try:
        os.killpg(process.pid, 0)
    except ProcessLookupError:
        return False
    return True


def open_stream(path: Path | None) -> IO[str]:
    return path.open("w") if path else tempfile.TemporaryFile("w+", errors="replace")


def captured(file: IO[str] | int, path: Path | str | None) -> str:
    """The text of a stream that went to no file the caller named."""
    if path is not None or isinstance(file, int):
        return ""
    file.seek(0)
    return file.read()
