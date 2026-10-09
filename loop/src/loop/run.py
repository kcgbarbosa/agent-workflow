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

from . import repo
from .config import Config
from .repo import git, out
from .tracker import Ticket, TrackerError
from .watch import BOARD

AGENT_SCHEMA = json.dumps(
    {
        "type": "object",
        "properties": {
            "status": {"type": "string", "enum": ["done", "blocked"]},
            "reason": {"type": "string"},
            "decisions": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Each judgement call that KC should check. Make the call and continue.",
            },
        },
        "required": ["status", "reason", "decisions"],
        "additionalProperties": False,
    }
)
# A review returns each finding that needs a change, and the head agent fixes them in its own session.
REVIEW_SCHEMA = json.dumps(
    {
        **json.loads(AGENT_SCHEMA),
        "properties": {
            **json.loads(AGENT_SCHEMA)["properties"],
            "findings": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Each problem that needs a change, with its file and line or its screenshot.",
            },
        },
        "required": ["status", "reason", "decisions", "findings"],
    }
)
# The reviews run in their own sessions on this model, so the head agent's context stays small.
REVIEW_MODEL = "claude-sonnet-5-5"
REVIEW_RULES = (
    "Change no file, and do not commit or push. Return each problem that needs a change in `findings`. "
    "Leave out a judgement call that you would not change."
)
CODE_REVIEW_PROMPT = "/code-review {base} The spec is the ticket file {ticket}. " + REVIEW_RULES
UI_REVIEW_PROMPT = "/{skill} The run folder is {run_dir}. The base is `{base}`. " + REVIEW_RULES
REVIEW_FIX_PROMPT = (
    "The {review} found these problems:\n\n{findings}\n\nFix each one that is a real problem, and commit the "
    "fixes with {key} as the commit scope. Give each one you leave as it is in `decisions`, with the reason."
)
RESTART_PROMPT = "A previous run was interrupted. Check the diff against the ticket and continue."
USAGE_RESUME_PROMPT = "The run stopped at a usage limit, which has now reset. Continue the work."
# A limit that resets later than this, such as the weekly one, stops the loop.
MAX_USAGE_WAIT_SECONDS = 6 * 60 * 60
PR_PROMPT = (
    "/pr Write the body of the Epic pull request for the diff `{merge_base}..HEAD` to the file "
    "`{body_file}`. Do not commit, push, or open the pull request. In Evidence, give this ticket "
    "table as it is:\n\n{tickets}"
)
LANDED_KEYS_PROMPT = "\n\nName no ticket key that the table does not give."
NOT_LANDED = "Done in the tracker, not landed"
UNFINISHED = ("Stuck", "Not built", NOT_LANDED)
# The loop's own comments start with these lines, so the ticket file leaves them out.
STUCK_COMMENT = "The loop stopped this ticket."
DECISIONS_COMMENT = "The agent made these decisions for KC to check:"
USAGE_LIMIT = re.compile(r"usage limit|hit your limit|limit reached|rate.?limit", re.IGNORECASE)
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
# The commit that the screenshots in a run folder show.
UI_COMMIT_FILE = "ui-review.commit"
# The subagent tiers of every agent run, and the rule for when the head agent hands work to them.
AGENTS = Path(__file__).with_name("agents.json")
DISPATCH = Path(__file__).with_name("dispatch.md")
# The usage fields the log keeps per model. A `costBasis` of "unknown" marks a cost the CLI guessed.
MODEL_USAGE = (
    "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "costUSD", "costBasis",
)  # fmt: skip
TIMED_OUT = 124
# The loop keeps the stack volumes for KC, so no agent run deletes one.
VOLUME_DENY = ("Bash(docker volume rm *)", "Bash(docker volume prune*)", "Bash(docker system prune*)")
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


@dataclass
class Counters:
    stuck_in_row: int = 0
    landed: list[str] = field(default_factory=list)
    stuck: list[str] = field(default_factory=list)


def next_log(run_dir: Path, stem: str, suffix: str) -> Path:
    """The next numbered log in the run folder, so that a restart keeps the logs of earlier runs."""
    number = len(list(run_dir.glob(f"{stem}-*{suffix}"))) + 1
    return run_dir / f"{stem}-{number}{suffix}"


