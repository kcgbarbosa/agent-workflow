"""The gate's UI judge: one model call per screenshot step, with no tools, and a comment for what it finds.

It runs in a checkout of the base, for its loop.toml, with the diff folder beside it. action.yml gives the folder and the env it reads.
Exit 1 means a blocking verdict.
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

VERDICTS = ("blocking", "minor", "fine")
IMAGES = (("baseline.png", "The baseline, from the base branch:"), ("new.png", "The new screenshot:"), ("diff.png", "The diff, which marks the changed pixels:"))
RATED_IMAGES = (("new.png", "The screenshot:"),)
BLOCKING_MARKER = "<!-- gate judge blocking -->"
MINOR_MARKER = "<!-- gate judge minor -->"


def blocking_list() -> list[str]:
    if not Path("loop.toml").exists():
        return []
    return tomllib.loads(Path("loop.toml").read_text()).get("ui", {}).get("blocking", [])


def rated(step: Path) -> bool:
    """A step with no baseline is rated on its one screenshot, not judged as a change."""
    return not (step / "baseline.png").exists()


def prompt(line: str, blocking: list[str], baseline: bool = True) -> str:
    if not baseline:
        rule = (
            f"The screen is blocking only when it shows one of these faults: {'; '.join(blocking)}. Any other fault is minor."
            if blocking
            else "Nothing is blocking in this repo, so every screen is minor or fine."
        )
        return (
            "You judge one screenshot of a pull request. It has no baseline, so judge the screen as it is.\n"
            f"The ticket line for this step: {line}\n"
            f"{rule} Fine means the screen is what the ticket line asks for and looks right.\n"
            'Answer with JSON only, in the shape {"verdict": "blocking" | "minor" | "fine", "sentence": "<one sentence>"}. '
            'A blocking answer adds "fault": the item of the list that the screen shows.'
        )
    rule = (
        f"A change is blocking only when it shows one of these: {'; '.join(blocking)}. Anything else is minor or fine."
        if blocking
        else "Nothing is blocking in this repo, so every change is minor or fine."
    )
    return (
        "You judge one changed screenshot of a pull request. You see the baseline, the new screenshot, and the diff.\n"
        f"The ticket line for this step: {line}\n"
        f"{rule} Fine means the change is what the ticket line asks for and looks right.\n"
        'Answer with JSON only, in the shape {"verdict": "blocking" | "minor" | "fine", "sentence": "<one sentence>"}. '
        'A blocking answer adds "fault": the item of the list that the change shows.'
    )


def ask(step: Path, line: str, blocking: list[str]) -> dict:
    content: list[dict] = [{"type": "text", "text": prompt(line, blocking, baseline=not rated(step))}]
    for name, caption in RATED_IMAGES if rated(step) else IMAGES:
        data = base64.b64encode((step / name).read_bytes()).decode()
        content += [
            {"type": "text", "text": caption},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}},
        ]
    message = {"type": "user", "message": {"role": "user", "content": content}}
    claude = shutil.which("claude")
    command = [claude] if claude else ["npx", "-y", "@anthropic-ai/claude-code"]
    result = subprocess.run(
        [
            *command,
            "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--tools", "",
            "--max-turns", "1",
            "--model", os.environ["JUDGE_MODEL"],
            "--effort", os.environ["JUDGE_EFFORT"],
        ],  # fmt: skip
        input=json.dumps(message) + "\n",
        capture_output=True,
        text=True,
        env={key: value for key, value in os.environ.items() if key not in ("GH_TOKEN", "GITHUB_TOKEN")},
    )
    events = [json.loads(row) for row in result.stdout.splitlines() if row.startswith("{")]
    text = next((event.get("result") or "" for event in events if event.get("type") == "result"), "")
    match = re.search(r"\{.*\}", text, re.DOTALL)
    try:
        answer = json.loads(match[0]) if match else {}
    except json.JSONDecodeError:
        answer = {}
    if answer.get("verdict") not in VERDICTS or not isinstance(answer.get("sentence"), str):
        sys.exit(f"The judge gave no verdict for {step.name}:\n{result.stderr}{text}")
    return answer


def image(repo: str, sha: str, path: str, alt: str) -> str:
    return f"![{alt}](https://github.com/{repo}/blob/{sha}/{path}?raw=true)"


def on_list(answer: dict, blocking: list[str]) -> bool:
    """Only a fault the repo named can block, whatever the model says."""
    fault = str(answer.get("fault", "")).strip().casefold()
    return fault in (item.strip().casefold() for item in blocking)


def comment(repo: str, number: str, marker: str, body: str | None, quiet: str) -> None:
    """Keeps one comment per marker. With no body, it edits an earlier comment to `quiet` and posts nothing new."""
    out = subprocess.run(
        ["gh", "api", f"repos/{repo}/issues/{number}/comments", "--paginate", "--jq", ".[]"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    existing = next((c for c in map(json.loads, filter(str.strip, out.splitlines())) if marker in (c.get("body") or "")), None)
    if body is None and existing is None:
        return
    text = f"{marker}\n{body if body is not None else quiet}"
    method, endpoint = ("PATCH", f"repos/{repo}/issues/comments/{existing['id']}") if existing else ("POST", f"repos/{repo}/issues/{number}/comments")
    subprocess.run(["gh", "api", "-X", method, endpoint, "--input", "-"], input=json.dumps({"body": text}), text=True, check=True)


def main() -> int:
    folder = Path(os.environ["SCREENSHOTS"])
    steps = sorted(step for step in folder.iterdir() if (step / "new.png").exists()) if folder.is_dir() else []
    if not steps:
        print("gate / judge: no changed screenshot, so no model runs.")
        return 0

    repo, number = os.environ["GITHUB_REPOSITORY"], os.environ["PR_NUMBER"]
    base, head = os.environ["BASE_SHA"], os.environ["HEAD_SHA"]
    blocking = blocking_list()
    found: dict[str, list[tuple[Path, dict, str]]] = {verdict: [] for verdict in VERDICTS}
    for step in steps:
        meta = json.loads((step / "step.json").read_text())
        answer = ask(step, meta["line"], blocking)
        if answer["verdict"] == "blocking" and not on_list(answer, blocking):
            answer = {"verdict": "minor", "sentence": f"{answer['sentence']} (Not on the blocking list.)"}
        found[answer["verdict"]].append((step, answer, meta["path"]))
        print(f"{step.name}: {answer['verdict']}, {answer['sentence']}")

    sections = [
        f"### {step.name}\n\n{answer['sentence']}\n\n"
        + (
            f"| Screenshot |\n| --- |\n| {image(repo, head, path, 'screenshot')} |"
            if rated(step)
            else f"| Before | After |\n| --- | --- |\n| {image(repo, base, path, 'before')} | {image(repo, head, path, 'after')} |"
        )
        for step, answer, path in found["blocking"]
    ]
    blocks = "\n\n".join([f"**gate / judge** blocks at {head[:7]}.", *sections]) if sections else None
    comment(repo, number, BLOCKING_MARKER, blocks, f"**gate / judge**: nothing blocks at {head[:7]}.")
    items = [f"- [ ] **{step.name}**: {answer['sentence']}" for step, answer, _ in found["minor"]]
    minors = "\n".join([f"**gate / judge** minor changes to check, at {head[:7]}:\n", *items]) if items else None
    comment(repo, number, MINOR_MARKER, minors, f"**gate / judge**: no minor changes at {head[:7]}.")
    return 1 if found["blocking"] else 0


if __name__ == "__main__":
    sys.exit(main())
