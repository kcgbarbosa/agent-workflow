"""The gate's review: Claude Code runs the code-review skill on a pull request, and this posts its findings.

It runs in the pull request's checkout at its head. action.yml gives the env it reads.
Exit 1 means a blocking finding, from this review or from the last one when nothing new needs a review.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path

# Each review body starts with it, so a later push finds the commit the last review reached and its verdict.
MARKER = re.compile(r"<!-- gate review head=([0-9a-f]+) blocking=(\d+) -->")
SEVERITIES = ("blocking", "minor")
SCHEMA = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "line": {"type": "integer"},
                    "severity": {"enum": list(SEVERITIES)},
                    "sentence": {"type": "string"},
                },
                "required": ["path", "line", "severity", "sentence"],
            },
        }
    },
    "required": ["findings"],
}
# The model reads the code and runs read-only git. It gets no GitHub token, so only this script posts.
TOOLS = ["Read", "Grep", "Glob", "Agent", "Skill"] + [
    f"Bash(git {command}:*)" for command in ("diff", "log", "show", "merge-base", "rev-parse")
]


@dataclass(frozen=True)
class Settings:
    enabled: bool
    model: str
    effort: str
    skip: tuple[str, ...]


@dataclass(frozen=True)
class LastReview:
    id: int
    head: str
    blocking: int


def settings() -> Settings:
    """The gate's inputs, with `loop.toml [review]` of the base over them, so a pull request cannot turn off its own review."""
    shown = subprocess.run(["git", "show", f"{os.environ['BASE_SHA']}:loop.toml"], capture_output=True, text=True)
    table = tomllib.loads(shown.stdout).get("review", {}) if shown.returncode == 0 else {}
    return Settings(
        enabled=table.get("enabled", True),
        model=table.get("model", os.environ["REVIEW_MODEL"]),
        effort=table.get("effort", os.environ["REVIEW_EFFORT"]),
        skip=tuple(table.get("skip", os.environ.get("REVIEW_SKIP", "").split())),
    )


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def gh_list(endpoint: str) -> list[dict]:
    out = subprocess.run(
        ["gh", "api", endpoint, "--paginate", "--jq", ".[]"], capture_output=True, text=True, check=True
    ).stdout
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def gh_send(method: str, endpoint: str, payload: dict, check: bool = True) -> bool:
    result = subprocess.run(
        ["gh", "api", "-X", method, endpoint, "--input", "-"], input=json.dumps(payload), text=True, check=check
    )
    return result.returncode == 0


def last_review(reviews: list[dict]) -> LastReview | None:
    for review in reversed(reviews):
        match = MARKER.search(review.get("body") or "")
        if match:
            return LastReview(review["id"], match[1], int(match[2]))
    return None


def is_ancestor(commit: str, head: str) -> bool:
    return subprocess.run(["git", "merge-base", "--is-ancestor", commit, head], capture_output=True).returncode == 0


def since_point(last: LastReview | None, base: str, head: str) -> tuple[str, bool]:
    """Where this review starts, and whether that point is a merge made here.

    After the last review, the branch can merge the base, such as with "Update branch". The point is then the reviewed
    commit merged with the new base, so the diff from it holds only what the pull request changed since the last review.
    A conflict in that merge, or a rewritten branch, falls back to the whole pull request.
    """
    if not last or not is_ancestor(last.head, head):
        return base, False
    if git("merge-base", os.environ["BASE_SHA"], last.head).strip() == base:
        return last.head, False
    tree = subprocess.run(["git", "merge-tree", "--write-tree", last.head, base], capture_output=True, text=True)
    if tree.returncode != 0:
        return base, False
    who = {f"GIT_{role}_{part}": value for role in ("AUTHOR", "COMMITTER") for part, value in (("NAME", "gate"), ("EMAIL", "gate@localhost"))}
    merged = subprocess.run(
        ["git", "commit-tree", tree.stdout.split()[0], "-p", last.head, "-p", base, "-m", "The last reviewed commit, merged with the base"],
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, **who},
    ).stdout.strip()
    return merged, True


