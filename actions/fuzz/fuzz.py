"""The gate's fuzz job: adversaries try to break a pull request, and this keeps the findings a rerun proves.

It runs in the pull request's checkout at its head, with the stack's keys in the env. action.yml gives the env it reads.
Claude Code runs the interrogate skill with the pull request's diff as the scope and its body's ticket text as the intent.
This script reruns each reproduction on the head, keeps the ones that fail, runs those on the base to tell a new finding
from a pre-existing one, posts one review comment, and fails when a new finding survives and `blocking` is on.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
from dataclasses import dataclass
from pathlib import Path

SCHEMA = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "command": {"type": "string", "description": "The command that runs the reproduction alone, from the repo root."},
                    "reproduction": {"type": "string", "description": "The repo-relative path of the reproduction's test file."},
                    "output": {"type": "string"},
                    "breaks": {"type": "string", "description": "How the failure breaks the ticket's lines."},
                },
                "required": ["title", "command", "reproduction", "output", "breaks"],
            },
        }
    },
    "required": ["findings"],
}
FIELDS = SCHEMA["properties"]["findings"]["items"]["required"]
# The adversaries run the repo's tests and its stack, so they get Bash. They get no GitHub token and no `gh`,
# so only this script writes to the pull request.
TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Agent", "Skill", "Bash"]
DENIED = ["Bash(gh:*)", "Bash(git push:*)"]
# The longest one reproduction may run, on the head and on the base.
RUN_SECONDS = 600
OUTPUT_LINES = 60
REPRO_CHARS = 20000
BODY_CHARS = 60000


@dataclass(frozen=True)
class Settings:
    enabled: bool
    model: str
    effort: str
    adversaries: int
    blocking: bool
    setup: tuple[str, ...]
    skip: tuple[str, ...]


@dataclass
class Finding:
    title: str
    command: str
    reproduction: str
    breaks: str
    text: str = ""
    head_output: str = ""
    new: bool = True


def settings() -> Settings:
    """The gate's inputs, with `loop.toml [fuzz]` of the base over them, so a pull request cannot turn off its own fuzz."""
    shown = subprocess.run(["git", "show", f"{os.environ['BASE_SHA']}:loop.toml"], capture_output=True, text=True)
    data = tomllib.loads(shown.stdout) if shown.returncode == 0 else {}
    if "review" in data:
        print("::warning::loop.toml [review] is no longer read, because the fuzz job replaced the review. [fuzz] holds its settings.")
    table = data.get("fuzz", {})
    return Settings(
        enabled=table.get("enabled", True),
        model=table.get("model", os.environ["FUZZ_MODEL"]),
        effort=table.get("effort", os.environ["FUZZ_EFFORT"]),
        adversaries=table.get("adversaries", 3),
        blocking=table.get("blocking", True),
        setup=tuple(table.get("setup", [])),
        skip=tuple(table.get("skip", os.environ.get("FUZZ_SKIP", "").split())),
    )


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def gh_send(method: str, endpoint: str, payload: dict) -> None:
    subprocess.run(["gh", "api", "-X", method, endpoint, "--input", "-"], input=json.dumps(payload), text=True, check=True)


def prompt(number: str, base: str, pr_file: Path, config: Settings) -> str:
    stack = "The `[fuzz] setup` command ran before you, so the stack is up and seeded. " if config.setup else ""
    return (
        f"/interrogate the change of pull request #{number}, `git diff {base}...HEAD`, with HEAD checked out. "
        f"{pr_file} holds its title and body, and the ticket text in the body is the intent: a finding counts only when it breaks the ticket's lines. "
        f"Spawn {config.adversaries} adversaries. {stack}"
        "Each writes each reproduction as a test file that the repo's test suite runs, following AGENTS.md and the repo's testing doc for the rows it creates, "
        "and reports the command that runs that file alone, from the repo root. "
        "Leave the reproduction file of each verified finding in place, and remove the others. "
        "Nobody can answer a question during this run, so where the skill would ask, decide and go on. "
        "Return the verified findings in the schema's shape, with the repo-relative path of each reproduction."
    )


def progress(event: dict) -> None:
    """One log line for each tool call, so a long run shows what it does while it runs."""
    if event.get("type") != "assistant":
        return
    for block in event.get("message", {}).get("content", []):
        if block.get("type") == "tool_use":
            inputs = block.get("input") or {}
            detail = next((str(inputs[key]) for key in ("command", "file_path", "pattern", "description", "skill") if key in inputs), "")
            print(f"fuzz: {block.get('name')} {detail[:160]}".rstrip(), flush=True)


