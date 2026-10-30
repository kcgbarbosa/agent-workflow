"""A fake `gh` that keeps a pull request's reviews and comments in a JSON file, and a fake `claude` that replays answers.

The gate's review and judge tests put both on PATH, so no test reaches GitHub or a model.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

GH = """
import json, re, sys
state_path = {state!r}
state = json.load(open(state_path))
args = sys.argv[2:]
method = args[args.index("-X") + 1] if "-X" in args else "GET"
endpoint = next(a for i, a in enumerate(args) if not a.startswith("-") and (i == 0 or args[i - 1] not in ("-X", "--jq", "--input")))
payload = json.load(sys.stdin) if "--input" in args else None
state["calls"].append([method, endpoint, payload])

def lines(items):
    for item in items:
        print(json.dumps(item))

if method == "GET" and endpoint.endswith("/reviews"):
    lines({{k: v for k, v in r.items() if k != "comments"}} for r in state["reviews"])
elif method == "GET" and endpoint.endswith("/comments") and "/reviews/" in endpoint:
    review_id = int(endpoint.split("/")[-2])
    lines(next(r["comments"] for r in state["reviews"] if r["id"] == review_id))
elif method == "GET" and re.search(r"/pulls/\\d+$", endpoint):
    print(json.dumps(state["pr"]))
elif method == "POST" and endpoint.endswith("/reviews"):
    states = {{"REQUEST_CHANGES": "CHANGES_REQUESTED", "COMMENT": "COMMENTED"}}
    state["reviews"].append({{**payload, "id": len(state["reviews"]) + 1, "state": states[payload["event"]]}})
elif method == "PUT" and endpoint.endswith("/dismissals"):
    review_id = int(endpoint.split("/")[-2])
    next(r for r in state["reviews"] if r["id"] == review_id)["state"] = "DISMISSED"
elif method == "GET" and endpoint.endswith("/comments"):
    lines(state["comments"])
elif method == "POST" and endpoint.endswith("/comments"):
    state["comments"].append({{"id": len(state["comments"]) + 1, "body": payload["body"]}})
elif method == "PATCH" and "/issues/comments/" in endpoint:
    comment_id = int(endpoint.split("/")[-1])
    next(c for c in state["comments"] if c["id"] == comment_id)["body"] = payload["body"]
else:
    sys.exit("fake gh: no route for " + method + " " + endpoint)
json.dump(state, open(state_path, "w"))
"""

CLAUDE = """
import json, os, sys
calls_path, replies_path = {calls!r}, {replies!r}
stdin = "" if sys.stdin.isatty() else sys.stdin.read()
calls = json.load(open(calls_path))
calls.append({{"argv": sys.argv[1:], "stdin": stdin, "api_key": os.environ.get("ANTHROPIC_API_KEY")}})
json.dump(calls, open(calls_path, "w"))
replies = json.load(open(replies_path))
print(replies.pop(0))
json.dump(replies, open(replies_path, "w"))
"""


class FakeGitHub:
    """The fakes, a work tree with a base commit and a head commit, and the env the scripts read."""

    def __init__(self, root: Path, base: dict[str, str] | None = None) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.state_path = root / "gh.json"
        self.calls_path = root / "claude-calls.json"
        self.replies_path = root / "claude-replies.json"
        self.state_path.write_text(json.dumps({"calls": [], "reviews": [], "comments": [], "pr": {"title": "AW-9: add a", "body": "Ticket text"}}))
        self.calls_path.write_text("[]")
        self.replies_path.write_text("[]")
        bin_dir = root / "bin"
        bin_dir.mkdir()
        for name, text in (("gh", GH.format(state=str(self.state_path))), ("claude", CLAUDE.format(calls=str(self.calls_path), replies=str(self.replies_path)))):
            (bin_dir / name).write_text(f"#!{sys.executable}\n{text}")
            (bin_dir / name).chmod(0o755)
        config = root / "gitconfig"
        config.write_text("[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n")
        self.work = root / "work"
        self.work.mkdir()
        self.env = {
            **os.environ,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "GIT_CONFIG_GLOBAL": str(config),
            "GIT_CONFIG_NOSYSTEM": "1",
            "RUNNER_TEMP": str(root),
            "GITHUB_REPOSITORY": "kc/app",
            "PR_NUMBER": "7",
            "CLAUDE_CODE_OAUTH_TOKEN": "token",
        }
        self.git("init", "-q")
        self.commit({"a.py": "one\n", "README.md": "# app\n", **(base or {})})
        self.env["BASE_SHA"] = self.git("rev-parse", "HEAD")
        self.git("checkout", "-q", "-b", "feature")

    def git(self, *args: str) -> str:
        return subprocess.run(["git", *args], cwd=self.work, env=self.env, capture_output=True, text=True, check=True).stdout.strip()

    def commit(self, files: dict[str, str]) -> str:
        for name, text in files.items():
            (self.work / name).parent.mkdir(parents=True, exist_ok=True)
            (self.work / name).write_text(text)
        self.git("add", ".")
        self.git("commit", "-q", "-m", "change")
        self.env["HEAD_SHA"] = self.git("rev-parse", "HEAD")
        return self.env["HEAD_SHA"]

    def reply(self, *outputs: object) -> None:
        """Queues what each next `claude` run prints."""
        self.replies_path.write_text(json.dumps([o if isinstance(o, str) else json.dumps(o) for o in outputs]))

    def run(self, script: Path, **env: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, str(script)], cwd=self.work, env={**self.env, **env}, capture_output=True, text=True)

    @property
    def state(self) -> dict:
        return json.loads(self.state_path.read_text())

    @property
    def claude_calls(self) -> list[dict]:
        return json.loads(self.calls_path.read_text())