def pause(seconds: float) -> None:
    time.sleep(seconds)


def tail(text: str, lines: int = LOG_TAIL_LINES) -> str:
    return "\n".join(text.splitlines()[-lines:])


def json_lines(text: str) -> list[dict[str, Any]]:
    """The JSON objects in stream-json output, one per line. A line that is not an object is skipped."""
    events = []
    for line in text.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def agent_status(result: dict[str, Any]) -> dict[str, Any] | None:
    """The status of one result event, from the schema output or, failing that, from the result text."""
    output = result.get("structured_output")
    if not isinstance(output, dict):
        try:
            output = json.loads(str(result.get("result", "")))
        except json.JSONDecodeError:
            return None
    if not isinstance(output, dict) or output.get("status") not in ("done", "blocked"):
        return None
    return output


def usage_reset(events: list[dict[str, Any]]) -> float | None:
    """The time, in epoch seconds, when the usage limit that stopped a run resets."""
    for event in reversed(events):
        info = event.get("rate_limit_info") if event.get("type") == "rate_limit_event" else None
        if isinstance(info, dict) and info.get("status") == "rejected" and info.get("resetsAt"):
            return float(info["resetsAt"])
    return None


def agent_usage(result: dict[str, Any]) -> dict[str, Any]:
    """The cost, turns, duration, subagents, and per-model usage of one result event (loop.md rule 11)."""
    models = result.get("modelUsage")
    return {
        "total_cost_usd": result.get("total_cost_usd"),
        "num_turns": result.get("num_turns"),
        "duration_ms": result.get("duration_ms"),
        "subagents": (result.get("subagent_stats") or {}).get("by_type"),
        "models": {
            model: {field: value for field, value in fields.items() if field in MODEL_USAGE}
            for model, fields in models.items()
        }
        if isinstance(models, dict)
        else None,
    }


def agent_settings(config: Config) -> str:
    """The permission rules and the auto mode rules of every agent run, for `--settings`.

    Nobody answers a prompt in a loop run, and a denied action can make a ticket stuck. These rules let the
    routine actions of a ticket run without the classifier, and tell the classifier what the loop owns.
    """
    gates = sorted({shlex.join(gate) for gate in (config.ticket_gate, config.merge_gate)})
    allow = [rule for gate in gates for rule in (f"Bash({gate})", f"Bash({gate} *)")]
    named = " and ".join(f"`{gate}`" for gate in gates)
    environment = [
        "$defaults",
        "Host containment: an unattended build loop runs this session. Nobody is at the keyboard. The "
        f"loop owns each git worktree and run folder under {config.state_dir}.",
    ]
    classifier_allow = [
        "$defaults",
        f"Loop gates: running {named} in a loop worktree is allowed, also with the output redirected to a "
        "file. The loop runs the same commands as its gates.",
    ]
    deny: tuple[str, ...] = ()
    if config.stack:
        project = f"{config.name}-<ticket key>"
        environment.append(
            f"Loop stacks: each Docker Compose project named `{project}`, such as `{config.name}-abc-12`, "
            "and its containers are a disposable test stack of the loop. No person works in one. The "
            f"project `{config.name}` without a key is KC's own stack, and it is not one of them."
        )
        classifier_allow.append(
            f"Loop stacks: stopping, removing, or starting again a container or Compose project named "
            f"`{project}`, for example `docker stop {config.name}-abc-11-db-1` or `docker compose down`, "
            "is allowed to free a port or reset a test stack. The volumes stay."
        )
        deny = VOLUME_DENY
    settings = {
        "permissions": {"allow": allow, "deny": list(deny)},
        "autoMode": {"environment": environment, "allow": classifier_allow},
    }
    return json.dumps(settings)


