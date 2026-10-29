"""The one Claude Code session behind every call: a long-lived `claude -p` that reads and writes stream-json.

The session lives across calls, so it keeps what was said. Other sessions can message it by name, and a
message wakes it for a turn of its own. What it says in such a turn waits in `pending` until the next ask.
"""

from __future__ import annotations

import itertools
import json
import subprocess
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any

# Each ask starts with this tag, so the reader can tell the turn that answers it from a turn a message woke.
TAG = "[voice:{}]"
# Said when the session has not answered yet. ElevenLabs gives up on a custom LLM that sends nothing for
# about 4 seconds and asks again, so the first words go out well before that.
FILLER = "One moment..."
# Said every so often while a long turn runs, so the call does not go quiet.
STILL = "Still working on it..."
LATER = "This is taking a while. I'll tell you the rest when you ask."
# ElevenLabs sends the same words again when it retries. Within this many seconds of the first, a request with
# the same words hears that ask's answer instead of starting a second turn.
RETRY = 30.0


@dataclass
class Ask:
    id: int
    text: str
    started: float
    # What the session has said for this ask so far. Every request for it reads from the start.
    pieces: list[str] = field(default_factory=list)
    done: bool = False


class Session:
    def __init__(self, command: list[str], cwd: Path, state: Path) -> None:
        self.command = command
        self.cwd = cwd
        # The session ID, kept so a restart resumes the same conversation.
        self.state = state
        self.process: subprocess.Popen[str] | None = None
        self.lock = threading.Condition()
        self.ids = itertools.count(1)
        # The newest ask, and the one the open turn answers, by the tag the turn saw.
        self.latest: Ask | None = None
        self.asks: dict[int, Ask] = {}
        self.current: Ask | None = None
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
            if self.current and not self.current.done:
                self.current.pieces.append("The session stopped. Ask again.")
                self.current.done = True
            self.current = None
            self.lock.notify_all()

    def listening(self) -> Ask | None:
        """The ask a call is still waiting on, which hears a turn that a message woke."""
        return self.latest if self.latest and not self.latest.done else None

    def handle(self, event: dict[str, Any]) -> None:
        if (session_id := event.get("session_id")) and event.get("type") == "system":
            self.state.parent.mkdir(parents=True, exist_ok=True)
            self.state.write_text(str(session_id))
        kind = event.get("type")
        with self.lock:
            if kind == "user":
                content = event.get("message", {}).get("content")
                if isinstance(content, str):
                    for ask in self.asks.values():
                        if content.startswith(TAG.format(ask.id)):
                            self.current = ask
            elif kind == "assistant":
                for block in event.get("message", {}).get("content", []):
                    if block.get("type") == "text" and (text := block.get("text", "").strip()):
                        target = self.current or self.listening()
                        # Text for an ask KC has moved on from waits for the next one.
                        if target and target is self.latest and not target.done:
                            target.pieces.append(text)
                        else:
                            self.pending.append(text)
            elif kind == "result":
                if self.current:
                    self.current.done = True
                self.current = None
            self.lock.notify_all()

    def submit(self, text: str) -> tuple[Ask, list[str]]:
        """The ask for these words, and the updates to say first. A retry joins the ask it repeats."""
        with self.lock:
            now = time.monotonic()
            latest = self.latest
            if latest and latest.text == text and now - latest.started < RETRY:
                return latest, []
            if not self.alive():
                self.start()
            ask = Ask(next(self.ids), text, now)
            self.latest, self.asks = ask, {ask.id: ask}
            self.last_call = time.time()
            updates, self.pending = self.pending, []
        message = {"type": "user", "message": {"role": "user", "content": f"{TAG.format(ask.id)} {text}"}}
        assert self.process and self.process.stdin
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()
        return ask, updates

    def ask(self, text: str, first: float = 1.0, every: float = 10.0, budget: float = 45.0) -> Iterator[str]:
        """The spoken answer to one thing KC said, a piece at a time.

        `first` is how long the call waits in silence before the filler, `every` how often it hears that the
        work goes on, and `budget` how long it waits in all. After that the rest goes to `pending`.
        """
        ask, updates = self.submit(text)
        yield from updates
        start = last = time.monotonic()
        said = 0
        quiet = not updates
        while True:
            with self.lock:
                now = time.monotonic()
                if said < len(ask.pieces):
                    piece, real = ask.pieces[said], True
                elif ask.done or ask is not self.latest:
                    return
                elif now - start >= budget:
                    # The rest of this turn goes to pending, for the next ask.
                    self.latest = None
                    piece, real = LATER, False
                elif (gap := (first if quiet else every) - (now - last)) > 0:
                    self.lock.wait(min(gap, budget - (now - start)))
                    continue
                else:
                    piece, real = (FILLER if quiet else STILL), False
            said += real
            quiet = False
            last = time.monotonic()
            yield piece
            if piece == LATER and not real:
                return
