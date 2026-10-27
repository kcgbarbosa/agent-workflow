"""`switchboard`: starts the session and serves it. README.md is how it is set up."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .server import server
from .session import Session

PROMPT = Path(__file__).with_name("prompt.md")


def command(model: str | None) -> list[str]:
    command = [
        "claude", "-p", "--verbose",
        "--input-format", "stream-json", "--output-format", "stream-json", "--replay-user-messages",
        # The mode of KC's Remote Control sessions. A message from another mode waits for approval.
        "--permission-mode", "auto",
        # The name other sessions message it by.
        "--name", "switchboard",
        "--append-system-prompt", PROMPT.read_text(),
    ]  # fmt: skip
    if model:
        command += ["--model", model]
    return command


def main() -> None:
    parser = argparse.ArgumentParser(prog="switchboard", description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--cwd", type=Path, default=Path.home() / "dev" / "agent-workflow")
    state = Path.home() / ".local" / "state" / "switchboard" / "session"
    parser.add_argument("--state", type=Path, default=state)
    parser.add_argument("--model", default=os.environ.get("SWITCHBOARD_MODEL"))
    args = parser.parse_args()
    token = os.environ.get("SWITCHBOARD_TOKEN", "")
    if len(token) < 32:
        sys.exit("Set SWITCHBOARD_TOKEN to a secret of 32 characters or more. See switchboard/README.md.")
    session = Session(command(args.model), args.cwd, args.state)
    session.start()
    print(f"switchboard on http://{args.host}:{args.port}", flush=True)
    server(session, token, args.host, args.port).serve_forever()
