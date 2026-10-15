from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import threading
import time
import traceback
import urllib.request
from collections.abc import Callable, Mapping
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from . import repo, tiers
from .claude import REVIEW_EFFORT, REVIEW_MODEL, TRIALS, agent_settings, run_setup
from .config import Config
from .prompts import (
    ACCEPTANCE_PROMPT,
    AGENT_SCHEMA,
    CODE_REVIEW_PROMPT,
    DECISIONS_COMMENT,
    DISPATCH,
    EARLY_STATUS_PROMPT,
    LANDED_KEYS_PROMPT,
    NOTES_COMMENT,
    PR_PROMPT,
    RESTART_PROMPT,
    REVIEW_FIX_PROMPT,
    REVIEW_SCHEMA,
    STUCK_COMMENT,
    UI_OPEN_COMMENT,
    UI_REVIEW_PROMPT,
    USAGE_RESUME_PROMPT,
)
from .repo import git, out
from .stream import (
    agent_plan,
    agent_status,
    agent_usage,
    background_tasks,
    json_lines,
    subagents_at_status,
    usage_reset,
)
from .tracker import Ticket, TrackerError
from .watch import BOARD

# A limit that resets later than this, such as the weekly one, stops the loop.
MAX_USAGE_WAIT_SECONDS = 6 * 60 * 60
NOT_LANDED = "Done in the tracker, not landed"
UNFINISHED = ("Stuck", "Not built", NOT_LANDED)
USAGE_LIMIT = re.compile(r"usage limit|hit your limit|limit reached|rate.?limit", re.IGNORECASE)
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
# Marks in a ticket's run folder. They outlive a restart, so a restart repeats no review:
# the commit that the screenshots show, a code review that ran, and the findings it left unfixed.
UI_COMMIT_FILE = "ui-review.commit"
# What the UI review left open on a landed ticket: a fault, or a part it could not check. Drafts the Epic PR.
UI_OPEN_FILE = "ui-review.open"
CODE_REVIEWED_FILE = "code-review.done"
CODE_REVIEW_FIX_FILE = "code-review.fix"
# The faults of a UI review go back to the head agent this often. A fault left after that lands with the
# ticket and keeps the Epic PR a draft, because it costs less to fix by hand than to review again.
UI_FIX_ROUNDS = 1
TIMED_OUT = 124
# A session with a background task, such as a dev server, stays open after its status. A subagent that
# still runs at the status wakes the session for a late turn, so the loop waits this long for it.
EXIT_GRACE_SECONDS = 120.0
# Without such a subagent, no late turn is worth a wait, and a dev server never ends by itself.
IDLE_GRACE_SECONDS = 10.0
EXIT_POLL_SECONDS = 2.0
LOG_TAIL_LINES = 80
# Slot 0 is the main checkout, and the Epic branch has its own slot.
EPIC_SLOT = 1

Outcome = Literal["landed", "stuck", "usage-limit"]


class UsageLimit(Exception):
    def __init__(self, message: str, reset: float | None = None, session: str | None = None) -> None:
        super().__init__(message)
        self.reset = reset
        self.session = session


class AgentFailed(Exception):
    pass


@dataclass
class AgentResult:
    status: Literal["done", "blocked"]
    reason: str
    session: str
    findings: list[str] = field(default_factory=list)
    unchecked: list[str] = field(default_factory=list)
    # The subagents still running when the status came, which Claude Code then asked for too early.
    subagents_running: int = 0


@dataclass
class GateFailure:
    reason: str
    prompt: str
    log: Path
    # The failure is on the Epic branch, so the ticket branch takes the Epic branch before the fix.
    on_epic: bool = False
    # The fix of a code review finding is part of the build, not a fix attempt.
    attempt: bool = True


@dataclass
class TicketRun:
    ticket: Ticket
    slot: int
    branch: str
    worktree: Path
    run_dir: Path
    restart: bool
    agent_log: Path | None = None
    ui_touched: bool = False
    ui_fix_rounds: int = 0


def next_log(run_dir: Path, stem: str, suffix: str) -> Path:
    """The next numbered log in the run folder, so that a restart keeps the logs of earlier runs."""
    number = len(list(run_dir.glob(f"{stem}-*{suffix}"))) + 1
    return run_dir / f"{stem}-{number}{suffix}"


def pause(seconds: float) -> None:
    time.sleep(seconds)


def tail(text: str, lines: int = LOG_TAIL_LINES) -> str:
    return "\n".join(text.splitlines()[-lines:])


