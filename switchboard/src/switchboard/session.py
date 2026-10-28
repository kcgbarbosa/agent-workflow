"""The one Claude Code session behind every call: a long-lived `claude -p` that reads and writes stream-json.

The session lives across calls, so it keeps what was said. Other sessions can message it by name, and a
message wakes it for a turn of its own. What it says in such a turn waits in `pending` until the next ask.
"""

from __future__ import annotations

import itertools
import json
import queue
import subprocess
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import IO, Any

# Each ask starts with this tag, so the reader can tell the turn that answers it from a turn a message woke.
TAG = "[voice:{}]"
# Said when the session has not answered yet, so the call does not go quiet.
FILLER = "One moment."
LATER = "This is taking a while. I'll tell you the rest when you ask."


class Session:
    def __init__(self, command: list[str], cwd: Path, state: Path) -> None:
        self.command = command
        self.cwd = cwd
        # The session ID, kept so a restart resumes the same conversation.
        self.state = state
        self.process: subprocess.Popen[str] | None = None
        self.lock = threading.Lock()
        self.ids = itertools.count(1)
        # The ask whose tag the open turn has seen, and the queue that ask reads its text from.
        self.current: int | None = None
        self.listeners: dict[int, queue.Queue[str | None]] = {}
        # What the session said with nobody asking: a reply from another session, or the end of a long turn.
        self.pending: list[str] = []
        # When KC last said something, for the start page.
        self.last_call: float | None = None

    def start(self) -> None:
        command = list(self.command)
        if self.state.exists() and (session_id := self.state.read_text().strip()):
            command += ["--resume", session_id]
        self.process = subprocess.Popen(
            command, cwd=self.cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1
        )
        assert self.process.stdout
        threading.Thread(target=self.read, args=(self.process.stdout,), daemon=True).start()

    def alive(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def status(self) -> dict[str, Any]:
        """What the start page shows: whether the session runs, when KC last talked, and what waits."""
        with self.lock:
            return {"session": self.alive(), "last_call": self.last_call, "waiting": len(self.pending)}

    def stop(self) -> None:
        if self.process:
            self.process.terminate()
            self.process.wait(10)

    def read(self, stdout: IO[str]) -> None:
        for line in stdout:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict):
                self.handle(event)
        with self.lock:
            # The process ended mid-turn. The ask hears that, and the next ask starts a new process.
            if self.current is not None and (listener := self.listeners.get(self.current)):
                listener.put("The session stopped. Ask again.")
                listener.put(None)
            self.current = None

    def handle(self, event: dict[str, Any]) -> None:
        if (session_id := event.get("session_id")) and event.get("type") == "system":
            self.state.parent.mkdir(parents=True, exist_ok=True)
            self.state.write_text(str(session_id))
        kind = event.get("type")
        with self.lock:
            if kind == "user":
                content = event.get("message", {}).get("content")
                if isinstance(content, str):
                    for ask in list(self.listeners):
                        if content.startswith(TAG.format(ask)):
                            self.current = ask
            elif kind == "assistant":
                for block in event.get("message", {}).get("content", []):
                    if block.get("type") == "text" and (text := block.get("text", "").strip()):
                        # A turn a message woke goes to the call that is listening now, if there is one.
                        if self.current is None:
                            listener = next(iter(self.listeners.values()), None)
                        else:
                            listener = self.listeners.get(self.current)
                        if listener:
                            listener.put(text)
                        else:
                            self.pending.append(text)
            elif kind == "result":
                if self.current is not None and (listener := self.listeners.get(self.current)):
                    listener.put(None)
                self.current = None

    def ask(self, text: str, first: float = 4.0, budget: float = 45.0) -> Iterator[str]:
        """The spoken answer to one thing KC said, a piece at a time.

        `first` is how long the call waits in silence before the filler, and `budget` how long it waits in
        all. After that the rest of the turn goes to `pending`, for the next ask.
        """
        with self.lock:
            if not self.alive():
                self.start()
            ask = next(self.ids)
            self.last_call = time.time()
            listener: queue.Queue[str | None] = queue.Queue()
            # A newer ask means KC moved on, so an older one that is still waiting stops listening.
            self.listeners = {ask: listener}
            updates, self.pending = self.pending, []
        yield from updates
        message = {"type": "user", "message": {"role": "user", "content": f"{TAG.format(ask)} {text}"}}
        assert self.process and self.process.stdin
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()
        start = time.monotonic()
        # An update already said keeps the call from going quiet, so it counts as speech.
        spoken = bool(updates)
        while True:
            wait = (first if not spoken else budget) - (time.monotonic() - start)
            try:
                piece = listener.get(timeout=max(wait, 0.01))
            except queue.Empty:
                if not spoken:
                    spoken = True
                    yield FILLER
                    continue
                yield LATER
                break
            if piece is None:
                break
            spoken = True
            yield piece
        with self.lock:
            self.listeners.pop(ask, None)
