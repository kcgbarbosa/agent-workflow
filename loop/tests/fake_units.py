"""The units of the fake `systemd-run`, which the fake `systemctl` reads too."""

from __future__ import annotations

import json
import os
from pathlib import Path

UNITS = Path(os.environ.get("FAKE_CLAUDE_DIR", ".")) / "units"


def alive(unit: str, units: Path = UNITS) -> bool:
    """Whether the unit is loaded: its process lives, or it runs no process, as the fake dashboard."""
    state = units / f"{unit}.json"
    if not state.exists():
        return False
    pid = json.loads(state.read_text())["pid"]
    if pid is None:
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True
