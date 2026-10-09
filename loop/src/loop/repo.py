"""Git commands of the loop. Git and the tracker hold every state of a run."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path


class GitError(Exception):
    pass


def git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise GitError(f"git {' '.join(args)}: {result.stderr.strip()}")
    return result


def out(cwd: Path, *args: str) -> str:
    return git(cwd, *args).stdout.strip()


def find_branch(repo: Path, key: str) -> str | None:
    """The branch that carries the key, such as `feat/<key>-<slug>`. Local wins."""
    pattern = re.compile(rf"^[a-z]+/{re.escape(key)}(-|$)")
    for prefix in ("refs/heads/", "refs/remotes/origin/"):
        refs = out(repo, "for-each-ref", "--format=%(refname)", prefix).splitlines()
        for ref in sorted(refs):
            name = ref.removeprefix(prefix)
            if pattern.match(name):
                return name
    return None


def has_ref(repo: Path, ref: str) -> bool:
    return git(repo, "rev-parse", "--verify", "--quiet", ref, check=False).returncode == 0


def landed(repo: Path, epic_branch: str, key: str) -> bool:
    """A ticket has landed when a merge on the Epic branch carries its key."""
    log = out(repo, "log", "--merges", "--fixed-strings", f"--grep=({key})", "--format=%H", epic_branch)
    return bool(log)


def adds_to(repo: Path, ref: str, base: str) -> bool:
    """Whether a merge of the ref changes the base. After a squash merge, it does not."""
    merged = git(repo, "merge-tree", "--write-tree", base, ref, check=False)
    if merged.returncode != 0:  # A conflict: the ref holds work that the base lacks.
        return True
    return merged.stdout.split()[0] != out(repo, "rev-parse", f"{base}^{{tree}}")


def add_worktree(repo: Path, path: Path, branch: str, base: str) -> None:
    """Checks out the branch in its own worktree. A missing branch starts from the base."""
    git(repo, "worktree", "prune")
    if path.exists():
        return
    if has_ref(repo, f"refs/heads/{branch}"):
        git(repo, "worktree", "add", str(path), branch)
    elif has_ref(repo, f"refs/remotes/origin/{branch}"):
        git(repo, "worktree", "add", "--track", "-b", branch, str(path), f"origin/{branch}")
    else:
        git(repo, "worktree", "add", "--no-track", "-b", branch, str(path), base)


def is_ancestor(repo: Path, commit: str, ref: str) -> bool:
    return git(repo, "merge-base", "--is-ancestor", commit, ref, check=False).returncode == 0


def remove_trials(repo: Path, folder: Path, branch: str, base: str) -> list[Path]:
    """Removes each trial worktree in the folder that started from the branch's work, with its branch.

    Claude Code names the branch of a subagent's worktree `worktree-agent-<id>`, and locks the worktree
    while the subagent runs, so a running trial stays. A worktree whose commit is on the base, and not
    only on the branch, can belong to anyone's session, so it stays too.
    """
    root = (repo / folder).resolve()
    removed = []
    for entry in out(repo, "worktree", "list", "--porcelain").split("\n\n"):
        fields = dict(line.partition(" ")[::2] for line in entry.splitlines())
        path = Path(fields.get("worktree", "")).resolve()
        trial_branch = fields.get("branch", "").removeprefix("refs/heads/")
        if path.parent != root or "locked" in fields or not trial_branch.startswith("worktree-agent-"):
            continue
        if not is_ancestor(repo, fields["HEAD"], branch) or is_ancestor(repo, fields["HEAD"], base):
            continue
        git(repo, "worktree", "remove", "--force", str(path), check=False)
        git(repo, "branch", "--delete", "--force", trial_branch, check=False)
        removed.append(path)
    return removed


def slug(text: str, words: int = 6) -> str:
    parts = re.findall(r"[a-z0-9]+", text.lower())
    return "-".join(parts[:words]) or "work"