class EpicRun:
    def __init__(self, epic_key: str, config: Config, secrets: Mapping[str, str]) -> None:
        self.epic_key = epic_key
        self.config = config
        self.secrets = dict(secrets)
        self.repo = config.repo
        self.tracker = config.tracker(secrets)
        self.home = config.state_dir / epic_key
        self.log_path = self.home / "decisions.jsonl"
        self._log_lock = threading.Lock()
        self._repo_lock = threading.Lock()
        self._land_lock = threading.Lock()
        self.counters = Counters()
        self.epic_branch = ""
        self.epic_worktree = self.home / "worktrees" / epic_key
        self.epic_summary = ""
        self.decisions: list[tuple[Ticket, str]] = []
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
        with self._repo_lock:
            repo.add_worktree(
                self.repo, self.epic_worktree, self.epic_branch, f"origin/{self.config.main_branch}"
            )
        self.log(self.epic_key, "start", "ok", detail=self.epic_branch)
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
                        self.counters.stuck_in_row = 0
                        self.counters.landed.append(key)
                    elif outcome == "stuck":
                        self.counters.stuck_in_row += 1
                        self.counters.stuck.append(key)
                        if self.counters.stuck_in_row >= self.config.circuit_breaker:
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
        except UsageLimit as error:
            self.log(ticket.key, "agent", "usage-limit", detail=str(error))
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
        self.write_ticket_file(run, self.config.ticket_gate, reviews=True)
        if ticket.status != self.config.in_progress:
            self.track(
                ticket.key, "status", lambda: self.tracker.transition(ticket.key, self.config.in_progress)
            )
        self.log(ticket.key, "start", "restart" if run.restart else "new", detail=branch)
        return run

    def drive(self, run: TicketRun) -> Outcome:
        """The agent run, the gates, and the merge, with the fix attempts."""
        prompt = f"/implement {run.run_dir / 'ticket.md'}"
        attempts = 0
        if run.restart:
            prompt += f"\n\n{RESTART_PROMPT}"
            attempts = 1
        result = self.ticket_agent(run, prompt, session=None)
        reviewed = False
        while True:
            if result.status == "blocked":
                reason = f"The agent is blocked: {result.reason}"
                return self.stuck(run.ticket, reason, run.agent_log or run.run_dir, run.slot)
            failure = self.ticket_gate(run)
            if failure is None and not reviewed:
                reviewed = True
                failure = self.code_review(run)
            failure = failure or self.ui_gate(run)
            if failure is None:
                landed = self.land(run)
                if not isinstance(landed, GateFailure):
                    return landed
                failure = landed
            if failure.attempt:
                if attempts >= self.config.fix_attempts:
                    return self.stuck(run.ticket, failure.reason, failure.log, run.slot)
                attempts += 1
            if failure.on_epic:
                failure = self.merge_epic(run, failure)
            result = self.ticket_agent(run, failure.prompt, session=result.session)

    def ticket_agent(self, run: TicketRun, prompt: str, session: str | None) -> AgentResult:
        """An agent run, then a push of the ticket branch, also when the run fails."""
        try:
            return self.agent(run, prompt, session)
        finally:
            self.push(run.worktree, run.branch, run.ticket.key)

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
            return None
        reason = f"The ticket gate `{' '.join(command)}` failed. The log is {log_file}."
        prompt = (
            f"The ticket gate `{' '.join(command)}` failed. Fix the cause and commit the fix.\n"
            f"The end of the log:\n\n{tail(log_file.read_text())}"
        )
        return GateFailure(reason, prompt, log_file)

    def code_review(self, run: TicketRun) -> GateFailure | None:
        """`/code-review` in its own session. Its findings go back to the head agent's session."""
        key = run.ticket.key
        prompt = CODE_REVIEW_PROMPT.format(base=self.epic_branch, ticket=run.run_dir / "ticket.md")
        review = self.review_agent(run, prompt, f"{key}-review")
        if not review.findings:
            self.log(key, "code-review", "pass")
            return None
        self.log(key, "code-review", "findings", detail=f"{len(review.findings)} findings")
        reason = "The code review found problems."
        fix = self.fix_prompt("code review", review.findings, key)
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
        if screenshots(run.run_dir) and reviewed.exists() and reviewed.read_text().strip() == head:
            self.log(key, "ui-gate", "pass", commit=head, detail="The screenshots show this commit.")
            return None
        # Screenshots of an earlier commit do not show this code.
        reviewed.unlink(missing_ok=True)
        for shot in screenshots(run.run_dir):
            shot.unlink()
        skill = self.config.ui_skill
        prompt = UI_REVIEW_PROMPT.format(skill=skill, run_dir=run.run_dir, base=self.epic_branch)
        review = self.review_agent(run, prompt, f"{key}-ui")
        if review.findings:
            self.log(key, "ui-gate", "fail", detail=f"{len(review.findings)} faults")
            fix = self.fix_prompt("UI review", review.findings, key)
            return GateFailure("The UI review found faults.", fix, run.agent_log or run.run_dir)
        if not screenshots(run.run_dir):
            raise AgentFailed(f"The UI review saved no screenshots in {run.run_dir}.")
        reviewed.write_text(head + "\n")
        self.log(key, "ui-gate", "pass", commit=head)
        return None

    def review_agent(self, run: TicketRun, prompt: str, name: str) -> AgentResult:
        """A review session with an empty context. A blocked review makes the ticket stuck."""
        review = self.agent(run, prompt, None, name=name, schema=REVIEW_SCHEMA, model=REVIEW_MODEL)
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

    def land(self, run: TicketRun) -> Outcome | GateFailure:
        """Merges one ticket at a time, runs the merge gate on the Epic branch, and pushes it.

        A conflict or a failed merge gate returns a failure, so that the agent fixes it on the ticket branch.
        """
        key = run.ticket.key
        epic = self.epic_worktree
        with self._land_lock:
            # The merge is made on a detached HEAD. The Epic branch moves only when the merge gate
            # passes, so the frontier never counts a merge that the gate can still undo.
            git(epic, "switch", "--quiet", "--detach", self.epic_branch)
            try:
                message = f"merge({key}): {run.ticket.summary}"
                merge = git(epic, "merge", "--no-ff", run.branch, "-m", message, check=False)
                if merge.returncode != 0:
                    log_file = run.run_dir / "merge.log"
                    log_file.write_text(merge.stdout + merge.stderr)
                    git(epic, "merge", "--abort", check=False)
                    self.log(key, "land", "conflict", detail=str(log_file))
                    reason = "The merge into the Epic branch has a conflict."
                    prompt = (
                        f"Another ticket landed on the Epic branch `{self.epic_branch}`, "
                        "and this branch no longer merges into it."
                    )
                    return GateFailure(reason, prompt, log_file, on_epic=True)
                log_file = next_log(run.run_dir, "merge-gate", ".log")
                command = self.config.merge_gate
                if not self.gate(
                    command, epic, self.config.stack_env(EPIC_SLOT, self.epic_key), log_file, key
                ):
                    reason = f"The merge gate `{' '.join(command)}` failed on the Epic branch."
                    prompt = (
                        f"The merge gate `{' '.join(command)}` failed on the Epic branch with this branch "
                        "merged in. Fix the cause and commit the fix.\n"
                        f"The end of the log:\n\n{tail(log_file.read_text())}"
                    )
                    return GateFailure(reason, prompt, log_file, on_epic=True)
                commit = out(epic, "rev-parse", "HEAD")
                git(epic, "branch", "--force", self.epic_branch, commit)
                self.log(key, "land", "landed", commit=commit)
                # On origin, the landed work outlives this host. A failed push is logged, and the run goes on.
                self.push(epic, self.epic_branch, key)
            finally:
                git(epic, "reset", "--hard", "--quiet")
                git(epic, "switch", "--quiet", self.epic_branch)
        if run.ui_touched:
            shots = screenshots(run.run_dir)
            self.track(key, "attach", lambda: self.tracker.attach(key, shots))
        self.track(key, "status", lambda: self.tracker.transition(key, self.config.landed_status))
        self.stack_down(run.worktree, run.slot, key, volumes=True)
        with self._repo_lock:
            git(self.repo, "worktree", "remove", "--force", str(run.worktree), check=False)
        return "landed"

    def merge_epic(self, run: TicketRun, failure: GateFailure) -> GateFailure:
        """Merges the Epic branch into the ticket branch, so the agent fixes the code the Epic branch gets.

        A conflict is left for the agent to resolve.
        """
        git(run.worktree, "merge", "--no-ff", "--no-edit", self.epic_branch, check=False)
        conflicts = out(run.worktree, "diff", "--name-only", "--diff-filter=U")
        result = "conflict" if conflicts else "ok"
        self.log(run.ticket.key, "merge-epic", result, detail=conflicts.replace("\n", " "))
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
        base = f"origin/{self.config.main_branch}"
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
        body = self.pr_body(run, merge_base)
        return self.open_pr(failing, body)

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
            self.agent(run, prompt, session=None, name=f"{key}-pr")
        except (AgentFailed, UsageLimit) as error:
            self.log(key, "pr-body", "fail", detail=str(error))
        written = body_file.read_text() if body_file.exists() else ""
        if "## Summary" in written:
            return written
        self.log(key, "pr-body", "fallback")
        return f"Builds the Epic {key}: {self.epic_summary}.\n\n{table}\n"

    def open_pr(self, failing: tuple[str, Path] | None, body: str) -> int:
        key = self.epic_key
        command = [
            "gh", "pr", "list", "--head", self.epic_branch, "--state", "open",
            "--json", "url", "--jq", ".[].url",
        ]  # fmt: skip
        existing = self.command(command, self.epic_worktree).stdout.strip()
        # Merging the Epic PR can close the Epic and all of its children in the tracker.
        children = self.tracker.children(key)
        unfinished = [
            self.ticket_label(ticket) for ticket in children if self.ticket_result(ticket) in UNFINISHED
        ]
        draft = bool(failing or unfinished)
        lines: list[str] = []
        if unfinished:
            lines += [f"**Unfinished tickets:** {', '.join(unfinished)}.", ""]
        if failing:
            lines += [f"**Failing gate:** `{failing[0]}`. The log is `{failing[1]}`.", ""]
        if self.decisions:
            items = [f"- {self.ticket_label(ticket)}: {item}" for ticket, item in self.decisions]
            lines += ["**Decisions to check:**", *items, ""]
        body_file = self.home / "runs" / key / "pr-body.md"
        body_file.write_text("\n".join(lines) + body)
        state = "pr-draft" if draft else "pr-open"
        if existing:
            # A PR from an earlier run gets the new body and the new draft state.
            self.command(["gh", "pr", "edit", existing, "--body-file", str(body_file)], self.epic_worktree)
            ready = ["gh", "pr", "ready", existing, *(["--undo"] if draft else [])]
            self.command(ready, self.epic_worktree)
            self.log(key, "pr", state, detail=existing)
            self.notify(f"{key} {state}")
            return 0
        summary = self.epic_summary[:1].lower() + self.epic_summary[1:]
        command = [
            "gh", "pr", "create", "--base", self.config.main_branch, "--head", self.epic_branch,
            "--title", f"feat({key}): {summary}", "--body-file", str(body_file),
        ]  # fmt: skip
        if draft:
            command.append("--draft")
        created = self.command(command, self.epic_worktree)
        if created.returncode != 0:
            self.log(key, "pr", "fail", detail=created.stderr.strip()[-300:])
            self.notify(f"{key} stopped")
            return 1
        self.log(key, "pr", state, detail=created.stdout.strip())
        self.notify(f"{key} {state}")
        return 0

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
        bases = (f"origin/{self.config.main_branch}", self.epic_branch)
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
    ) -> AgentResult:
        """Runs `claude -p` with an empty context, or resumes a session.

        A usage limit that resets soon pauses the run, and the session then resumes where it stopped.
        """
        name = name or run.ticket.key
        while True:
            try:
                return self.agent_run(run, prompt, session, name, schema, model)
            except UsageLimit as error:
                if error.reset is None or error.reset - time.time() > MAX_USAGE_WAIT_SECONDS:
                    raise
                self.pause_until(error.reset, name)
                if error.session:
                    prompt, session = USAGE_RESUME_PROMPT, error.session

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

    def agent_run(
        self, run: TicketRun, prompt: str, session: str | None, name: str, schema: str, model: str | None
    ) -> AgentResult:
        limit = f"{self.config.agent_timeout_minutes}m"
        command = ["timeout", "--kill-after=60", limit, "claude", "-p", prompt]
        if session:
            command += ["--resume", session]
        if model:
            command += ["--model", model]
        # Each worktree is a new folder, where nobody approved the project `.mcp.json`. With the flag,
        # the loop does not depend on how `claude -p` treats a server that waits for approval.
        if (run.worktree / ".mcp.json").exists():
            command += ["--mcp-config", str(run.worktree / ".mcp.json")]
        command += [
            "--permission-mode", "auto", "--permission-prompts", "none",
            "--output-format", "stream-json", "--verbose", "--json-schema", schema, "-n", name,
            "--agents", str(AGENTS), "--append-system-prompt", DISPATCH.read_text(),
            "--settings", self.settings,
        ]  # fmt: skip
        env = {
            **self.child_env(),
            **self.config.stack_env(run.slot, run.ticket.key),
            **self.secrets,
            "LOOP_RUN_DIR": str(run.run_dir),
        }
        run.agent_log = next_log(run.run_dir, "agent", ".jsonl")
        errors_log = run.agent_log.with_suffix(".err")
        # The output streams to the logs, so a run can be followed while it lasts.
        with run.agent_log.open("w") as stdout, errors_log.open("w") as stderr:
            result = subprocess.run(command, cwd=run.worktree, env=env, stdout=stdout, stderr=stderr)
        errors = errors_log.read_text()
        # Each turn ends with a result event. A background subagent that finishes after the status
        # wakes the session for one more turn, and that turn's result can have no status.
        events = json_lines(run.agent_log.read_text())
        results = [event for event in events if event.get("type") == "result"]
        data = results[-1] if results else {}
        cost = agent_usage(data)
        if result.returncode == TIMED_OUT:
            self.log(name, "agent", "timeout", session=session, usage=cost)
            raise AgentFailed(f"The agent ran past {self.config.agent_timeout_minutes} minutes.")
        message = f"{data.get('result', '')}\n{errors}"
        if data.get("is_error") or not data:
            if data.get("api_error_status") in (429, "429") or USAGE_LIMIT.search(message):
                started = next((event.get("session_id") for event in events if event.get("session_id")), None)
                stopped = data.get("session_id") or started or session
                raise UsageLimit(f"{name}: {message.strip()[:200]}", usage_reset(events), stopped)
            self.log(name, "agent", "error", session=data.get("session_id"), usage=cost)
            raise AgentFailed(f"The agent exited with code {result.returncode}: {message.strip()[:300]}")
        output = next(filter(None, map(agent_status, reversed(results))), None)
        if output is None:
            raise AgentFailed("The agent returned no status.")
        status = output["status"]
        reason = str(output.get("reason", ""))
        session_id = str(data.get("session_id") or session or "")
        commit = out(run.worktree, "rev-parse", "HEAD")
        self.log(name, "agent", status, commit=commit, session=session_id, detail=reason, usage=cost)
        decisions = [str(item) for item in output.get("decisions", [])]
        if decisions:
            key = run.ticket.key
            self.decisions += [(run.ticket, item) for item in decisions]
            bullets = "\n".join(f"- {item}" for item in decisions)
            text = f"{DECISIONS_COMMENT}\n{bullets}"
            self.track(key, "comment", lambda: self.tracker.comment(key, text))
        findings = [str(item) for item in output.get("findings", [])]
        return AgentResult(status, reason, session_id, findings)

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
        limit = f"{self.config.gate_timeout_minutes}m"
        with log_file.open("w") as log:
            wrapped = ["timeout", "--kill-after=60", limit, *command]
            result = subprocess.run(wrapped, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
        if result.returncode == TIMED_OUT:
            with log_file.open("a") as log:
                log.write(f"The gate ran past {self.config.gate_timeout_minutes} minutes.\n")
        passed = result.returncode == 0
        commit = out(cwd, "rev-parse", "HEAD")
        self.log(key, " ".join(command), "pass" if passed else "fail", commit=commit, detail=str(log_file))
        return passed

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
        return [text for text in comments if text and not text.startswith((STUCK_COMMENT, DECISIONS_COMMENT))]

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
        with self._log_lock, self.log_path.open("a") as file:
            file.write(json.dumps(line) + "\n")
        print(f"{line['time']} {ticket} {step} {result} {detail}".rstrip(), flush=True)


def screenshots(run_dir: Path) -> list[Path]:
    return sorted(path for path in run_dir.rglob("*") if path.suffix.lower() in IMAGE_SUFFIXES)


def run(epic_key: str, config: Config, secrets: Mapping[str, str]) -> int:
    """The run entry. It returns 0 when the Epic PR is open, and 1 when the loop stopped early."""
    return EpicRun(epic_key, config, secrets).run()