def commentable_lines(base: str, head: str) -> dict[str, set[int]]:
    """The new-file lines in each hunk of the pull request's diff, the only lines a review comment can sit on."""
    lines: dict[str, set[int]] = {}
    path = None
    for row in git("diff", base, head).splitlines():
        if row.startswith("+++ "):
            path = row[6:] if row.startswith("+++ b/") else None
        elif row.startswith("@@") and path:
            match = re.match(r"@@ -\S+ \+(\d+)(?:,(\d+))? @@", row)
            if match:
                start, count = int(match[1]), int(match[2] or 1)
                lines.setdefault(path, set()).update(range(start, start + count))
    return lines


def prompt(number: str, since: str, merged: bool, pr_file: Path, earlier_file: Path | None) -> str:
    parts = [
        f"Review pull request #{number} with the code-review skill. The fixed point is {since}, and HEAD is checked out.",
        f"{pr_file} holds the pull request's title and body. The body holds the ticket text and names the spec: read the spec it names.",
        "Read AGENTS.md for the repo's standards.",
    ]
    if merged:
        parts.append(
            f"{since} is the last reviewed commit merged with the base, so the diff is `git diff {since} HEAD`, with two dots, "
            f"and the commits are `git log {since}..HEAD --no-merges`. They hold only what the pull request changed since the last review."
        )
    if earlier_file:
        parts.append(
            f"An earlier review covered the commits up to the fixed point, and {earlier_file} holds its findings. "
            "Check whether the new commits resolve each, and report again each blocking finding they leave unresolved."
        )
    parts.append(
        "Nobody can answer a question during this run, so where the skill would ask, decide and go on. "
        "Return the findings in the schema's shape, each line a line of the file at HEAD."
    )
    return "\n\n".join(parts)


def run_claude(text: str, config: Settings) -> dict:
    claude = shutil.which("claude")
    command = [claude] if claude else ["npx", "-y", "@anthropic-ai/claude-code"]
    env = {key: value for key, value in os.environ.items() if key not in ("GH_TOKEN", "GITHUB_TOKEN")}
    result = subprocess.run(
        [
            *command,
            "-p",
            text,
            "--model", config.model,
            "--effort", config.effort,
            "--output-format", "json",
            "--json-schema", json.dumps(SCHEMA),
            "--allowedTools", *TOOLS,
        ],  # fmt: skip
        capture_output=True,
        text=True,
        env=env,
    )
    if result.returncode != 0:
        sys.exit(f"Claude Code failed:\n{result.stderr}{result.stdout[-2000:]}")
    return json.loads(result.stdout)


def findings_of(output: dict) -> list[dict]:
    """The findings list, or a clear exit that shows how the answer went out of shape and how the run ended."""
    ended = f"The run ended with subtype {output.get('subtype')!r} after {output.get('num_turns')} turns."
    answer = output.get("structured_output")
    if answer is None:
        result = output.get("result") or "null"
        try:
            answer = json.loads(result)
        except json.JSONDecodeError:
            sys.exit(f"code-review returned text in place of the findings. {ended} It starts:\n{str(result)[:1500]}")
    findings = answer.get("findings") if isinstance(answer, dict) else answer
    if not isinstance(findings, list):
        sys.exit(f"code-review returned no list of findings: {answer!r} {ended}")
    for finding in findings:
        if (
            not isinstance(finding.get("path"), str)
            or not isinstance(finding.get("line"), int)
            or finding.get("severity") not in SEVERITIES
            or not isinstance(finding.get("sentence"), str)
        ):
            sys.exit(f"code-review returned a finding out of shape: {finding}")
    return findings


def cost_line(output: dict) -> str:
    cost = output.get("total_cost_usd")
    if isinstance(cost, int | float):
        return f"review api cost: ${cost:.2f}"
    return "review api cost: unknown"