def run_claude(text: str, config: Settings) -> dict:
    claude = shutil.which("claude")
    command = [claude] if claude else ["npx", "-y", "@anthropic-ai/claude-code"]
    env = {key: value for key, value in os.environ.items() if key not in ("GH_TOKEN", "GITHUB_TOKEN")}
    # stderr goes to a file, so a full stderr pipe cannot stall the run while stdout streams.
    errors = tempfile.TemporaryFile("w+")
    process = subprocess.Popen(
        [
            *command,
            "-p",
            text,
            "--model", config.model,
            "--effort", config.effort,
            "--output-format", "stream-json",
            "--verbose",
            "--json-schema", json.dumps(SCHEMA),
            "--allowedTools", *TOOLS,
            "--disallowedTools", *DENIED,
        ],  # fmt: skip
        stdout=subprocess.PIPE,
        stderr=errors,
        text=True,
        env=env,
    )
    assert process.stdout is not None
    output, tail = None, []
    for line in process.stdout:
        tail = (tail + [line])[-20:]
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        progress(event)
        if event.get("type") == "result":
            output = event
    process.wait()
    errors.seek(0)
    stderr = errors.read()
    if process.returncode != 0 or output is None:
        sys.exit(f"Claude Code failed:\n{stderr}{''.join(tail)[-2000:]}")
    return output


def findings_of(output: dict) -> list[Finding]:
    """The findings, or a clear exit that shows how the answer went out of shape and how the run ended."""
    ended = f"The run ended with subtype {output.get('subtype')!r} after {output.get('num_turns')} turns."
    answer = output.get("structured_output")
    if answer is None:
        result = output.get("result") or "null"
        try:
            answer = json.loads(result)
        except json.JSONDecodeError:
            sys.exit(f"interrogate returned text in place of the findings. {ended} It starts:\n{str(result)[:1500]}")
    findings = answer.get("findings") if isinstance(answer, dict) else answer
    if not isinstance(findings, list):
        sys.exit(f"interrogate returned no list of findings: {answer!r} {ended}")
    for finding in findings:
        if not isinstance(finding, dict) or any(not isinstance(finding.get(field), str) for field in FIELDS):
            sys.exit(f"interrogate returned a finding out of shape: {finding}")
    return [Finding(f["title"], f["command"], f["reproduction"], f["breaks"]) for f in findings]


def run(command: str) -> tuple[int, str]:
    """Runs a reproduction's command from the repo root, and gives its exit code and its output."""
    try:
        done = subprocess.run(["bash", "-c", command], capture_output=True, text=True, timeout=RUN_SECONDS)
    except subprocess.TimeoutExpired as error:
        return 124, f"{error.stdout or ''}{error.stderr or ''}\nTimed out after {RUN_SECONDS} seconds."
    return done.returncode, done.stdout + done.stderr


def normal(output: str) -> str:
    """The output with what changes from run to run taken out: the checkout's path, durations, and spacing."""
    text = output.replace(os.getcwd(), "<repo>")
    text = re.sub(r"\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds)\b", "<time>", text)
    return " ".join(text.split())


def reproduction(path: str) -> Path | None:
    """The reproduction's file, when it is a file inside the checkout."""
    root = Path.cwd().resolve()
    file = (root / path).resolve()
    return file if file.is_relative_to(root) and file.is_file() else None


def verify(findings: list[Finding]) -> tuple[list[Finding], list[str]]:
    """Reruns each reproduction on the head, and keeps the ones whose run fails again."""
    kept, dropped = [], []
    for finding in findings:
        file = reproduction(finding.reproduction)
        if not file:
            dropped.append(f"{finding.title}: its reproduction `{finding.reproduction}` is not in the checkout.")
            continue
        finding.text = file.read_text(errors="replace")
        code, output = run(finding.command)
        if code == 0:
            dropped.append(f"{finding.title}: `{finding.command}` passed on the rerun.")
            continue
        finding.head_output = output
        kept.append(finding)
    return kept, dropped


def against_base(findings: list[Finding], base: str, head: str) -> None:
    """Runs each kept reproduction on the base. One that fails there with the head's output is pre-existing."""
    if not findings:
        return
    git("checkout", "-q", "-f", "--detach", base)
    try:
        for finding in findings:
            file = Path(finding.reproduction)
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(finding.text)
            code, output = run(finding.command)
            finding.new = code == 0 or normal(output) != normal(finding.head_output)
    finally:
        git("checkout", "-q", "-f", "--detach", head)


