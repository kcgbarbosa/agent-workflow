from __future__ import annotations

import functools
import json
import os
import re
import shlex
import signal
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

from . import process, repo, tiers
from .claude import REVIEW_EFFORT, REVIEW_MODEL, TRIALS, agent_settings, run_setup
from .config import Config
from .prompts import (
    ACCEPTANCE_PROMPT,
    AGENT_SCHEMA,
    CODE_REVIEW_PROMPT,
    DECISIONS_COMMENT,
    DISPATCH,
    LANDED_KEYS_PROMPT,
    NOTES_COMMENT,
    PR_PROMPT,
    REVIEW_FIX_PROMPT,
    REVIEW_SCHEMA,
    STUCK_COMMENT,
    UI_FINISH_PROMPT,
    UI_OPEN_COMMENT,
    UI_REVIEW_PROMPT,
    USAGE_RESUME_PROMPT,
)
from .repo import git, out
from .report import read_lines
from .steps import UI_PASSED, next_step
from .stream import (
    after_status,
    agent_plan,
    agent_status,
    agent_usage,
    first_session,
    json_lines,
    meter_reader,
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
# The rounds of code review findings that are not a fix attempt. Findings after them use one, so a review
# that always finds something cannot keep a ticket running.
FREE_REVIEW_ROUNDS = 1
# The faults of a UI review go back to the head agent this often. A fault left after that lands with the
# ticket and keeps the Epic PR a draft, because it costs less to fix by hand than to review again.
UI_FIX_ROUNDS = 1
NO_BACKGROUND = {"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "1"}
# The loop stops a session that still runs this long after its status.
STATUS_GRACE_SECONDS = 10.0
LOG_TAIL_LINES = 80
# Slot 0 is the main checkout, and the Epic branch has its own slot.
EPIC_SLOT = 1

# A minute past the reset of a usage limit, so the limit is surely clear.
PAST_RESET_SECONDS = 60
# A wait for a usage limit looks this often for a stop.
PAUSE_STEP_SECONDS = 60.0

Outcome = Literal["landed", "stuck", "usage-limit"]
Handoff = Literal["built", "land"] | Outcome


class UsageLimit(Exception):
    def __init__(
        self, message: str, name: str, reset: float | None = None, session: str | None = None
    ) -> None:
        super().__init__(message)
        self.name = name
        self.reset = reset
        self.session = session


class AgentFailed(Exception):
    pass


class Stopped(BaseException):
    """SIGTERM stopped the run. It is no Exception, so no handler of a ticket's failure takes it."""


@dataclass
class AgentResult:
    status: Literal["done", "blocked"]
    reason: str
    session: str
    findings: list[str] = field(default_factory=list)
    unchecked: list[str] = field(default_factory=list)


@dataclass
class GateFailure:
    reason: str
    prompt: str
    log: Path
    # The failure is on the Epic branch, so the ticket branch takes the Epic branch before the fix.
    on_epic: bool = False
    # The first round of review findings is part of the build, not a fix attempt.
    attempt: bool = True


@dataclass
class TicketRun:
    ticket: Ticket
    slot: int
    branch: str
    worktree: Path
    run_dir: Path
    agent_log: Path | None = None
    # The head agent's session, and the failure that its next build fixes.
    session: str | None = None
    fix: str | None = None
    fix_attempt: bool = False
    # The agent run that a usage limit stopped, which resumes after the reset.
    limited: UsageLimit | None = None

    def resumes(self, name: str) -> bool:
        """Whether the agent run of this name goes on after a usage limit."""
        return self.limited is not None and self.limited.name == name


def next_log(run_dir: Path, stem: str, suffix: str) -> Path:
    """The next numbered log in the run folder, so that a restart keeps the logs of earlier runs."""
    number = len(list(run_dir.glob(f"{stem}-*{suffix}"))) + 1
    return run_dir / f"{stem}-{number}{suffix}"


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
        self.stuck_in_row = 0
        self.epic_branch = ""
        self.epic_worktree = self.home / "worktrees" / epic_key
        self.epic_summary = ""
        self.settings = agent_settings(config)
        self.paused_until = 0.0
        self.stopping = threading.Event()

    # --- Run ---

    def run(self) -> int:
        self.home.mkdir(parents=True, exist_ok=True)
        self.mend_log()
        try:
            self.stop_stale_stacks()
            return self._run()
        except Stopped:
            self.log(self.epic_key, "stop", "stopped")
            self.notify(f"{self.epic_key} stopped")
            # A stop between two commands of a step leaves that ticket's stack up.
            self.stop_stale_stacks()
            return 1
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
        repo.add_worktree(self.repo, self.epic_worktree, self.epic_branch, f"origin/{self.base}")
        # A kill in a landing can leave the Epic worktree on a merge that its gate never passed.
        git(self.epic_worktree, "reset", "--hard", "--quiet")
        git(self.epic_worktree, "switch", "--quiet", self.epic_branch)
        self.log(self.epic_key, "start", "ok", detail=self.epic_branch, setup=run_setup(self.config))
        if not self.sync_base():
            return 1
        self.recover()
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

    def recover(self) -> None:
        """Finishes each landing and each stuck step that a kill cut short. Git says what landed."""
        landed: set[str] = set()
        stuck: dict[str, dict[str, Any]] = {}
        for line in read_lines(self.log_path):
            key = str(line.get("ticket"))
            if line.get("step") == "land" and line.get("result") == "landed":
                landed.add(key)
            elif line.get("step") == "stuck":
                stuck[key] = line
        slot = EPIC_SLOT + 1
        for ticket in self.tracker.children(self.epic_key):
            key = ticket.key
            if key not in landed and repo.landed(self.repo, self.epic_branch, key):
                self.complete_landing(key, self.home / "worktrees" / key, slot)
            if key in stuck and stuck[key]["result"] == "started":
                line = stuck[key]
                self.finish_stuck(key, str(line.get("detail")), str(line.get("comment")), slot)

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
        """Runs every ticket on the frontier, with this thread as the integrator of rule 8. Returns the reason
        the loop stopped early."""
        running: dict[Future[Handoff], TicketRun] = {}
        finished: set[str] = set()
        free_slots = list(range(EPIC_SLOT + 1, EPIC_SLOT + 1 + self.config.parallel))
        stopped: str | None = None

        def end(key: str, slot: int, outcome: Outcome) -> None:
            nonlocal stopped
            finished.add(key)
            free_slots.append(slot)
            if outcome == "landed":
                self.stuck_in_row = 0
            elif outcome == "stuck":
                self.stuck_in_row += 1
                if self.stuck_in_row >= self.config.circuit_breaker:
                    stopped = "circuit-breaker"
            else:
                stopped = "usage-limit"

        with ThreadPoolExecutor(max_workers=self.config.parallel) as pool:

            def work(run: TicketRun) -> None:
                running[
                    pool.submit(self.guard, run.ticket, run.slot, functools.partial(self.advance, run), run)
                ] = run

            while True:
                self.stop_point()
                if not stopped:
                    busy = {run.ticket.key for run in running.values()} | finished
                    for ticket in self.frontier():
                        if not free_slots:
                            break
                        if ticket.key in busy:
                            continue
                        slot = free_slots.pop(0)
                        prepared = self.guard(ticket, slot, functools.partial(self.prepare, ticket, slot))
                        if isinstance(prepared, TicketRun):
                            work(prepared)
                        else:
                            end(ticket.key, slot, prepared)
                if not running:
                    return stopped
                done, _ = wait(running, return_when=FIRST_COMPLETED)
                for future in done:
                    run = running.pop(future)
                    integrate = functools.partial(self.integrate, run, future.result())
                    outcome = self.guard(run.ticket, run.slot, integrate, run)
                    if outcome is None:
                        work(run)
                    else:
                        end(run.ticket.key, run.slot, outcome)

    def integrate(self, run: TicketRun, handoff: Handoff) -> Outcome | None:
        """Does the integrator's part for a ticket that a worker hands over. None when the worker goes on."""
        self.remove_trials(run)
        if handoff == "built":
            return None
        if handoff == "land":
            return self.land(run)
        if handoff == "usage-limit" and run.limited and self.wait_out(run.limited):
            return None
        return handoff

    def guard[T](
        self, ticket: Ticket, slot: int, call: Callable[[], T], run: TicketRun | None = None
    ) -> T | Outcome:
        """Runs a part of the ticket's work. A failure makes the ticket stuck, not the run."""
        run_dir = self.home / "runs" / ticket.key
        try:
            return call()
        except AgentFailed as error:
            # The agent writes its error to the .err file next to its output.
            log = run.agent_log.with_suffix(".err") if run and run.agent_log else run_dir
            return self.stuck(ticket, str(error), log, slot)
        except UsageLimit as limit:
            if run:
                run.limited = limit
            return "usage-limit"
        except Exception as error:  # noqa: BLE001 - a loop error makes the ticket stuck, not the run.
            log = run_dir / "loop-error.log"
            log.write_text(traceback.format_exc())
            return self.stuck(ticket, f"The loop failed: {error}", log, slot)

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

    def prepare(self, ticket: Ticket, slot: int) -> TicketRun:
        """Gives the ticket a worktree, a branch off the Epic branch, and its ticket file."""
        run_dir = self.home / "runs" / ticket.key
        run_dir.mkdir(parents=True, exist_ok=True)
        existing = repo.find_branch(self.repo, ticket.key)
        kind = "fix" if ticket.issue_type == "Bug" else "feat"
        branch = existing or f"{kind}/{ticket.key}-{repo.slug(ticket.summary)}"
        worktree = self.home / "worktrees" / ticket.key
        repo.add_worktree(self.repo, worktree, branch, self.epic_branch)
        run = TicketRun(ticket, slot, branch, worktree, run_dir)
        self.write_ticket_file(run, self.config.ticket_gate, reviews=True)
        if ticket.status != self.config.in_progress:
            self.track(
                ticket.key, "status", lambda: self.tracker.transition(ticket.key, self.config.in_progress)
            )
        self.log(ticket.key, "start", "new" if existing is None else "restart", detail=branch)
        return run

    def advance(self, run: TicketRun) -> Handoff:
        """Takes the ticket, in a worker, from its first step with no pass at the branch's HEAD up to a build
        or the landing. A failed step goes back to the head agent, whose run is the build step again."""
        steps = {"ticket-gate": self.ticket_gate, "code-review": self.code_review, "ui-gate": self.ui_gate}
        while run.fix is None:
            step = self.next_step(run)
            if step == "land":
                return "land"
            if step == "build":
                break
            self.log(run.ticket.key, step, "started", commit=self.head(run))
            failure = steps[step](run)
            if failure and (stuck := self.send_back(run, failure)):
                return stuck
        return self.build(run)

    def send_back(self, run: TicketRun, failure: GateFailure) -> Outcome | None:
        """Makes the failure the fix of the next build, or the ticket stuck with no fix attempt left."""
        if failure.attempt and self.attempts(run.ticket.key) >= self.config.fix_attempts:
            return self.stuck(run.ticket, failure.reason, failure.log, run.slot)
        if failure.on_epic:
            failure = self.merge_epic(run, failure)
        run.fix, run.fix_attempt = failure.prompt, failure.attempt
        return None

    def attempts(self, key: str) -> int:
        """The fix attempts the ticket used since it was last stuck. A kill does not give them back."""
        return sum(1 for line in self.since_stuck(key) if line.get("step") == "build" and line.get("attempt"))

    def since_stuck(self, key: str) -> list[dict[str, Any]]:
        """The ticket's lines since it was last stuck, because KC unflags a stuck ticket to give it a new
        start."""
        lines = self.ticket_lines(key)
        ends = [
            n for n, line in enumerate(lines) if line.get("step") == "stuck" and line.get("result") == "stuck"
        ]
        return lines[ends[-1] + 1 :] if ends else lines

    def rounds(self, key: str, step: str, result: str) -> int:
        return sum(
            1 for line in self.since_stuck(key) if (line.get("step"), line.get("result")) == (step, result)
        )

    def next_step(self, run: TicketRun) -> str:
        head = self.head(run)
        ui = None
        own = self.ui_diff(run, head)
        if own:
            ui = functools.cache(lambda commit: self.ui_diff(run, commit) == own)
        return next_step(self.ticket_lines(run.ticket.key), head, ui)

    def build(self, run: TicketRun) -> Handoff:
        """A head agent run, then a push of the ticket branch, also when the run fails. A fix attempt is
        counted when the run starts, and a build that goes on after a usage limit is the same build."""
        key = run.ticket.key
        first = f"/implement {run.run_dir / 'ticket.md'}"
        if run.fix is None:
            prompt = first
        else:
            # A new session, as on a restart, gets the prompt of a first build with the fix.
            prompt = run.fix if run.session else f"{first}\n\n{run.fix}"
        if not run.resumes(key):
            self.log(key, "build", "started", commit=self.head(run), attempt=run.fix_attempt)
        try:
            result = self.agent(
                run, prompt, run.session, model=self.config.agent_model, effort=self.config.agent_effort
            )
        finally:
            self.push(run.worktree, run.branch, key)
        result_name = "pass" if result.status == "done" else "blocked"
        self.log(key, "build", result_name, commit=self.head(run), session=result.session)
        run.session, run.fix, run.fix_attempt = result.session, None, False
        if result.status == "blocked":
            reason = f"The agent is blocked: {result.reason}"
            return self.stuck(run.ticket, reason, run.agent_log or run.run_dir, run.slot)
        return "built"

    def remove_trials(self, run: TicketRun) -> None:
        """Removes the trial worktrees that the ticket's agent runs left, such as one of a trial that failed.

        A trial removes its own change when it reports, and Claude Code then removes its worktree.
        """
        base = f"origin/{self.base}"
        removed = repo.remove_trials(self.repo, TRIALS, run.branch, base)
        if removed:
            self.log(run.ticket.key, "trials", "removed", detail=" ".join(map(str, removed)))

    def ticket_gate(self, run: TicketRun) -> GateFailure | None:
        """The ticket gate. A tree with changes not committed, or no commit, fails it first."""
        head = self.head(run)
        dirty = out(run.worktree, "status", "--porcelain")
        ahead = out(run.worktree, "rev-list", "--count", f"{self.epic_branch}..HEAD")
        if dirty or ahead == "0":
            if dirty:
                reason = "The worktree has changes that are not committed."
                prompt = f"{reason} Commit them or remove them:\n{dirty}"
            else:
                reason = "The branch has no commit for the ticket."
                prompt = f"{reason} Build the ticket and commit the work."
            self.log(run.ticket.key, "ticket-gate", "fail", commit=head, detail=reason)
            return GateFailure(reason, prompt, run.agent_log or run.run_dir)
        log_file = next_log(run.run_dir, "ticket-gate", ".log")
        command = self.config.ticket_gate
        if self.gate(
            command, run.worktree, self.config.stack_env(run.slot, run.ticket.key), log_file, run.ticket.key
        ):
            failure = self.acceptance_check(run, head)
            if failure is None:
                self.log(run.ticket.key, "ticket-gate", "pass", commit=head)
            return failure
        reason = f"The ticket gate `{' '.join(command)}` failed. The log is {log_file}."
        prompt = (
            f"The ticket gate `{' '.join(command)}` failed. Fix the cause and commit the fix.\n"
            f"The end of the log:\n\n{tail(log_file.read_text())}"
        )
        return GateFailure(reason, prompt, log_file)

    def acceptance_check(self, run: TicketRun, head: str) -> GateFailure | None:
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
            self.log(key, "ticket-gate", "fail", commit=head, detail=reason)
            return GateFailure(reason, prompt, run.agent_log or run.run_dir)
        titles = {normal(title) for title in listed.stdout.splitlines()}
        missing = [line for line in lines if normal(line) not in titles]
        if not missing:
            return None
        reason = f"{len(missing)} lines of what the user sees have no acceptance test."
        self.log(key, "ticket-gate", "fail", commit=head, detail=reason)
        listed_lines = "\n".join(f"- {line}" for line in missing)
        prompt = ACCEPTANCE_PROMPT.format(missing=listed_lines, key=key)
        return GateFailure(reason, prompt, run.agent_log or run.run_dir)

    def code_review(self, run: TicketRun) -> GateFailure | None:
        """`/code-review` in its own session. Its findings go back to the head agent's session."""
        key, head = run.ticket.key, self.head(run)
        findings = self.unanswered(key, "code-review", head, "findings")
        if findings is None:
            prompt = CODE_REVIEW_PROMPT.format(base=self.epic_branch, ticket=run.run_dir / "ticket.md")
            findings = self.review_agent(run, prompt, f"{key}-review").findings
            if not findings:
                self.log(key, "code-review", "pass", commit=head)
                return None
            detail = f"{len(findings)} findings"
            self.log(key, "code-review", "findings", commit=head, detail=detail, findings=findings)
        fix = self.fix_prompt("code review", findings, key)
        attempt = self.rounds(key, "code-review", "findings") > FREE_REVIEW_ROUNDS
        return GateFailure(
            "The code review found problems.", fix, run.agent_log or run.run_dir, attempt=attempt
        )

    def ui_gate(self, run: TicketRun) -> GateFailure | None:
        """A UI review of the last commit, with screenshots. Its faults go back to the head agent."""
        key, head = run.ticket.key, self.head(run)
        faults = self.unanswered(key, "ui-gate", head, "fail")
        if faults is None:
            # A review that goes on after a usage limit keeps the screenshots it saved.
            for shot in [] if run.resumes(f"{key}-ui") else screenshots(run.run_dir):
                shot.unlink()
            prompt = UI_REVIEW_PROMPT.format(
                skill=self.config.ui_skill, run_dir=run.run_dir, base=self.epic_branch
            )
            review = self.review_agent(run, prompt, f"{key}-ui")
            if not review.findings or self.rounds(key, "ui-gate", "fail") >= UI_FIX_ROUNDS:
                if not screenshots(run.run_dir):
                    raise AgentFailed(f"The UI review saved no screenshots in {run.run_dir}.")
                self.record_ui_review(run, review, head)
                return None
            faults = review.findings
            self.log(key, "ui-gate", "fail", commit=head, detail=f"{len(faults)} faults", findings=faults)
        fix = self.fix_prompt("UI review", faults, key)
        return GateFailure("The UI review found faults.", fix, run.agent_log or run.run_dir, attempt=False)

    def unanswered(self, key: str, step: str, head: str, result: str) -> list[str] | None:
        """The findings of the step's last result at HEAD, when it is `result` and no head agent run
        answered it, as after a kill. They go back to the agent with no new review."""
        for line in reversed(self.ticket_lines(key)):
            if line.get("commit") != head or line.get("result") == "started":
                continue
            if line.get("step") == "build":
                return None
            if line.get("step") == step:
                return [str(item) for item in line.get("findings", [])] if line["result"] == result else None
        return None

    def record_ui_review(self, run: TicketRun, review: AgentResult, head: str, detail: str = "") -> None:
        """Logs what the review left open, and comments it on the ticket."""
        key = run.ticket.key
        accepted = [part for part in review.unchecked if self.accepted_unchecked(part)]
        left = [f"UI fault left unfixed: {fault}" for fault in review.findings]
        left += [f"Not checked: {part}" for part in review.unchecked if part not in accepted]
        self.record_notes(run.ticket, [f"Not checked, and accepted in loop.toml: {p}" for p in accepted])
        if left:
            # The comment goes first, because the logged result ends the step.
            text = self.bullets(UI_OPEN_COMMENT, left)
            self.track(key, "comment", lambda: self.comment_once(key, text))
            self.log(key, "ui-gate", "open", commit=head, detail=f"{detail}{len(left)} items", items=left)
        else:
            self.log(key, "ui-gate", "pass", commit=head, detail=detail.strip())

    def accepted_unchecked(self, part: str) -> bool:
        """Whether `loop.toml` accepts a part that the UI review could not check, by a phrase in its text."""
        return any(phrase.lower() in part.lower() for phrase in self.config.ui_accepted_unchecked)

    def ui_open(self) -> dict[str, list[str]]:
        """The items that the last UI review of each ticket left open, by key."""
        last: dict[str, list[str]] = {}
        for line in read_lines(self.log_path):
            if line.get("step") == "ui-gate" and line.get("result") in UI_PASSED:
                last[str(line.get("ticket"))] = [str(item) for item in line.get("items", [])]
        return {key: items for key, items in last.items() if items}

    def ui_diff(self, run: TicketRun, rev: str) -> str | None:
        """The ticket's own change to the UI paths at `rev`, with no context lines, so that a commit that
        changes no UI code, or a merge of the Epic branch, gives the same text as the commit before it. None
        when git no longer has the commit."""
        span = f"{self.epic_branch}...{rev}"
        listed = git(run.worktree, "diff", "--name-only", span, check=False)
        if listed.returncode != 0:
            return None
        names = [name for name in listed.stdout.splitlines() if self.is_ui_path(name)]
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

    def land(self, run: TicketRun) -> Outcome | None:
        """Merges the ticket into the Epic branch and records it as landed.

        A conflict or a failed merge gate goes back to the head agent, to fix on the ticket branch.
        """
        key = run.ticket.key
        self.log(key, "land", "started", commit=self.head(run))
        failure = self.merge_into_epic(run)
        if failure:
            return self.send_back(run, failure)
        self.complete_landing(key, run.worktree, run.slot)
        return "landed"

    def complete_landing(self, key: str, worktree: Path, slot: int) -> None:
        """Pushes the Epic branch, gives the ticket its screenshots and status, and removes its worktree.
        Each call checks first, so a rerun after a kill repeats none. A failed push is logged, and the run
        goes on."""
        self.push(self.epic_worktree, self.epic_branch, key)
        shots = screenshots(self.home / "runs" / key)
        if shots:
            self.track(key, "attach", lambda: self.attach_once(key, shots))
        self.track(key, "status", lambda: self.transition_once(key, self.config.landed_status))
        self.stack_down(worktree, slot, key, volumes=True)
        git(self.repo, "worktree", "remove", "--force", str(worktree), check=False)
        self.log(key, "land", "landed", commit=repo.landed_commit(self.repo, self.epic_branch, key))

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
                self.log(
                    key,
                    "land",
                    "conflict",
                    commit=out(run.worktree, "rev-parse", "HEAD"),
                    detail=str(log_file),
                )
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
            git(epic, "branch", "--force", self.epic_branch, out(epic, "rev-parse", "HEAD"))
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
        """Flags the ticket, comments the reason and the log path, and notifies. Other tickets go on."""
        detail = f"{reason} {log}"
        comment = f"{STUCK_COMMENT}\n{reason}\nThe log is {log} on {os.uname().nodename}."
        self.log(ticket.key, "stuck", "started", detail=detail, comment=comment)
        self.finish_stuck(ticket.key, detail, comment, slot)
        return "stuck"

    def finish_stuck(self, key: str, detail: str, comment: str, slot: int) -> None:
        self.track(key, "flag", lambda: self.flag_once(key))
        self.track(key, "comment", lambda: self.comment_once(key, comment))
        self.notify(f"{key} stuck")
        # The containers stop so that the slot ports are free. The volume stays for KC.
        self.stack_down(self.home / "worktrees" / key, slot, key, volumes=False)
        self.log(key, "stuck", "stuck", detail=detail)

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
        run = TicketRun(self.tracker.issue(key), EPIC_SLOT, self.epic_branch, self.epic_worktree, run_dir)
        merge_base = out(self.epic_worktree, "merge-base", base, "HEAD")
        # The ticket reviews already ran at landing, so the finish runs the merge gate, which is the only test
        # gate here, reviews again only the UI items left open, and leaves the review of the whole Epic to KC.
        failing: tuple[str, Path] | None = None
        log_file = run_dir / "finish-merge-gate.log"
        command = self.config.merge_gate
        if not self.gate(command, self.epic_worktree, self.config.stack_env(EPIC_SLOT, key), log_file, key):
            failing = (" ".join(command), log_file)
        else:
            self.review_ui_open(merge_base)
        self.push(self.epic_worktree, self.epic_branch, key)
        demo_failing = self.point_demo(run_dir)
        body = self.pr_body(run, merge_base)
        return self.open_pr(failing, body, demo_failing)

    def review_ui_open(self, merge_base: str) -> None:
        """Gives each ticket that landed with open UI items a new UI review on the Epic branch, because a
        later ticket can cover an item, such as with a test or a seeded file. A failed review keeps the
        items open."""
        head = out(self.epic_worktree, "rev-parse", "HEAD")
        left = self.ui_open()
        for ticket in self.tracker.children(self.epic_key):
            key = ticket.key
            if key not in left:
                continue
            run_dir = self.home / "runs" / key
            run_dir.mkdir(parents=True, exist_ok=True)
            run = TicketRun(ticket, EPIC_SLOT, self.epic_branch, self.epic_worktree, run_dir)
            # The ticket got its screenshots at landing, so these are the review's own.
            for shot in screenshots(run_dir):
                shot.unlink()
            items = "\n".join(f"- {item}" for item in left[key])
            prompt = UI_REVIEW_PROMPT.format(skill=self.config.ui_skill, run_dir=run_dir, base=merge_base)
            prompt += UI_FINISH_PROMPT.format(key=key, ticket=run_dir / "ticket.md", items=items)
            try:
                review = self.through_limits(
                    run, functools.partial(self.review_agent, run, prompt, f"{key}-ui-finish")
                )
            except (AgentFailed, UsageLimit) as error:
                failed = f"At the finish, the review failed: {error}"
                self.log(key, "ui-gate", "open", commit=head, detail=failed, items=left[key])
                continue
            shots = screenshots(run_dir)
            if not shots:
                failed = "At the finish, the review saved no screenshots."
                self.log(key, "ui-gate", "open", commit=head, detail=failed, items=left[key])
                continue
            self.track(key, "attach", functools.partial(self.attach_once, key, shots))
            self.record_ui_review(run, review, head, detail="At the finish. ")

    def point_demo(self, run_dir: Path) -> tuple[str, Path] | None:
        """Points the always-on demo at the Epic branch. Returns the command and its log when it fails."""
        demo = self.config.demo
        if demo is None:
            return None
        command = tuple(item.replace("{branch}", self.epic_branch) for item in demo.command)
        log_file = run_dir / "finish-demo.log"
        passed = self.logged(command, self.epic_worktree, self.child_env(), log_file).ok
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
        write = functools.partial(
            self.agent,
            run,
            prompt,
            None,
            f"{key}-pr",
            model=self.config.agent_model,
            effort=self.config.agent_effort,
        )
        try:
            self.through_limits(run, write)
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
        left = self.ui_open()
        ui_open = {
            self.ticket_label(ticket): len(left[ticket.key])
            for ticket in self.tracker.children(key)
            if ticket.key in left
        }
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
        """Runs `claude -p` with an empty context, or resumes a session. A run that a usage limit stopped
        resumes where it stopped."""
        name = name or run.ticket.key
        if run.resumes(name):
            limited, run.limited = run.limited, None
            if limited and limited.session:
                prompt, session = USAGE_RESUME_PROMPT, limited.session
        return self.agent_run(run, prompt, session, name, schema, model, effort)

    def through_limits[T](self, run: TicketRun, call: Callable[[], T]) -> T:
        """An agent run of the integrator, which waits out a usage limit that resets soon itself."""
        while True:
            try:
                return call()
            except UsageLimit as limit:
                if not self.wait_out(limit):
                    raise
                run.limited = limit

    def wait_out(self, limit: UsageLimit) -> bool:
        """Waits for a usage limit to reset, and notifies once for the runs that meet the same limit. False
        when the limit does not reset soon, which stops the loop."""
        now = time.time()
        if limit.reset is None or limit.reset - now > MAX_USAGE_WAIT_SECONDS:
            return False
        until = datetime.fromtimestamp(limit.reset, UTC).isoformat(timespec="seconds")
        end = limit.reset + PAST_RESET_SECONDS
        resumes = datetime.fromtimestamp(max(end, self.paused_until), UTC).isoformat(timespec="seconds")
        self.log(
            limit.name, "agent", "usage-pause", detail=f"The usage limit resets at {until}.", resumes=resumes
        )
        if end > now and now >= self.paused_until:
            self.notify(f"{self.epic_key} paused")
        self.paused_until = max(self.paused_until, end)
        left = self.paused_until - now
        while left > 0:
            self.stop_point()
            time.sleep(min(left, PAUSE_STEP_SECONDS))
            left -= PAUSE_STEP_SECONDS
        return True

    def stop_point(self) -> None:
        if self.stopping.is_set():
            raise Stopped

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
        command = ["claude", "-p", prompt]
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
            **NO_BACKGROUND,
        }
        self.stop_point()
        run.agent_log = next_log(run.run_dir, "agent", ".jsonl")
        errors_log = run.agent_log.with_suffix(".err")
        ended = after_status(run.agent_log, STATUS_GRACE_SECONDS)
        log_meter = self.meter_logger(name, run.agent_log)
        finished = process.run(
            command,
            run.worktree,
            env,
            seconds=self.config.agent_timeout_minutes * process.MINUTE,
            stdout=run.agent_log,
            stderr=errors_log,
            stop=lambda: log_meter() or self.stopping.is_set() or ended(),
            on_kill=lambda: self.stack_down(run.worktree, run.slot, run.ticket.key, volumes=False),
        )
        if finished.stopped:
            self.stop_point()
        errors = errors_log.read_text()
        # Each turn ends with a result event, and a later turn's result can have no status.
        events = json_lines(run.agent_log.read_text())
        results = [event for event in events if event.get("type") == "result"]
        data = results[-1] if results else {}
        cost, plan = agent_usage(data, events), agent_plan(events)
        if finished.timed_out:
            self.log(name, "agent", "timeout", session=session, usage=cost, plan=plan)
            raise AgentFailed(f"The agent ran past {self.config.agent_timeout_minutes} minutes.")
        if finished.stopped:
            detail = "The session kept running after its status."
            self.log(name, "agent", "stopped", session=first_session(events), detail=detail)
        returncode = finished.returncode
        message = f"{data.get('result', '')}\n{errors}"
        if data.get("is_error") or not data:
            if data.get("api_error_status") in (429, "429") or USAGE_LIMIT.search(message):
                limited = data.get("session_id") or first_session(events) or session
                detail = f"{name}: {message.strip()[:200]}"
                # The run that meets the limit moved the meter most, so its line keeps the plan.
                self.log(name, "agent", "usage-limit", session=limited, detail=detail, usage=cost, plan=plan)
                raise UsageLimit(detail, name, usage_reset(events), limited)
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
        return AgentResult(status, reason, session_id, findings, unchecked)

    def meter_logger(self, name: str, agent_log: Path) -> Callable[[], None]:
        """Logs the plan meter while the agent runs, so the dashboard has a reading minutes old. A reading
        that changed is logged at most once a minute."""
        read = meter_reader(agent_log)
        logged: dict[str, Any] = {}
        logged_at = -process.MINUTE

        def log_meter() -> None:
            nonlocal logged, logged_at
            reading = read()
            if reading and reading != logged and time.monotonic() - logged_at >= process.MINUTE:
                self.log(name, "meter", "read", meter=reading)
                logged, logged_at = reading, time.monotonic()

        return log_meter

    def record_decisions(self, ticket: Ticket, decisions: list[str]) -> None:
        """Comments the open questions on the ticket. They stay out of the Epic PR."""
        if decisions:
            text = self.bullets(DECISIONS_COMMENT, decisions)
            self.track(ticket.key, "comment", lambda: self.comment_once(ticket.key, text))

    def record_notes(self, ticket: Ticket, notes: list[str]) -> None:
        """Comments the notes on the ticket. They stay out of the Epic PR."""
        if notes:
            text = self.bullets(NOTES_COMMENT, notes)
            self.track(ticket.key, "comment", lambda: self.comment_once(ticket.key, text))

    @staticmethod
    def bullets(heading: str, items: list[str]) -> str:
        return heading + "\n" + "\n".join(f"- {item}" for item in items)

    def gate(
        self, command: tuple[str, ...], cwd: Path, stack: dict[str, str], log_file: Path, key: str
    ) -> bool:
        """Runs a gate on new containers, because a container from a failed start can start later with no
        published port."""

        def down() -> None:
            self.command(["docker", "compose", "down"], cwd, stack)

        if stack:
            down()
        passed = self.logged(
            command, cwd, {**self.child_env(), **stack}, log_file, down if stack else None
        ).ok
        commit = out(cwd, "rev-parse", "HEAD")
        self.log(key, " ".join(command), "pass" if passed else "fail", commit=commit, detail=str(log_file))
        return passed

    def logged(
        self,
        command: tuple[str, ...],
        cwd: Path,
        env: dict[str, str],
        log_file: Path,
        on_kill: Callable[[], object] | None = None,
    ) -> process.Finished:
        """A gate or the demo command, at the gate timeout, with its output in the log file."""
        self.stop_point()
        seconds = self.config.gate_timeout_minutes * process.MINUTE
        finished = process.run(
            command, cwd, env, seconds=seconds, stdout=log_file, stderr="stdout",
            stop=self.stopping.is_set, on_kill=on_kill,
        )  # fmt: skip
        if finished.stopped:
            self.stop_point()
        return finished

    def push(self, worktree: Path, branch: str, key: str) -> None:
        result = git(worktree, "push", "--set-upstream", "origin", branch, check=False)
        self.log(key, "push", "ok" if result.returncode == 0 else "fail", detail=result.stderr.strip()[-300:])

    def stop_stale_stacks(self) -> None:
        """Stops every Compose project of the repo's slots, which hold their ports: at the start, the ones an
        earlier run left, and at a stop, the ones this run left.

        `loop start` lets one run of the repo go at a time, so no other run uses them. The volumes stay.
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

    def command(self, command: list[str], cwd: Path, stack: dict[str, str] | None = None) -> process.Finished:
        """A short command, such as `gh` or `docker compose down`, at the gate timeout. A stop lets it end, so
        the clean-up after a stop runs too."""
        env = {**self.child_env(), **(stack or {})}
        return process.run(command, cwd, env, seconds=self.config.gate_timeout_minutes * process.MINUTE)

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

    def comment_once(self, key: str, text: str) -> None:
        """Comments the text unless the ticket has it. A failed read of the comments comments it anyway."""
        try:
            seen = {normal(comment) for comment in self.tracker.comments(key)}
        except TrackerError:
            seen = set()
        if normal(text) not in seen:
            self.tracker.comment(key, text)

    def attach_once(self, key: str, files: list[Path]) -> None:
        """Attaches each file that the ticket does not have, by its name and size."""
        have = set(self.tracker.attachments(key))
        self.tracker.attach(key, [path for path in files if (path.name, path.stat().st_size) not in have])

    def transition_once(self, key: str, status: str) -> bool:
        return self.tracker.issue(key).status == status or self.tracker.transition(key, status)

    def flag_once(self, key: str) -> None:
        if not self.tracker.issue(key).flagged:
            self.tracker.flag(key)

    def track(self, key: str, step: str, call: Callable[[], object]) -> None:
        """A tracker call that fails is logged. It does not stop the ticket."""
        try:
            result = call()
            self.log(key, f"tracker-{step}", "fail" if result is False else "ok")
        except TrackerError as error:
            self.log(key, f"tracker-{step}", "fail", detail=str(error))

    def ticket_lines(self, key: str) -> list[dict[str, Any]]:
        return [line for line in read_lines(self.log_path) if line.get("ticket") == key]

    def head(self, run: TicketRun) -> str:
        return out(run.worktree, "rev-parse", "HEAD")

    def mend_log(self) -> None:
        """Ends a last line that a kill cut off, so that the next line starts on a line of its own."""
        if not self.log_path.exists():
            return
        with self.log_path.open("rb+") as file:
            if file.seek(0, os.SEEK_END) == 0:
                return
            file.seek(-1, os.SEEK_END)
            if file.read(1) != b"\n":
                file.write(b"\n")

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
        **fields: Any,
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
        line.update(fields)
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
    epic_run = EpicRun(epic_key, config, secrets, base)
    signal.signal(signal.SIGTERM, lambda number, frame: epic_run.stopping.set())
    return epic_run.run()
