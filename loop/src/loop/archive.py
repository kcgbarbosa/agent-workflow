"""The Archive spec button of `loop watch` (loop.md, Logs).

After the Epic PR merges, a PR deletes the spec from the main branch, and the Epic's Spec link points at the
merge commit, which git keeps. GitHub, Jira, and git hold the state, so a second click repeats no side effect.
"""

from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import process
from .config import Config
from .forecast import BacklogError, jira_client
from .jira import JiraError
from .repo import GitError, git
from .report import ARCHIVE, DECISIONS, read_lines, write_line

# A link to a Markdown file at a ref of a GitHub repo, in the text or a link target of the description.
LINK = re.compile(
    r"(https?://[^\s\"'<>()\[\]\\]+?)/blob/([^/\s\"'<>()\[\]\\]+)/([^\s\"'<>()\[\]\\#?]+?\.md)\b"
)
SHA = re.compile(r"[0-9a-f]{40}")
# One archive at a time, so two clicks never push the same branch at once.
LOCK = threading.Lock()


class ArchiveError(Exception):
    pass


@dataclass(frozen=True)
class Link:
    url: str
    prefix: str
    ref: str
    path: str

    @property
    def pinned(self) -> bool:
        return bool(SHA.fullmatch(self.ref))

    def at(self, commit: str) -> str:
        return f"{self.prefix}/blob/{commit}/{self.path}"


def spec_links(text: str, repo_url: str) -> list[Link]:
    """The links of the Epic's repo to a Markdown file, each once. A link to another repo is not its spec."""
    found = {match[0]: Link(*match.group(0, 1, 2, 3)) for match in LINK.finditer(text)}
    return [link for link in found.values() if link.prefix == repo_url]


def archive(config: Config, epic_key: str) -> dict[str, str]:
    """Pins the Epic's spec links at the merge commit of its PR, and opens a PR that deletes the spec from
    the main branch. Returns the answer and the URL of the PR it names. Logs the result to the Epic's log."""
    home = config.state_dir / epic_key
    if not (home / DECISIONS).exists():
        raise ArchiveError(f"The {config.name} project has no run of {epic_key} on this host.")
    with LOCK:
        try:
            result, message, url = _archive(config, epic_key, home)
        except (ArchiveError, BacklogError, GitError, JiraError) as error:
            write_line(home / DECISIONS, epic_key, epic_key, ARCHIVE, "fail", detail=str(error)[-300:])
            raise ArchiveError(str(error)) from error
        write_line(home / DECISIONS, epic_key, epic_key, ARCHIVE, result, detail=url)
    return {"message": message, "url": url}


def _archive(config: Config, epic_key: str, home: Path) -> tuple[str, str, str]:
    branch = epic_branch(home, epic_key)
    prs = gh_json(config, "pr", "list", "--head", branch, "--state", "all", "--json", "url,state,mergeCommit")
    merged = next((pr for pr in prs if pr.get("state") == "MERGED" and pr.get("mergeCommit")), None)
    if merged is None:
        return "not-merged", "Merge the Epic PR first.", prs[0]["url"] if prs else ""
    commit = str(merged["mergeCommit"]["oid"])

    jira = jira_client(config)
    epic = jira.issue(epic_key)
    links = spec_links(epic.text, str(merged["url"]).split("/pull/")[0])
    if not links:
        raise ArchiveError(f"The description of {epic_key} links no spec of this repo.")
    pinned = False
    for link in links:
        if not link.pinned:
            pinned = jira.replace_in_description(epic_key, link.url, link.at(commit)) or pinned
    pins = sorted({link.url if link.pinned else link.at(commit) for link in links})

    git(config.repo, "fetch", "--prune", "origin")
    main = f"origin/{config.main_branch}"
    paths = sorted({link.path for link in links})
    left = [path for path in paths if git(config.repo, "cat-file", "-e", f"{main}:{path}", check=False).ok]
    if not left:
        return "archived", "Archived." if pinned else "Already archived.", ""
    archive_branch = f"docs/{epic_key}-archive-spec"
    listed = gh_json(config, "pr", "list", "--head", archive_branch, "--state", "open", "--json", "url")
    if listed:
        return "pr-open", f"The archive PR is open: {listed[0]['url']}.", str(listed[0]["url"])
    url = open_pr(config, home, archive_branch, left, epic.summary, pins)
    return "pr-open", f"Archived. Merge {url}.", url


def epic_branch(home: Path, epic_key: str) -> str:
    """The Epic branch that the run's board names, or else its last start line."""
    try:
        board = json.loads((home / "board.json").read_text())
    except OSError, json.JSONDecodeError:
        board = {}
    starts = [
        line
        for line in read_lines(home / DECISIONS)
        if (line.get("ticket"), line.get("step")) == (epic_key, "start") and line.get("detail")
    ]
    branch = (board.get("branch") if isinstance(board, dict) else None) or (
        starts[-1]["detail"] if starts else None
    )
    if not branch:
        raise ArchiveError(f"The log of {epic_key} names no Epic branch.")
    return str(branch)


def open_pr(config: Config, home: Path, branch: str, paths: list[str], summary: str, pins: list[str]) -> str:
    """Deletes the paths in a worktree from the main branch, pushes the branch, and opens its PR. The title
    names no issue key, so a merge moves nothing in the tracker. The owner merges it."""
    worktree = home / "worktrees" / "archive-spec"
    title = f"docs: archive the spec of {summary[:1].lower() + summary[1:]}"
    git(config.repo, "worktree", "prune")
    if worktree.exists():
        git(config.repo, "worktree", "remove", "--force", str(worktree))
    git(config.repo, "worktree", "add", "--quiet", "--no-track", "-B", branch, str(worktree),
        f"origin/{config.main_branch}")  # fmt: skip
    try:
        git(worktree, "rm", "--quiet", "--", *paths)
        git(worktree, "commit", "--quiet", "-m", title)
        # An earlier click can have pushed the branch and failed to open its PR, and no open PR uses it.
        git(worktree, "push", "--quiet", "--force-with-lease", "--set-upstream", "origin", branch)
    finally:
        git(config.repo, "worktree", "remove", "--force", str(worktree), check=False)
        git(config.repo, "branch", "--delete", "--force", branch, check=False)
    body_file = home / "runs" / home.name / "archive-pr-body.md"
    body_file.parent.mkdir(parents=True, exist_ok=True)
    links = "".join(f"- {pin}\n" for pin in pins)
    body_file.write_text(f"The Epic PR merged, so the spec leaves the main branch. Git keeps it:\n\n{links}")
    created = gh(
        config, "pr", "create", "--base", config.main_branch, "--head", branch, "--title", title,
        "--body-file", str(body_file),
    )  # fmt: skip
    return created.strip()


def gh(config: Config, *args: str) -> str:
    # A short command, at the gate timeout, as in a run.
    result = process.run(["gh", *args], config.repo, seconds=config.gate_timeout_minutes * process.MINUTE)
    if not result.ok:
        raise ArchiveError(f"gh {' '.join(args[:2])}: {result.stderr.strip()[-300:]}")
    return result.stdout


def gh_json(config: Config, *args: str) -> list[dict[str, Any]]:
    found = json.loads(gh(config, *args) or "[]")
    return found if isinstance(found, list) else []
