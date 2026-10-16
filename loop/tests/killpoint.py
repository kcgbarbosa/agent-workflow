"""Kill points for the crash tests. A fake or a git hook names the point it has reached, and when
FAKE_CLAUDE_DIR/kill.json names that point, it sends a real signal to the `loop run` process.

kill.json holds `at`, a prefix of the point, `nth`, which time the point fires (1 by default), and `signal`
(SIGKILL by default). It fires once. The fire is logged in commands.jsonl, so a test can tell what the loop
did after it.
"""

from __future__ import annotations

import json
import os
import signal
from pathlib import Path


def reached(point: str) -> bool:
    """Whether the point fired."""
    fakes = Path(os.environ["FAKE_CLAUDE_DIR"])
    plan = fakes / "kill.json"
    if not plan.exists():
        return False
    spec = json.loads(plan.read_text())
    if not point.startswith(spec["at"]):
        return False
    seen = fakes / "kill.seen"
    count = int(seen.read_text()) + 1 if seen.exists() else 1
    seen.write_text(str(count))
    if count != spec.get("nth", 1):
        return False
    try:
        plan.rename(fakes / "kill.fired")
    except FileNotFoundError:
        return False
    with (fakes / "commands.jsonl").open("a") as calls:
        calls.write(
            json.dumps({"tool": "kill", "point": point, "signal": spec.get("signal", "SIGKILL")}) + "\n"
        )
    os.kill(int((fakes / "loop.pid").read_text()), signal.Signals[spec.get("signal", "SIGKILL")])
    return True