class EpicRun:
    def __init__(
        self, epic_key: str, config: Config, secrets: Mapping[str, str], base: str | None = None
    ) -> None:
        self.epic_key = epic_key
        self.base = base or config.main_branch
        self.config = config
        self.secrets = dict(secrets)
        self.repo = config.repo
        self.tracker = config.tracker(secrets)
        self.home = config.state_dir / epic_key
        self.log_path = self.home / "decisions.jsonl"
        self._log_lock = threading.Lock()
        self._repo_lock = threading.Lock()
        self._land_lock = threading.Lock()
        self.stuck_in_row = 0
        self.epic_branch = ""
        self.epic_worktree = self.home / "worktrees" / epic_key
        self.epic_summary = ""
        self.settings = agent_settings(config)
        self._pause_lock = threading.Lock()
        self.paused_until = 0.0

    # --- Run ---

    def run(self) -> int:
        self.home.mkdir(parents=True, exist_ok=True)
        try:
            self.stop_stale_stacks()
            return self._run()
        except Exception as error:
            self.log(self.epic_key, "stop", "loop-error", detail=str(error))
            self.notify(f"{self.epic_key} stopped")
            raise
        finally:
            # The next Epic uses the same slot and its ports. The volume stays for KC.
            self.stack_down(self.epic_worktree, EPIC_SLOT, self.epic_key, volumes=False)

    def _run(self) -> int:
        epic = self.tracker.issue(self.epic_key)
        self.epic_summary = epic.summary
        git(self.repo, "fetch", "--prune", "origin")
        self.epic_branch = repo.find_branch(self.repo, self.epic_key) or (
            f"feat/{self.epic_key}-{repo.slug(epic.summary)}"
        )
        if not self.base_exists():
            return 1
        with self._repo_lock:
            repo.add_worktree(self.repo, self.epic_worktree, self.epic_branch, f"origin/{self.base}")
        self.log(self.epic_key, "start", "ok", detail=self.epic_branch, setup=run_setup(self.config))
        if not self.sync_base():
            return 1
        for ticket in self.tracker.children(self.epic_key):
            if self.ticket_result(ticket) == NOT_LANDED:
                self.log(ticket.key, "start", "done-not-landed")
                self.notify(f"{ticket.key} done-not-landed")

        stopped = self.build_frontier()
        if stopped:
            self.log(self.epic_key, "stop", stopped)
            self.notify(f"{self.epic_key} stopped")
            return 1
        return self.finish()

    def base_exists(self) -> bool:
        """Whether the base branch is on origin. A merged Epic PR usually deletes its branch."""
        if repo.has_ref(self.repo, f"refs/remotes/origin/{self.base}"):
            return True
        self.log(self.epic_key, "base", "missing", detail=self.base)
        self.notify(f"{self.epic_key} stopped")
        return False

    def sync_base(self) -> bool:
        """Merges the base branch into a stacked Epic branch, so a fix to the base reaches the work on top.

        A merge keeps the Epic's own commits, so a change to the base never makes them useless. Returns
        False, with the branch as it was, when the base is gone or does not merge.
        """
        if self.base == self.config.main_branch:
            return True
        key = self.epic_key
        git(self.repo, "fetch", "--prune", "origin")
        ref = f"origin/{self.base}"
        if not self.base_exists():
            return False
        if repo.is_ancestor(self.epic_worktree, ref, "HEAD"):
            return True
        merged = git(self.epic_worktree, "merge", "--no-ff", "--no-edit", ref, check=False)
        if merged.returncode != 0:
            git(self.epic_worktree, "merge", "--abort", check=False)
            self.log(key, "base", "conflict", detail=tail(merged.stdout + merged.stderr))
            self.notify(f"{key} stopped")
            return False
        self.log(key, "base", "merged", detail=self.base)
        return True

    def build_frontier(self) -> str | None:
        """Runs every ticket on the frontier. Returns the reason the loop stopped early."""
        running: dict[Future[Outcome], str] = {}
        finished: set[str] = set()
        free_slots = list(range(EPIC_SLOT + 1, EPIC_SLOT + 1 + self.config.parallel))
        slot_of: dict[str, int] = {}
        stopped: str | None = None
        with ThreadPoolExecutor(max_workers=self.config.parallel) as pool:
            while True:
                if not stopped:
                    busy = set(running.values()) | finished
                    for ticket in self.frontier():
                        if not free_slots:
                            break
                        if ticket.key in busy:
                            continue
                        slot_of[ticket.key] = free_slots.pop(0)
                        future = pool.submit(self.build_ticket, ticket, slot_of[ticket.key])
                        running[future] = ticket.key
                if not running:
                    return stopped
                done, _ = wait(running, return_when=FIRST_COMPLETED)
                for future in done:
                    key = running.pop(future)
                    finished.add(key)
                    free_slots.append(slot_of.pop(key))
                    outcome = future.result()
                    if outcome == "landed":
                        self.stuck_in_row = 0
                    elif outcome == "stuck":
                        self.stuck_in_row += 1
                        if self.stuck_in_row >= self.config.circuit_breaker:
                            stopped = "circuit-breaker"
                    elif outcome == "usage-limit":
                        stopped = "usage-limit"

    def frontier(self) -> list[Ticket]:
        """Open tickets that are not stuck, whose blockers are done in the tracker or landed."""
        tickets = self.tracker.children(self.epic_key)

        def landed(key: str) -> bool:
            return repo.landed(self.repo, self.epic_branch, key)

        self.write_board(tickets, {ticket.key for ticket in tickets if landed(ticket.key)})
        return [
            ticket
            for ticket in tickets
            if not ticket.done
            and not ticket.flagged
            and not landed(ticket.key)
            and all(blocker.done or landed(blocker.key) for blocker in ticket.blockers)
        ]

    # --- One ticket ---

    def build_ticket(self, ticket: Ticket, slot: int) -> Outcome:
        run_dir = self.home / "runs" / ticket.key
        run_dir.mkdir(parents=True, exist_ok=True)
        run: TicketRun | None = None
        try:
            run = self.prepare(ticket, slot, run_dir)
            return self.drive(run)
        except AgentFailed as error:
            # The agent writes its error to the .err file next to its output.
            log = run.agent_log.with_suffix(".err") if run and run.agent_log else run_dir
            return self.stuck(ticket, str(error), log, slot)
        except UsageLimit:
            return "usage-limit"
        except Exception as error:  # noqa: BLE001 - a loop error makes the ticket stuck, not the run.
            log = run_dir / "loop-error.log"
            log.write_text(traceback.format_exc())
            return self.stuck(ticket, f"The loop failed: {error}", log, slot)

    def prepare(self, ticket: Ticket, slot: int, run_dir: Path) -> TicketRun:
        """Gives the ticket a worktree, a branch off the Epic branch, and its ticket file."""
        existing = repo.find_branch(self.repo, ticket.key)
        kind = "fix" if ticket.issue_type == "Bug" else "feat"
        branch = existing or f"{kind}/{ticket.key}-{repo.slug(ticket.summary)}"
        worktree = self.home / "worktrees" / ticket.key
        with self._repo_lock:
            repo.add_worktree(self.repo, worktree, branch, self.epic_branch)
        run = TicketRun(ticket, slot, branch, worktree, run_dir, restart=existing is not None)
        if not run.restart:
            for name in (CODE_REVIEWED_FILE, CODE_REVIEW_FIX_FILE, UI_COMMIT_FILE):
                (run_dir / name).unlink(missing_ok=True)
        self.write_ticket_file(run, self.config.ticket_gate, reviews=True)
        if ticket.status != self.config.in_progress:
            self.track(
                ticket.key, "status", lambda: self.tracker.transition(ticket.key, self.config.in_progress)
            )
        self.log(ticket.key, "start", "restart" if run.restart else "new", detail=branch)
        return run

    def drive(self, run: TicketRun) -> Outcome:
        """The agent run, the gates, the reviews, and the landing, with the fix attempts."""
        prompt, attempts = self.first_prompt(run)
        result = self.ticket_agent(run, prompt, session=None)
        while True:
            if result.status == "blocked":
                reason = f"The agent is blocked: {result.reason}"
                return self.stuck(run.ticket, reason, run.agent_log or run.run_dir, run.slot)
            failure = self.ticket_gate(run) or self.code_review(run) or self.ui_gate(run) or self.land(run)
            if failure is None:
                return "landed"
            if failure.attempt:
                if attempts >= self.config.fix_attempts:
                    return self.stuck(run.ticket, failure.reason, failure.log, run.slot)
                attempts += 1
            if failure.on_epic:
                failure = self.merge_epic(run, failure)
            result = self.ticket_agent(run, failure.prompt, session=result.session)

    def first_prompt(self, run: TicketRun) -> tuple[str, int]:
        """The prompt of a ticket's first agent run, and the fix attempts it has already used.

        A restart counts as a fix attempt. It carries the code review findings that the last run did not fix.
        """
        prompt = f"/implement {run.run_dir / 'ticket.md'}"
        if not run.restart:
            return prompt, 0
        prompt += f"\n\n{RESTART_PROMPT}"
        unfixed = run.run_dir / CODE_REVIEW_FIX_FILE
        if unfixed.exists():
            prompt += f"\n\n{unfixed.read_text()}"
        return prompt, 1

    def ticket_agent(self, run: TicketRun, prompt: str, session: str | None) -> AgentResult:
        """An agent run, then a push of the ticket branch, also when the run fails."""
        try:
            result = self.agent(
                run, prompt, session, model=self.config.agent_model, effort=self.config.agent_effort
            )
            (run.run_dir / CODE_REVIEW_FIX_FILE).unlink(missing_ok=True)
            return result
        finally:
            self.push(run.worktree, run.branch, run.ticket.key)
            self.remove_trials(run)

    def remove_trials(self, run: TicketRun) -> None:
        """Removes the trial worktrees that the ticket's agent run left, such as one of a trial that failed.

        A trial removes its own change when it reports, and Claude Code then removes its worktree.
        """
        base = f"origin/{self.base}"
        with self._repo_lock:
            removed = repo.remove_trials(self.repo, TRIALS, run.branch, base)
        if removed:
            self.log(run.ticket.key, "trials", "removed", detail=" ".join(map(str, removed)))

    def ticket_gate(self, run: TicketRun) -> GateFailure | None:
        """The ticket gate. A tree with changes not committed, or no commit, fails it first."""
        dirty = out(run.worktree, "status", "--porcelain")
        ahead = out(run.worktree, "rev-list", "--count", f"{self.epic_branch}..HEAD")
        if dirty or ahead == "0":
            if dirty:
                reason = "The worktree has changes that are not committed."
                prompt = f"{reason} Commit them or remove them:\n{dirty}"
            else:
                reason = "The branch has no commit for the ticket."
                prompt = f"{reason} Build the ticket and commit the work."
            self.log(run.ticket.key, "ticket-gate", "fail", detail=reason)
            return GateFailure(reason, prompt, run.agent_log or run.run_dir)
        log_file = next_log(run.run_dir, "ticket-gate", ".log")
        command = self.config.ticket_gate
        if self.gate(
            command, run.worktree, self.config.stack_env(run.slot, run.ticket.key), log_file, run.ticket.key
        ):
            return self.acceptance_check(run)
        reason = f"The ticket gate `{' '.join(command)}` failed. The log is {log_file}."
        prompt = (
            f"The ticket gate `{' '.join(command)}` failed. Fix the cause and commit the fix.\n"
            f"The end of the log:\n\n{tail(log_file.read_text())}"
        )
        return GateFailure(reason, prompt, log_file)

    def acceptance_check(self, run: TicketRun) -> GateFailure | None:
        """Each line of what the user sees has an acceptance test whose title is the line. The merge gate
        runs the tests, and the UI review looks at their screenshots.
        """
        command = self.config.acceptance_list
        lines = user_sees(run.ticket.text, self.config.acceptance_heading)
        if command is None or not lines:
            return None
        key = run.ticket.key
        listed = self.command(
            [part.replace("{key}", key) for part in command],
            run.worktree,
            self.config.stack_env(run.slot, key),
        )
        if listed.returncode != 0:
            reason = f"The acceptance list `{' '.join(command)}` failed."
            prompt = f"{reason} Fix the cause and commit the fix.\n\n{tail(listed.stdout + listed.stderr)}"
            self.log(key, "ticket-gate", "fail", detail=reason)
            return GateFailure(reason, prompt, run.agent_log or run.run_dir)
        titles = {normal(title) for title in listed.stdout.splitlines()}
        missing = [line for line in lines if normal(line) not in titles]
        if not missing:
            return None
        reason = f"{len(missing)} lines of what the user sees have no acceptance test."
        self.log(key, "ticket-gate", "fail", detail=reason)
        listed_lines = "\n".join(f"- {line}" for line in missing)
        prompt = ACCEPTANCE_PROMPT.format(missing=listed_lines, key=key)
        return GateFailure(reason, prompt, run.agent_log or run.run_dir)

    def code_review(self, run: TicketRun) -> GateFailure | None:
        """`/code-review` in its own session. Its findings go back to the head agent's session."""
        key = run.ticket.key
        reviewed = run.run_dir / CODE_REVIEWED_FILE
        if reviewed.exists():
            return None
        prompt = CODE_REVIEW_PROMPT.format(base=self.epic_branch, ticket=run.run_dir / "ticket.md")
        review = self.review_agent(run, prompt, f"{key}-review")
        reviewed.write_text("done\n")
        if not review.findings:
            self.log(key, "code-review", "pass")
            return None
        self.log(key, "code-review", "findings", detail=f"{len(review.findings)} findings")
        reason = "The code review found problems."
        fix = self.fix_prompt("code review", review.findings, key)
        (run.run_dir / CODE_REVIEW_FIX_FILE).write_text(fix)
        return GateFailure(reason, fix, run.agent_log or run.run_dir, attempt=False)

    def ui_gate(self, run: TicketRun) -> GateFailure | None:
        """A diff that touches a UI path lands only after a UI review of its last commit, with screenshots."""
        key = run.ticket.key
        changed = out(run.worktree, "diff", "--name-only", f"{self.epic_branch}...HEAD").splitlines()
        run.ui_touched = any(self.is_ui_path(path) for path in changed)
        if not run.ui_touched:
            return None
        head = out(run.worktree, "rev-parse", "HEAD")
        reviewed = run.run_dir / UI_COMMIT_FILE
        if screenshots(run.run_dir) and reviewed.exists():
            seen = reviewed.read_text().strip()
            if seen == head:
                self.log(key, "ui-gate", "pass", commit=head, detail="The screenshots show this commit.")
                return None
            if self.ui_diff(run, seen) == self.ui_diff(run, head):
                reviewed.write_text(head + "\n")
                self.log(
                    key, "ui-gate", "pass", commit=head, detail=f"The UI code is the same as at {seen[:7]}."
                )
                return None
        reviewed.unlink(missing_ok=True)
        (run.run_dir / UI_OPEN_FILE).unlink(missing_ok=True)
        for shot in screenshots(run.run_dir):
            shot.unlink()
        skill = self.config.ui_skill
        prompt = UI_REVIEW_PROMPT.format(skill=skill, run_dir=run.run_dir, base=self.epic_branch)
        review = self.review_agent(run, prompt, f"{key}-ui")
        if review.findings and run.ui_fix_rounds < UI_FIX_ROUNDS:
            run.ui_fix_rounds += 1
            self.log(key, "ui-gate", "fail", detail=f"{len(review.findings)} faults")
            fix = self.fix_prompt("UI review", review.findings, key)
            return GateFailure(
                "The UI review found faults.", fix, run.agent_log or run.run_dir, attempt=False
            )
        if not screenshots(run.run_dir):
            raise AgentFailed(f"The UI review saved no screenshots in {run.run_dir}.")
        reviewed.write_text(head + "\n")
        accepted = [part for part in review.unchecked if self.accepted_unchecked(part)]
        left = [f"UI fault left unfixed: {fault}" for fault in review.findings]
        left += [f"Not checked: {part}" for part in review.unchecked if part not in accepted]
        self.record_notes(run.ticket, [f"Not checked, and accepted in loop.toml: {p}" for p in accepted])
        if left:
            (run.run_dir / UI_OPEN_FILE).write_text(json.dumps(left))
            self.log(key, "ui-gate", "open", commit=head, detail=f"{len(left)} items")
            self.track(key, "comment", lambda: self.tracker.comment(key, self.bullets(UI_OPEN_COMMENT, left)))
        else:
            self.log(key, "ui-gate", "pass", commit=head)
        return None

    def accepted_unchecked(self, part: str) -> bool:
        """Whether `loop.toml` accepts a part that the UI review could not check, by a phrase in its text."""
        return any(phrase.lower() in part.lower() for phrase in self.config.ui_accepted_unchecked)

    def ui_open(self) -> dict[str, int]:
        """For each ticket of the Epic, how many items its UI review left open."""
        found: dict[str, int] = {}
        for ticket in self.tracker.children(self.epic_key):
            marked = self.home / "runs" / ticket.key / UI_OPEN_FILE
            if marked.exists():
                found[self.ticket_label(ticket)] = len(json.loads(marked.read_text()))
        return found

    def ui_diff(self, run: TicketRun, rev: str) -> str:
        """The ticket's own change to the UI paths at `rev`, with no context lines, so that a commit that
        changes no UI code, or a merge of the Epic branch, gives the same text as the commit before it."""
        span = f"{self.epic_branch}...{rev}"
        names = [
            name
            for name in out(run.worktree, "diff", "--name-only", span).splitlines()
            if self.is_ui_path(name)
        ]
        return out(run.worktree, "diff", "-U0", span, "--", *names) if names else ""

    def review_agent(self, run: TicketRun, prompt: str, name: str) -> AgentResult:
        """A review session with an empty context. A blocked review makes the ticket stuck."""
        review = self.agent(
            run, prompt, None, name=name, schema=REVIEW_SCHEMA, model=REVIEW_MODEL, effort=REVIEW_EFFORT
        )
        if review.status == "blocked":
            raise AgentFailed(f"The review {name} is blocked: {review.reason}")
        return review

    def fix_prompt(self, review: str, findings: list[str], key: str) -> str:
        listed = "\n".join(f"- {finding}" for finding in findings)
        return REVIEW_FIX_PROMPT.format(review=review, findings=listed, key=key)

    def is_ui_path(self, path: str) -> bool:
        name = path.rsplit("/", 1)[-1]
        is_test = ".test." in name or ".spec." in name or "/__tests__/" in path
        ui_path = self.config.ui_path
        return ui_path is not None and path.startswith(ui_path) and not is_test

    def land(self, run: TicketRun) -> GateFailure | None:
        """Merges the ticket into the Epic branch, one ticket at a time, and records it as landed.

        A conflict or a failed merge gate returns a failure, so that the agent fixes it on the ticket branch.
        """
        key = run.ticket.key
        with self._land_lock:
            failure = self.merge_into_epic(run)
        if failure:
            return failure
        if run.ui_touched:
            shots = screenshots(run.run_dir)
            self.track(key, "attach", lambda: self.tracker.attach(key, shots))
        self.track(key, "status", lambda: self.tracker.transition(key, self.config.landed_status))
        self.stack_down(run.worktree, run.slot, key, volumes=True)
        with self._repo_lock:
            git(self.repo, "worktree", "remove", "--force", str(run.worktree), check=False)
        return None

    def merge_into_epic(self, run: TicketRun) -> GateFailure | None:
        """Merges the ticket branch on a detached HEAD, runs the merge gate, and moves the Epic branch.

        The Epic branch moves only when the merge gate passes, so the frontier never counts a merge that the
        gate can still undo.
        """
        key = run.ticket.key
        epic = self.epic_worktree
        git(epic, "switch", "--quiet", "--detach", self.epic_branch)
        try:
            message = f"merge({key}): {run.ticket.summary}"
            merge = git(epic, "merge", "--no-ff", run.branch, "-m", message, check=False)
            if merge.returncode != 0:
                log_file = run.run_dir / "merge.log"
                log_file.write_text(merge.stdout + merge.stderr)
                git(epic, "merge", "--abort", check=False)
                self.log(key, "land", "conflict", detail=str(log_file))
                prompt = (
                    f"Another ticket landed on the Epic branch `{self.epic_branch}`, "
                    "and this branch no longer merges into it."
                )
                return GateFailure(
                    "The merge into the Epic branch has a conflict.", prompt, log_file, on_epic=True
                )
            log_file = next_log(run.run_dir, "merge-gate", ".log")
            command = self.config.merge_gate
            if not self.gate(command, epic, self.config.stack_env(EPIC_SLOT, self.epic_key), log_file, key):
                gate = " ".join(command)
                prompt = (
                    f"The merge gate `{gate}` failed on the Epic branch with this branch merged in. "
                    f"Fix the cause and commit the fix.\nThe end of the log:\n\n{tail(log_file.read_text())}"
                )
                return GateFailure(
                    f"The merge gate `{gate}` failed on the Epic branch.", prompt, log_file, on_epic=True
                )
            commit = out(epic, "rev-parse", "HEAD")
            git(epic, "branch", "--force", self.epic_branch, commit)
            self.log(key, "land", "landed", commit=commit)
            # On origin, the landed work outlives this host. A failed push is logged, and the run goes on.
            self.push(epic, self.epic_branch, key)
            return None
        finally:
            git(epic, "reset", "--hard", "--quiet")
            git(epic, "switch", "--quiet", self.epic_branch)

    def merge_epic(self, run: TicketRun, failure: GateFailure) -> GateFailure:
        """Merges the Epic branch into the ticket branch, so the agent fixes the code the Epic branch gets.

        A conflict is left for the agent to resolve.
        """
        git(run.worktree, "merge", "--no-ff", "--no-edit", self.epic_branch, check=False)
        conflicts = out(run.worktree, "diff", "--name-only", "--diff-filter=U")
        result = "conflict" if conflicts else "ok"
        self.log(run.ticket.key, "merge-epic", result, detail=conflicts.replace("\n", " "))
        # The merge can bring in migrations that run before ones this database already holds, and the next
        # start of the stack then skips them. A new volume builds the database from the whole chain.
        self.stack_down(run.worktree, run.slot, run.ticket.key, volumes=True)
        if conflicts:
            merged = (
                "The loop started a merge of the Epic branch into this branch. Resolve the conflicts "
                f"in these files, keep the changes of both sides, and commit the merge:\n{conflicts}"
            )
        else:
            merged = "The loop merged the Epic branch into this branch."
        return GateFailure(failure.reason, f"{failure.prompt}\n\n{merged}", failure.log)

    def stuck(self, ticket: Ticket, reason: str, log: Path, slot: int) -> Outcome:
        """Flags the ticket, comments the reason and the log path, and notifies.

        Other tickets keep running.
        """
        key = ticket.key
        self.log(key, "stuck", "stuck", detail=f"{reason} {log}")
        self.track(key, "flag", lambda: self.tracker.flag(key))
        comment = f"{STUCK_COMMENT}\n{reason}\nThe log is {log} on {os.uname().nodename}."
        self.track(key, "comment", lambda: self.tracker.comment(key, comment))
        self.notify(f"{key} stuck")
        # The containers stop so that the slot ports are free. The volume stays for KC.
        self.stack_down(self.home / "worktrees" / key, slot, key, volumes=False)
        return "stuck"

    # --- Finish ---

    def finish(self) -> int:
        """Runs the merge gate on the Epic branch and opens the Epic PR."""
        key = self.epic_key
        if not self.sync_base():
            return 1
        base = f"origin/{self.base}"
        if out(self.epic_worktree, "rev-list", "--count", f"{base}..HEAD") == "0":
            self.log(key, "finish", "nothing-landed")
            self.notify(f"{key} stopped")
            return 1
        run_dir = self.home / "runs" / key
        run_dir.mkdir(parents=True, exist_ok=True)
        run = TicketRun(
            self.tracker.issue(key), EPIC_SLOT, self.epic_branch, self.epic_worktree, run_dir, restart=False
        )
        merge_base = out(self.epic_worktree, "merge-base", base, "HEAD")
        # The ticket reviews already ran at landing, so the finish only runs the merge gate, which is the
        # only test gate here, and leaves the review of the whole Epic to KC.
        failing: tuple[str, Path] | None = None
        log_file = run_dir / "finish-merge-gate.log"
        command = self.config.merge_gate
        if not self.gate(command, self.epic_worktree, self.config.stack_env(EPIC_SLOT, key), log_file, key):
            failing = (" ".join(command), log_file)
        self.push(self.epic_worktree, self.epic_branch, key)
        demo_failing = self.point_demo(run_dir)
        body = self.pr_body(run, merge_base)
        return self.open_pr(failing, body, demo_failing)

    def point_demo(self, run_dir: Path) -> tuple[str, Path] | None:
        """Points the always-on demo at the Epic branch. Returns the command and its log when it fails."""
        demo = self.config.demo
        if demo is None:
            return None
        command = tuple(item.replace("{branch}", self.epic_branch) for item in demo.command)
        log_file = run_dir / "finish-demo.log"
        passed = self.limited(command, self.epic_worktree, self.child_env(), log_file, "demo command") == 0
        self.log(self.epic_key, "demo", "ok" if passed else "fail", detail=str(log_file))
        return None if passed else (" ".join(command), log_file)

    def pr_body(self, run: TicketRun, merge_base: str) -> str:
        """The body an agent writes with the `pr` skill, or a table of the tickets when it writes none."""
        key = self.epic_key
        tickets = ["| Ticket | Result |", "| ------ | ------ |"]
        for ticket in self.tracker.children(key):
            tickets.append(f"| {self.ticket_label(ticket)} | {self.ticket_result(ticket)} |")
        table = "\n".join(tickets)
        body_file = run.run_dir / "pr-body.md"
        body_file.unlink(missing_ok=True)
        prompt = PR_PROMPT.format(merge_base=merge_base, body_file=body_file, tickets=table)
        if self.config.name_landed_keys_only:
            prompt += LANDED_KEYS_PROMPT
        try:
            self.agent(
                run,
                prompt,
                session=None,
                name=f"{key}-pr",
                model=self.config.agent_model,
                effort=self.config.agent_effort,
            )
        except (AgentFailed, UsageLimit) as error:
            self.log(key, "pr-body", "fail", detail=str(error))
        written = body_file.read_text() if body_file.exists() else ""
        if "## Summary" in written:
            return written
        self.log(key, "pr-body", "fallback")
        return f"Builds the Epic {key}: {self.epic_summary}.\n\n{table}\n"

    def open_pr(
        self, failing: tuple[str, Path] | None, body: str, demo_failing: tuple[str, Path] | None = None
    ) -> int:
        """Opens the Epic PR, or updates the one an earlier run opened. Unfinished work makes it a draft."""
        key = self.epic_key
        unfinished = [
            self.ticket_label(ticket)
            for ticket in self.tracker.children(key)
            if self.ticket_result(ticket) in UNFINISHED
        ]
        ui_open = self.ui_open()
        draft = bool(failing or demo_failing or unfinished or ui_open)
        body_file = self.home / "runs" / key / "pr-body.md"
        demo = f"**Demo:** {self.config.demo.url}\n\n" if self.config.demo and not demo_failing else ""
        body_file.write_text(demo + self.pr_notes(failing, unfinished, ui_open, demo_failing) + body)
        state = "pr-draft" if draft else "pr-open"
        listed = ["gh", "pr", "list", "--head", self.epic_branch, "--state", "open", "--json", "url"]
        existing = self.command([*listed, "--jq", ".[].url"], self.epic_worktree).stdout.strip()
        if existing:
            self.command(["gh", "pr", "edit", existing, "--body-file", str(body_file)], self.epic_worktree)
            ready = ["gh", "pr", "ready", existing, *(["--undo"] if draft else [])]
            self.command(ready, self.epic_worktree)
            self.log(key, "pr", state, detail=existing)
            self.notify(f"{key} {state}")
            return 0
        summary = self.epic_summary[:1].lower() + self.epic_summary[1:]
        create = [
            "gh", "pr", "create", "--base", self.base, "--head", self.epic_branch,
            "--title", f"feat({key}): {summary}", "--body-file", str(body_file),
            *(["--draft"] if draft else []),
        ]  # fmt: skip
        created = self.command(create, self.epic_worktree)
        if created.returncode != 0:
            self.log(key, "pr", "fail", detail=created.stderr.strip()[-300:])
            self.notify(f"{key} stopped")
            return 1
        self.log(key, "pr", state, detail=created.stdout.strip())
        self.notify(f"{key} {state}")
        return 0

    def pr_notes(
        self,
        failing: tuple[str, Path] | None,
        unfinished: list[str],
        ui_open: Mapping[str, int],
        demo_failing: tuple[str, Path] | None = None,
    ) -> str:
        """What stops the Epic PR from being ready: unfinished tickets, a failing gate, a failed demo command,
        open UI items.

        A PR with none of these has no notes, because it is ready to merge. The agents' decisions and notes
        stay in the ticket comments.
        """
        lines: list[str] = []
        if unfinished:
            lines += [f"**Unfinished tickets:** {', '.join(unfinished)}.", ""]
        if failing:
            lines += [f"**Failing gate:** `{failing[0]}`. The log is `{failing[1]}`.", ""]
        if demo_failing:
            lines += [f"**Demo failed:** `{demo_failing[0]}`. The log is `{demo_failing[1]}`.", ""]
        if ui_open:
            counts = ", ".join(f"{label} ({count})" for label, count in ui_open.items())
            lines += [f"**UI review left open:** {counts}. The ticket comment lists each item.", ""]
        return "\n".join(lines)

    def ticket_label(self, ticket: Ticket) -> str:
        """The key, or the summary of a ticket that did not land when `name_landed_keys_only` is on."""
        if not self.config.name_landed_keys_only or ticket.key == self.epic_key:
            return ticket.key
        return ticket.key if repo.landed(self.repo, self.epic_branch, ticket.key) else ticket.summary

    def ticket_result(self, ticket: Ticket) -> str:
        if repo.landed(self.repo, self.epic_branch, ticket.key):
            return "Landed"
        if ticket.done:
            return NOT_LANDED if self.not_landed(ticket) else "Done before this run"
        if ticket.flagged:
            return "Stuck"
        return "Not built"

    def not_landed(self, ticket: Ticket) -> bool:
        """Whether the ticket's branch holds work that is on neither main nor the Epic branch."""
        branch = repo.find_branch(self.repo, ticket.key)
        if branch is None:
            return False
        ref = branch if repo.has_ref(self.repo, f"refs/heads/{branch}") else f"origin/{branch}"
        bases = (f"origin/{self.base}", self.epic_branch)
        return all(repo.adds_to(self.repo, ref, base) for base in bases)

    # --- Commands ---

    def agent(
        self,
        run: TicketRun,
        prompt: str,
        session: str | None,
        name: str | None = None,
        schema: str = AGENT_SCHEMA,
        model: str | None = None,
        effort: str | None = None,
    ) -> AgentResult:
        """Runs `claude -p` with an empty context, or resumes a session.

        A usage limit that resets soon pauses the run, and the session then resumes where it stopped. A
        `blocked` status that came while subagents still ran resumes the session once, so it can finish.
        """
        name = name or run.ticket.key
        resumed = False
        while True:
            try:
                result = self.agent_run(run, prompt, session, name, schema, model, effort)
            except UsageLimit as error:
                if error.reset is None or error.reset - time.time() > MAX_USAGE_WAIT_SECONDS:
                    raise
                self.pause_until(error.reset, name)
                if error.session:
                    prompt, session = USAGE_RESUME_PROMPT, error.session
                continue
            if result.status == "blocked" and result.subagents_running and not resumed:
                detail = f"The status came while {result.subagents_running} subagents still ran."
                self.log(name, "agent", "early-status", session=result.session, detail=detail)
                prompt, session, resumed = EARLY_STATUS_PROMPT, result.session, True
                continue
            return result

    def pause_until(self, reset: float, name: str) -> None:
        """Waits for the usage limit to reset. Parallel runs that hit the same limit notify once."""
        until = datetime.fromtimestamp(reset, UTC).isoformat(timespec="seconds")
        self.log(name, "agent", "usage-pause", detail=f"The usage limit resets at {until}.")
        with self._pause_lock:
            if reset > self.paused_until:
                self.paused_until = reset
                self.notify(f"{self.epic_key} paused")
        # A minute past the reset, so the limit is surely clear.
        pause(max(0.0, reset - time.time()) + 60)

    def agent_command(
        self,
        run: TicketRun,
        prompt: str,
        session: str | None,
        name: str,
        schema: str,
        model: str | None,
        effort: str | None,
    ) -> list[str]:
        command = [
            "timeout",
            "--kill-after=60",
            f"{self.config.agent_timeout_minutes}m",
            "claude",
            "-p",
            prompt,
        ]
        if session:
            command += ["--resume", session]
        if model:
            command += ["--model", model]
        if effort:
            command += ["--effort", effort]
        # The window the session compacts at, so a long ticket never sends more than this on each turn.
        command += ["--autocompact", str(self.config.agent_context_tokens)]
        # Each worktree is a new folder, where nobody approved the project `.mcp.json`, so the flag keeps the
        # run from waiting on that approval. The strict flag leaves out the host's plugin servers and
        # claude.ai connectors, whose tools and instructions every turn would send again.
        mcp = run.worktree / ".mcp.json"
        if mcp.exists():
            command += ["--mcp-config", str(mcp), "--strict-mcp-config"]
        command += [
            "--permission-mode", "auto", "--permission-prompts", "none",
            "--output-format", "stream-json", "--verbose", "--json-schema", schema, "-n", name,
            "--agents", json.dumps(tiers.load()), "--append-system-prompt", DISPATCH.read_text(),
            "--settings", self.settings,
        ]  # fmt: skip
        return command

    def agent_run(
        self,
        run: TicketRun,
        prompt: str,
        session: str | None,
        name: str,
        schema: str,
        model: str | None,
        effort: str | None,
    ) -> AgentResult:
        command = self.agent_command(run, prompt, session, name, schema, model, effort)
        env = {
            **self.child_env(),
            **self.config.stack_env(run.slot, run.ticket.key),
            **self.secrets,
            "LOOP_RUN_DIR": str(run.run_dir),
        }
        run.agent_log = next_log(run.run_dir, "agent", ".jsonl")
        errors_log = run.agent_log.with_suffix(".err")
        with run.agent_log.open("w") as stdout, errors_log.open("w") as stderr:
            process = subprocess.Popen(command, cwd=run.worktree, env=env, stdout=stdout, stderr=stderr)
            returncode, cut_short = self.wait_for_agent(process, run.agent_log, name)
        errors = errors_log.read_text()
        # Each turn ends with a result event. A background subagent that finishes after the status
        # wakes the session for one more turn, and that turn's result can have no status.
        events = json_lines(run.agent_log.read_text())
        results = [event for event in events if event.get("type") == "result"]
        data = results[-1] if results else {}
        cost, plan = agent_usage(data, events), agent_plan(events)
        if returncode == TIMED_OUT and not cut_short:
            self.log(name, "agent", "timeout", session=session, usage=cost, plan=plan)
            raise AgentFailed(f"The agent ran past {self.config.agent_timeout_minutes} minutes.")
        message = f"{data.get('result', '')}\n{errors}"
        if data.get("is_error") or not data:
            if data.get("api_error_status") in (429, "429") or USAGE_LIMIT.search(message):
                started = next((event.get("session_id") for event in events if event.get("session_id")), None)
                stopped = data.get("session_id") or started or session
                detail = f"{name}: {message.strip()[:200]}"
                # The run that meets the limit moved the meter most, so its line keeps the plan.
                self.log(name, "agent", "usage-limit", session=stopped, detail=detail, usage=cost, plan=plan)
                raise UsageLimit(detail, usage_reset(events), stopped)
            self.log(name, "agent", "error", session=data.get("session_id"), usage=cost, plan=plan)
            raise AgentFailed(f"The agent exited with code {returncode}: {message.strip()[:300]}")
        output = next(filter(None, map(agent_status, reversed(results))), None)
        if output is None:
            raise AgentFailed("The agent returned no status.")
        status = output["status"]
        reason = str(output.get("reason", ""))
        session_id = str(data.get("session_id") or session or "")
        commit = out(run.worktree, "rev-parse", "HEAD")
        self.log(
            name, "agent", status, commit=commit, session=session_id, detail=reason, usage=cost, plan=plan
        )
        self.record_decisions(run.ticket, [str(item) for item in output.get("decisions", [])])
        self.record_notes(run.ticket, [str(item) for item in output.get("notes", [])])
        findings = [str(item) for item in output.get("findings", [])]
        unchecked = [str(item) for item in output.get("unchecked", [])]
        return AgentResult(status, reason, session_id, findings, unchecked, subagents_at_status(events))

    def record_decisions(self, ticket: Ticket, decisions: list[str]) -> None:
        """Comments the open questions on the ticket. They stay out of the Epic PR."""
        if decisions:
            text = self.bullets(DECISIONS_COMMENT, decisions)
            self.track(ticket.key, "comment", lambda: self.tracker.comment(ticket.key, text))

    def record_notes(self, ticket: Ticket, notes: list[str]) -> None:
        """Comments the notes on the ticket. They stay out of the Epic PR."""
        if notes:
            text = self.bullets(NOTES_COMMENT, notes)
            self.track(ticket.key, "comment", lambda: self.tracker.comment(ticket.key, text))

    @staticmethod
    def bullets(heading: str, items: list[str]) -> str:
        return heading + "\n" + "\n".join(f"- {item}" for item in items)

    def wait_for_agent(self, process: subprocess.Popen[bytes], log: Path, name: str) -> tuple[int, bool]:
        """Waits for the agent to exit. Returns its exit code, and whether the loop stopped it.

        `claude -p` does not exit while a background task runs, such as the dev server that a UI review
        starts, and the task can run until its own time limit. The loop stops a session that has given
        its status and has not exited in the grace time, as the status is its last word. A late turn
        that comes within the grace time still counts, and only a subagent that ran at the status gets
        the long grace.
        """
        given: float | None = None
        grace = EXIT_GRACE_SECONDS
        size = -1
        while True:
            try:
                return process.wait(timeout=EXIT_POLL_SECONDS), False
            except subprocess.TimeoutExpired:
                pass
            if given is None and log.stat().st_size != size:
                size = log.stat().st_size
                events = json_lines(log.read_text())
                if any(agent_status(event) for event in events if event.get("type") == "result"):
                    given = time.monotonic()
                    grace = EXIT_GRACE_SECONDS if subagents_at_status(events) else IDLE_GRACE_SECONDS
            elif given is not None and time.monotonic() - given >= grace:
                events = json_lines(log.read_text())
                tasks = [str(task.get("description", "")) for task in background_tasks(events)]
                running = f", with these background tasks: {'; '.join(tasks)}" if tasks else ""
                session = next((event["session_id"] for event in events if event.get("session_id")), None)
                detail = f"The session kept running after its status{running}."
                self.log(name, "agent", "stopped", session=session, detail=detail)
                # `timeout` passes the signal on to the whole group that it started.
                process.terminate()
                try:
                    return process.wait(timeout=75), True
                except subprocess.TimeoutExpired:
                    process.kill()
                    return process.wait(), True

    def gate(
        self, command: tuple[str, ...], cwd: Path, stack: dict[str, str], log_file: Path, key: str
    ) -> bool:
        """Runs a gate under `timeout`, as the agent runs, so that a gate past its limit stops with its child
        processes. The output goes to the log file, so the run waits on no pipe that a child holds open.
        """
        env = {**self.child_env(), **stack}
        if stack:
            # A container from a start that failed, such as on a port that was in use, can start later
            # with no published port. A gate on new containers does not depend on an earlier start.
            self.command(["docker", "compose", "down"], cwd, stack)
        passed = self.limited(command, cwd, env, log_file, "gate") == 0
        commit = out(cwd, "rev-parse", "HEAD")
        self.log(key, " ".join(command), "pass" if passed else "fail", commit=commit, detail=str(log_file))
        return passed

    def limited(
        self, command: tuple[str, ...], cwd: Path, env: dict[str, str], log_file: Path, what: str
    ) -> int:
        """Runs a command under `timeout` at the gate timeout, with its output in the log file."""
        limit = f"{self.config.gate_timeout_minutes}m"
        with log_file.open("w") as log:
            wrapped = ["timeout", "--kill-after=60", limit, *command]
            result = subprocess.run(wrapped, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
        if result.returncode == TIMED_OUT:
            with log_file.open("a") as log:
                log.write(f"The {what} ran past {self.config.gate_timeout_minutes} minutes.\n")
        return result.returncode

    def push(self, worktree: Path, branch: str, key: str) -> None:
        result = git(worktree, "push", "--set-upstream", "origin", branch, check=False)
        self.log(key, "push", "ok" if result.returncode == 0 else "fail", detail=result.stderr.strip()[-300:])

    def stop_stale_stacks(self) -> None:
        """Stops the Compose projects of earlier runs, which hold the ports of the slots.

        The run lock lets one run go at a time, so no other run uses them. The volumes stay for KC.
        """
        if self.config.stack is None:
            return
        listed = self.command(["docker", "compose", "ls", "--all", "--format", "json"], self.home)
        projects = json.loads(listed.stdout or "[]") if listed.returncode == 0 else []
        # The projects are `<name>-<key>`, as in `stack_env`. The main checkout's project has no key.
        ours = re.compile(rf"{re.escape(self.config.name)}-[a-z][a-z0-9_]*-[0-9]+")
        for project in projects:
            name = project.get("Name", "")
            if ours.fullmatch(name):
                down = self.command(["docker", "compose", "--project-name", name, "down"], self.home)
                result = "ok" if down.returncode == 0 else "fail"
                self.log(self.epic_key, "stop-stale-stack", result, detail=name)

    def stack_down(self, worktree: Path, slot: int, key: str, volumes: bool) -> None:
        if self.config.stack is None or not worktree.exists():
            return
        command = ["docker", "compose", "down", *(["--volumes"] if volumes else [])]
        self.command(command, worktree, self.config.stack_env(slot, key))

    def command(
        self, command: list[str], cwd: Path, stack: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        env = {**self.child_env(), **(stack or {})}
        return subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True)

    def child_env(self) -> dict[str, str]:
        # The Bitwarden session key unlocks the whole vault, so no child process gets it.
        return {name: value for name, value in os.environ.items() if name != "BW_SESSION"}

    # --- Records ---

    def write_ticket_file(self, run: TicketRun, gate: tuple[str, ...], reviews: bool = False) -> None:
        """The ticket text, its comments, and how the loop runs it. The gate is the one the loop checks this
        work with. With `reviews`, the loop runs the reviews after the agent, in their own sessions.
        """
        ticket = run.ticket
        text = f"# {ticket.key}: {ticket.summary}\n\n{ticket.text.strip()}\n\n"
        comments = self.comments(ticket.key)
        if comments:
            text += "## Comments\n\nThe comments on the ticket, oldest first, without the loop's own.\n\n"
            text += "\n\n---\n\n".join(comments) + "\n\n"
        text += (
            "## Loop\n\n"
            f"- The Epic is {self.epic_key}. The Epic branch is `{self.epic_branch}`.\n"
            f"- Commit on the branch `{run.branch}` with {ticket.key} as the commit scope. "
            "Do not push, and do not open a pull request.\n"
            f"- The run folder is `{run.run_dir}`."
            + ("\n" if reviews else " A UI review saves its screenshots there.\n")
            + f"- The loop checks this work with `{shlex.join(gate)}`. Make it pass before you return done.\n"
        )
        if reviews:
            text += (
                "- When the gate passes, the loop runs the code review, and the UI review for a UI change, "
                "in their own sessions, and sends you what they find. Return done when the work is committed "
                "and the gate passes.\n"
            )
        if self.config.agent_hint:
            text += f"- {self.config.agent_hint}\n"
        (run.run_dir / "ticket.md").write_text(text)

    def write_board(self, tickets: list[Ticket], landed: set[str]) -> None:
        """The tickets as the frontier last read them, for `loop watch`, which reads no tracker."""
        board = {
            "time": datetime.now(UTC).isoformat(timespec="seconds"),
            "epic": self.epic_key,
            "summary": self.epic_summary,
            "branch": self.epic_branch,
            "tickets": [
                {
                    "key": ticket.key,
                    "summary": ticket.summary,
                    "status": ticket.status,
                    "done": ticket.done,
                    "flagged": ticket.flagged,
                    "landed": ticket.key in landed,
                    "blockers": [
                        {"key": blocker.key, "done": blocker.done or blocker.key in landed}
                        for blocker in ticket.blockers
                    ],
                }
                for ticket in tickets
            ],
        }
        path = self.home / BOARD
        # A reader never sees half a file.
        path.with_suffix(".tmp").write_text(json.dumps(board))
        path.with_suffix(".tmp").replace(path)

    def comments(self, key: str) -> list[str]:
        """The comments on the ticket other than the loop's own. A failed read is logged and gives none."""
        try:
            comments = self.tracker.comments(key)
        except Exception as error:  # noqa: BLE001 - a failed read never makes the ticket stuck.
            self.log(key, "tracker-comments", "fail", detail=str(error))
            return []
        own = (STUCK_COMMENT, DECISIONS_COMMENT, NOTES_COMMENT, UI_OPEN_COMMENT)
        return [text for text in comments if text and not text.startswith(own)]

    def track(self, key: str, step: str, call: Callable[[], object]) -> None:
        """A tracker call that fails is logged. It does not stop the ticket."""
        try:
            result = call()
            self.log(key, f"tracker-{step}", "fail" if result is False else "ok")
        except TrackerError as error:
            self.log(key, f"tracker-{step}", "fail", detail=str(error))

    def notify(self, message: str) -> None:
        """An ntfy message holds the key and the status only."""
        url = f"{self.config.ntfy_url.rstrip('/')}/{self.secrets['NTFY_TOPIC']}"
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=message.encode()), timeout=30):
                pass
            self.log(self.epic_key, "notify", "ok", detail=message)
        except OSError as error:
            self.log(self.epic_key, "notify", "fail", detail=f"{message}: {error}")

    def log(
        self,
        ticket: str,
        step: str,
        result: str,
        commit: str | None = None,
        session: str | None = None,
        detail: str = "",
        usage: dict[str, Any] | None = None,
        setup: dict[str, Any] | None = None,
        plan: dict[str, Any] | None = None,
    ) -> None:
        line: dict[str, Any] = {
            "time": datetime.now(UTC).isoformat(timespec="seconds"),
            "epic": self.epic_key,
            "ticket": ticket,
            "step": step,
            "result": result,
            "commit": commit,
            "session": session,
            "detail": detail,
        }
        if usage is not None:
            line["usage"] = usage
        if plan is not None:
            line["plan"] = plan
        if setup is not None:
            line["setup"] = setup
        with self._log_lock, self.log_path.open("a") as file:
            file.write(json.dumps(line) + "\n")
        print(f"{line['time']} {ticket} {step} {result} {detail}".rstrip(), flush=True)


def user_sees(text: str, heading: str) -> list[str]:
    """The list under the heading in the ticket text, such as "What the user sees.", one item per line."""
    items: list[str] = []
    inside = False
    for line in text.splitlines():
        bare = line.strip().strip("*#").strip()
        if not inside:
            inside = bare.lower().rstrip(".:").strip() == heading.lower()
            continue
        if line.startswith(("- ", "* ")):
            items.append(line[2:].strip())
        elif line.startswith("  ") and items:
            items[-1] += " " + line.strip()
        elif bare:
            break
    return items


def normal(text: str) -> str:
    return " ".join(text.split())


def screenshots(run_dir: Path) -> list[Path]:
    return sorted(path for path in run_dir.rglob("*") if path.suffix.lower() in IMAGE_SUFFIXES)


def run(epic_key: str, config: Config, secrets: Mapping[str, str], base: str | None = None) -> int:
    """The run entry. It returns 0 when the Epic PR is open, and 1 when the loop stopped early."""
    return EpicRun(epic_key, config, secrets, base).run()
