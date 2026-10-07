"""What the loop needs from an issue tracker. A client keeps no state; the tracker holds the ticket graph."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


class TrackerError(Exception):
    pass


@dataclass(frozen=True)
class Blocker:
    key: str
    done: bool


@dataclass(frozen=True)
class Ticket:
    key: str
    summary: str
    issue_type: str
    status: str
    done: bool
    flagged: bool
    blockers: tuple[Blocker, ...]
    text: str


class Tracker(Protocol):
    def check_access(self) -> None: ...

    def issue(self, key: str) -> Ticket: ...

    def children(self, epic_key: str) -> list[Ticket]: ...

    def comments(self, key: str) -> list[str]:
        """The text of each comment on the ticket, oldest first."""
        ...

    def transition(self, key: str, status: str) -> bool:
        """Moves the ticket to the status. Returns False when no transition leads there."""
        ...

    def flag(self, key: str) -> None: ...

    def comment(self, key: str, text: str) -> None: ...

    def attach(self, key: str, files: list[Path]) -> None: ...