def fenced(text: str, language: str = "") -> str:
    """A code fence longer than any run of backticks in the text."""
    fence = "`" * max(3, max((len(run) for run in re.findall(r"`+", text)), default=0) + 1)
    return f"{fence}{language}\n{text.rstrip()}\n{fence}"


def tail(text: str, lines: int = OUTPUT_LINES) -> str:
    rows = text.rstrip().splitlines()
    return "\n".join(rows[-lines:]) if len(rows) <= lines else f"... {len(rows) - lines} lines cut\n" + "\n".join(rows[-lines:])


def listed(findings: list[Finding], start: int) -> str:
    parts = []
    for number, finding in enumerate(findings, start):
        text = finding.text if len(finding.text) <= REPRO_CHARS else finding.text[:REPRO_CHARS] + "\n... cut"
        parts.append(
            "\n\n".join(
                (
                    f"#### {number}. {finding.title}",
                    finding.breaks,
                    fenced(finding.command, "sh"),
                    "Its output on the head:\n\n" + fenced(tail(finding.head_output), "text"),
                    f"<details><summary>The reproduction, <code>{finding.reproduction}</code></summary>\n\n{fenced(text)}\n\n</details>",
                )
            )
        )
    return "\n\n".join(parts)


def cost_line(output: dict) -> str:
    cost = output.get("total_cost_usd")
    return f"fuzz api cost: ${cost:.2f}" if isinstance(cost, int | float) else "fuzz api cost: unknown"


def main() -> int:
    config = settings()
    if not config.enabled:
        print("gate / fuzz: off in the base's loop.toml [fuzz], so no model runs.")
        return 0

    repo, number = os.environ["GITHUB_REPOSITORY"], os.environ["PR_NUMBER"]
    head = os.environ["HEAD_SHA"]
    base_sha = os.environ["BASE_SHA"]
    base = git("merge-base", base_sha, head).strip()
    changed = git("diff", "--name-only", base, head).splitlines()
    if not [path for path in changed if not any(fnmatch.fnmatch(path, pattern) for pattern in config.skip)]:
        print("gate / fuzz: nothing changed outside the skip paths, so no model runs.")
        return 0
    # A run with no token, such as a Dependabot pull request's, fuzzes nothing and blocks nothing.
    if not os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") and not os.environ.get("ANTHROPIC_API_KEY"):
        print("::warning::gate / fuzz has no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY secret, so it fuzzes nothing.")
        return 0

    if config.setup:
        print(f"gate / fuzz: setup: {' '.join(config.setup)}", flush=True)
        if subprocess.run(list(config.setup)).returncode != 0:
            sys.exit("gate / fuzz: the [fuzz] setup command failed, so no adversary ran.")

    temp = Path(os.environ.get("RUNNER_TEMP", "/tmp"))
    pr = json.loads(subprocess.run(["gh", "api", f"repos/{repo}/pulls/{number}"], capture_output=True, text=True, check=True).stdout)
    pr_file = temp / "pull-request.md"
    pr_file.write_text(f"# {pr.get('title', '')}\n\n{pr.get('body') or ''}\n")

    output = run_claude(prompt(number, base, pr_file, config), config)
    kept, dropped = verify(findings_of(output))
    against_base(kept, base_sha, head)
    new = [finding for finding in kept if finding.new]
    old = [finding for finding in kept if not finding.new]

    summary = f"**gate / fuzz** of {base[:7]}..{head[:7]}: {len(new)} new, {len(old)} pre-existing, {len(dropped)} dropped."
    if new and not config.blocking:
        summary += " `[fuzz] blocking` is off, so the job passes."
    parts = [f"<!-- gate fuzz head={head} findings={len(kept)} -->\n{summary}"]
    if new:
        parts.append("### New findings\n\nEach reproduction fails on the head and not the same way on the base.\n\n" + listed(new, 1))
    if old:
        parts.append("### Pre-existing findings\n\nEach reproduction fails the same way on the base, so it fails nothing.\n\n" + listed(old, len(new) + 1))
    if dropped:
        parts.append("Dropped:\n" + "\n".join(f"- {line}" for line in dropped))
    parts.append(cost_line(output))
    body = "\n\n".join(parts)
    if len(body) > BODY_CHARS:
        body = body[:BODY_CHARS] + "\n\n... The comment is cut at GitHub's size limit. The job's log holds the rest."
        print("\n\n".join(parts))
    gh_send("POST", f"repos/{repo}/pulls/{number}/reviews", {"commit_id": head, "event": "COMMENT", "body": body})
    print(summary)
    print(cost_line(output))
    if new and config.blocking:
        print(f"::error::gate / fuzz: {len(new)} new findings survived a rerun. The review comment lists them.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