def main() -> int:
    config = settings()
    if not config.enabled:
        print("gate / review: off in the base's loop.toml [review], so no model runs.")
        return 0

    repo, number = os.environ["GITHUB_REPOSITORY"], os.environ["PR_NUMBER"]
    head = os.environ["HEAD_SHA"]
    base = git("merge-base", os.environ["BASE_SHA"], head).strip()
    reviews = gh_list(f"repos/{repo}/pulls/{number}/reviews")
    last = last_review(reviews)
    since, merged = since_point(last, base, head)
    follows = since != base

    changed = git("diff", "--name-only", since, head).splitlines()
    to_review = [path for path in changed if not any(fnmatch.fnmatch(path, pattern) for pattern in config.skip)]
    blocking = last.blocking if last and follows else 0
    # A blocking finding can sit in a skip path, such as a spec, so any change after one gets a model run to clear it.
    if not to_review and not (blocking and changed):
        print(f"gate / review: nothing to review since {since[:7]} outside the skip paths, so no model runs.")
        if blocking:
            print(f"The last review at {last.head[:7]} has {blocking} blocking findings.")
        return 1 if blocking else 0
    if not os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") and not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("gate / review needs the CLAUDE_CODE_OAUTH_TOKEN or the ANTHROPIC_API_KEY secret, or `enabled = false` in loop.toml [review].")

    temp = Path(os.environ.get("RUNNER_TEMP", "/tmp"))
    pr = json.loads(subprocess.run(["gh", "api", f"repos/{repo}/pulls/{number}"], capture_output=True, text=True, check=True).stdout)
    pr_file = temp / "pull-request.md"
    pr_file.write_text(f"# {pr.get('title', '')}\n\n{pr.get('body') or ''}\n")
    earlier_file = None
    if last and follows:
        earlier = [
            {"path": c["path"], "line": c.get("line"), "comment": c["body"]}
            for c in gh_list(f"repos/{repo}/pulls/{number}/reviews/{last.id}/comments")
        ]
        body = next(r.get("body") or "" for r in reviews if r["id"] == last.id)
        earlier_file = temp / "earlier-review.json"
        earlier_file.write_text(json.dumps({"body": body, "comments": earlier}, indent=2))

    output = run_claude(prompt(number, since, merged, pr_file, earlier_file), config)
    findings = findings_of(output)
    blocking = sum(1 for finding in findings if finding["severity"] == "blocking")

    lines = commentable_lines(base, head)
    comments, elsewhere = [], []
    for finding in findings:
        text = f"**{finding['severity']}**: {finding['sentence']}"
        if finding["line"] in lines.get(finding["path"], set()):
            comments.append({"path": finding["path"], "line": finding["line"], "side": "RIGHT", "body": text})
        else:
            elsewhere.append(f"- `{finding['path']}:{finding['line']}` {text}")
    start = last.head if merged and last else since
    summary = f"**gate / review** of {start[:7]}..{head[:7]}: {blocking} blocking, {len(findings) - blocking} minor."
    body = "\n\n".join(
        part
        for part in (
            f"<!-- gate review head={head} blocking={blocking} -->\n{summary}",
            "Findings outside the diff:\n" + "\n".join(elsewhere) if elsewhere else "",
            cost_line(output),
        )
        if part
    )
    event = "REQUEST_CHANGES" if blocking else "COMMENT"
    gh_send("POST", f"repos/{repo}/pulls/{number}/reviews", {"commit_id": head, "event": event, "body": body, "comments": comments})
    # The new review replaces the old ones, so an old request for changes no longer holds the merge.
    for review in reviews:
        if review.get("state") == "CHANGES_REQUESTED" and MARKER.search(review.get("body") or ""):
            dismissal = {"message": "A later gate review replaces this one.", "event": "DISMISS"}
            if not gh_send("PUT", f"repos/{repo}/pulls/{number}/reviews/{review['id']}/dismissals", dismissal, check=False):
                print(f"::warning::could not dismiss the earlier gate review {review['id']}")
    print(summary)
    print(cost_line(output))
    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main())
