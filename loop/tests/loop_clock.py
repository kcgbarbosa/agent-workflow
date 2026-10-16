"""`loop` as `python -m loop` runs it, with a clock that skips each wait of 5 seconds or more.

The scenario tests run `loop run` through this file, so a pause for a usage limit takes no time. Each skipped
wait goes to FAKE_CLAUDE_DIR/sleeps.jsonl.
"""

import json
import os
import sys
import time
from pathlib import Path
from typing import SupportsFloat, SupportsIndex

real_sleep = time.sleep


def sleep(seconds: SupportsFloat | SupportsIndex) -> None:
    if float(seconds) < 5:
        real_sleep(float(seconds))
        return
    with Path(os.environ["FAKE_CLAUDE_DIR"], "sleeps.jsonl").open("a") as sleeps:
        sleeps.write(json.dumps({"seconds": float(seconds)}) + "\n")


# The clock changes before the loop imports, because a module can bind `time.sleep` when it loads.
time.sleep = sleep

from loop.cli import main  # noqa: E402

sys.exit(main())
