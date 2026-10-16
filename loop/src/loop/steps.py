"""Where a ticket is, from its lines in `decisions.jsonl` (loop.md rule 9)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

STEPS = ("build", "ticket-gate", "code-review", "ui-gate", "land")
# The UI review results that let the ticket land.
UI_PASSED = ("pass", "open")


def next_step(lines: list[dict[str, Any]], head: str, ui: Callable[[str], bool] | None) -> str:
    """The ticket's first step with no pass at `head`. `ui` tells whether a commit has the ticket's UI
    change at `head`, and is None when the ticket changes no UI path. Land never passes here, because a
    landed ticket is off the frontier."""
    results = [line for line in lines if line.get("step") in STEPS and line.get("result") != "started"]
    at_head = [line for line in results if line.get("commit") == head]

    def passed(step: str) -> bool:
        if step in ("build", "ticket-gate"):
            return any(line["step"] == step and line["result"] == "pass" for line in at_head)
        if step == "code-review":
            reviews = [n for n, line in enumerate(at_head) if line["step"] == step]
            if not reviews:
                return False
            last = at_head[reviews[-1]]
            # Findings that a later build answered with no commit are the agent's to keep.
            answered = any(line["step"] == "build" for line in at_head[reviews[-1] :])
            return last["result"] == "pass" or (last["result"] == "findings" and answered)
        if step == "ui-gate":
            return ui is None or any(
                line["step"] == step and line["result"] in UI_PASSED and ui(str(line.get("commit")))
                for line in results
            )
        return False

    return next(step for step in STEPS if not passed(step))
