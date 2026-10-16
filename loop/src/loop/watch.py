"""`loop watch`: a read-only web page of the runs on this host.

It reads only what the run writes to the state folder: `decisions.jsonl`, `board.json`, the agent logs, the
gate logs, and the screenshots. It changes nothing the loop reads, so it can run while a run lasts, after it,
or without one. The capacity forecast (`forecast.py`) writes its own Jira snapshot, which no run reads.
"""

from __future__ import annotations

import json
import math
import mimetypes
import os
import re
import statistics
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qs, unquote, urlparse

from . import process, report
from .stream import agent_plan

RUN_LOCK = "run.lock"
SECRETS_FILE = "secrets.json"
BOARD = "board.json"
DECISIONS = "decisions.jsonl"
PAGE = Path(__file__).with_name("watch.html")
KEY = re.compile(r"[A-Z][A-Z0-9]*-\d+")
AGENT_LOG = re.compile(r"agent-(\d+)\.jsonl")
DENIED = "denied by the Claude Code auto mode classifier"
# A short secret would mask ordinary words.
MIN_SECRET = 8
# The steps that say nothing new on the page.
QUIET_STEPS = {"tracker-status", "tracker-flag", "tracker-comment", "tracker-attach", "tracker-comments"}
# The lines that follow a step and say nothing about which step runs.
AFTER_STEPS = {"push", "trials"}
# The steps of one ticket, in the order the loop runs them (loop.md rules 3 to 6).
STEPS = ("agent", "ticket-gate", "code-review", "ui-review", "land")
RECENT_ITEMS = 3
TAIL_BYTES = 256_000
SUMMARY_CHARS = 160
DETAIL_CHARS = 4000
CHUNK_BYTES = 2_000_000
LOOP_SUFFIX = "-loop"
# The friendly name of each step, as the page shows it.
STAGES = {
    "agent": "Implementation",
    "ticket-gate": "Ticket gate",
    "code-review": "Code review",
    "ui-review": "UI review",
    "land": "Landing",
}
AGENT_STAGES = {"agent", "code-review", "ui-review"}
# An agent that writes nothing for longer than this needs a look. A Bash call stops after 10 minutes, so a
# quiet agent past 15 runs no command.
STALL_MINUTES = 15
METER_TAIL_BYTES = 4_000_000
METER_EVENT = b'"rate_limit_event"'


class Masker:
    """Replaces the value of each secret with its name. A transcript can hold what an agent printed."""

    def __init__(self, *secrets: dict[str, str]) -> None:
        pairs = [
            (value, f"[{name}]")
            for each in secrets
            for name, value in each.items()
            if len(value) >= MIN_SECRET
        ]
        self.pairs = sorted(pairs, key=lambda pair: -len(pair[0]))

    def text(self, value: str) -> str:
        for secret, name in self.pairs:
            value = value.replace(secret, name)
        return value

    def data(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, list):
            return [self.data(item) for item in value]
        if isinstance(value, dict):
            return {key: self.data(item) for key, item in value.items()}
        return value


def projects(state_dir: Path) -> dict[str, Path]:
    """The state folder of each project on this host, by name: this one first, then each sibling
    `<name>-loop` folder. Each repo's `loop.toml` names its own folder there, so one page serves them all.
    """
    found = {state_dir.name.removesuffix(LOOP_SUFFIX): state_dir}
    parent = state_dir.parent
    for home in sorted(parent.iterdir()) if parent.is_dir() else []:
        if home.name.endswith(LOOP_SUFFIX) and home.is_dir() and home != state_dir:
            found.setdefault(home.name.removesuffix(LOOP_SUFFIX), home)
    return found


def project_list(state_dir: Path) -> list[dict[str, Any]]:
    """Each project with the Epic that runs there now, if any."""
    return [{"name": name, "running": active_run(home)} for name, home in projects(state_dir).items()]


def read_secrets(state_dir: Path) -> dict[str, str]:
    try:
        secrets = json.loads((state_dir / SECRETS_FILE).read_text())
    except OSError, json.JSONDecodeError:
        return {}
    return {str(name): str(value) for name, value in secrets.items()} if isinstance(secrets, dict) else {}


def active_run(state_dir: Path) -> str | None:
    """The Epic key of the run that holds the lock, read from the lock file. The lock stays untouched."""
    try:
        holder = json.loads((state_dir / RUN_LOCK).read_text())
        pid, epic = int(holder["pid"]), str(holder["epic"])
    except OSError, ValueError, KeyError, TypeError:
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        pass
    return epic


def read_lines(path: Path) -> list[dict[str, Any]]:
    try:
        text = path.read_text()
    except OSError:
        return []
    lines = []
    for line in text.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            lines.append(item)
    return lines


def epics(state_dir: Path) -> list[dict[str, Any]]:
    """Each Epic with a log on this host, the newest first."""
    active = active_run(state_dir)
    found = []
    for home in state_dir.iterdir() if state_dir.is_dir() else []:
        log = home / DECISIONS
        if KEY.fullmatch(home.name) and log.exists():
            board = _board(home)
            found.append(
                {
                    "key": home.name,
                    "summary": board.get("summary", ""),
                    "updated": _iso(log.stat().st_mtime),
                    "running": home.name == active,
                }
            )
    return sorted(found, key=lambda epic: epic["updated"], reverse=True)


def host_view(state_dir: Path) -> list[dict[str, Any]]:
    """Each project on this host with the latest run of each of its Epics, the running one first: its status,
    its tickets complete of the total, and the step of each running ticket. The home page lists them.
    """
    found = []
    for name, home in projects(state_dir).items():
        runs = []
        for epic in epics(home):
            view = epic_view(home, epic["key"])
            working = [
                {"key": ticket["key"], "step": (ticket["step"] or {}).get("name")}
                for ticket in view["tickets"]
                if ticket["column"] == "running"
            ]
            runs.append(
                {
                    **epic,
                    "status": view["status"],
                    "progress": view["progress"],
                    "stuck": view["stats"]["stuck"],
                    "working": working,
                    "pr_url": view["pr_url"],
                }
            )
        runs.sort(key=lambda run: not run["running"])
        found.append({"name": name, "running": active_run(home), "runs": runs})
    return found


def all_runs(state_dir: Path) -> list[tuple[str, list[dict[str, Any]]]]:
    """Each run on this host, as its Epic key and its lines, the oldest first."""
    runs = []
    for home in state_dir.iterdir() if state_dir.is_dir() else []:
        if KEY.fullmatch(home.name) and (home / DECISIONS).exists():
            runs += [(home.name, run) for run in report.split_runs(home.name, read_lines(home / DECISIONS))]
    return sorted(runs, key=lambda item: str(item[1][0].get("time")))


def comparison(
    state_dir: Path, epic_key: str | None = None, against: str | None = None
) -> dict[str, Any] | None:
    """The breakdown of an Epic's latest run, or of the latest run on this host, against the run before it."""
    runs = all_runs(state_dir)
    if epic_key is None and runs:
        epic_key = runs[-1][0]
    current, previous = report.pick(runs, epic_key or "", against)
    if current is None:
        return None
    now = report.breakdown(*current)
    before = report.breakdown(*previous) if previous else None
    return {"current": now, "previous": before, "rows": report.compare(now, before)}


def _board(home: Path) -> dict[str, Any]:
    try:
        board = json.loads((home / BOARD).read_text())
    except OSError, json.JSONDecodeError:
        return {}
    return board if isinstance(board, dict) else {}


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, UTC).isoformat(timespec="seconds")


@dataclass
class _Ticket:
    key: str
    summary: str = ""
    status: str = ""
    done: bool = False
    flagged: bool = False
    landed: bool = False
    started: bool = False
    stuck_reason: str = ""
    blockers: list[dict[str, Any]] | None = None
    last: dict[str, Any] | None = None
    # The ticket gate failures since its last pass, in this run.
    gate_failures: int = 0
    ui_review: dict[str, Any] | None = None


def epic_view(state_dir: Path, epic_key: str) -> dict[str, Any]:
    """The state of one Epic's latest run: the run, the tickets in columns, the cost, and the steps."""
    home = state_dir / epic_key
    lines = read_lines(home / DECISIONS)
    # The latest run starts at the last start line of the Epic.
    starts = [
        index
        for index, line in enumerate(lines)
        if line.get("ticket") == epic_key and line.get("step") == "start"
    ]
    run = lines[starts[-1] :] if starts else lines
    board = _board(home)
    running = active_run(state_dir) == epic_key

    tickets: dict[str, _Ticket] = {}
    by_ticket: dict[str, list[dict[str, Any]]] = {}
    for item in board.get("tickets", []):
        tickets[item["key"]] = _Ticket(
            key=item["key"],
            summary=item.get("summary", ""),
            status=item.get("status", ""),
            done=bool(item.get("done")),
            flagged=bool(item.get("flagged")),
            landed=bool(item.get("landed")),
            blockers=item.get("blockers", []),
        )

    state, stop_reason, pr_url = ("running" if running else "idle"), "", ""
    every_run, this_run = _session_costs(lines), _session_costs(run)
    # A UI review of a ticket that landed in an earlier run is in an earlier run's lines.
    for line in lines:
        if (
            line.get("step") == "ui-gate"
            and line.get("ticket") in tickets
            and line.get("result") != "started"
        ):
            tickets[line["ticket"]].ui_review = {"result": line.get("result"), "time": line.get("time")}
    events = []
    for line in run:
        name, step, result = line.get("ticket", ""), line.get("step", ""), line.get("result", "")
        # A review session is named after its ticket, such as `<KEY>-review`, and belongs to it.
        key = match[0] if (match := KEY.match(name)) else name
        if key == epic_key:
            if step == "stop":
                state, stop_reason = "stopped", result
            elif step == "finish" and result == "nothing-landed":
                state, stop_reason = "stopped", result
            elif step == "pr" and result in ("pr-open", "pr-draft"):
                state, pr_url = result, line.get("detail", "")
        else:
            ticket = tickets.setdefault(key, _Ticket(key=key))
            by_ticket.setdefault(key, []).append(line)
            if step == "start" and result == "done-not-landed":
                ticket.done = True
            elif step == "start":
                ticket.started, ticket.stuck_reason = True, ""
            elif step == "stuck":
                ticket.stuck_reason = str(line.get("detail", "")).replace(f"{home}/", "")
            elif step == "land" and result == "landed":
                ticket.landed = True
            if _is_gate(line, "ticket") and result != "started":
                ticket.gate_failures = ticket.gate_failures + 1 if result == "fail" else 0
            if step == "ui-gate" and result != "started":
                ticket.ui_review = {"result": result, "time": line.get("time")}
            if step not in QUIET_STEPS and not step.startswith("tracker-"):
                ticket.last = {"step": step, "result": result, "time": line.get("time")}
        if step not in QUIET_STEPS:
            events.append(_event(home, line))
    if running:
        state = "running"

    columns = []
    for ticket in tickets.values():
        if ticket.landed:
            column = "landed"
        elif ticket.stuck_reason or ticket.flagged:
            column = "stuck"
        elif ticket.done:
            column = "done"
        elif ticket.started and running:
            column = "running"
        else:
            column = "waiting"
        run_dir = home / "runs" / ticket.key
        agents = agent_logs(run_dir)
        live = column == "running"
        newest = max((log["updated"] for log in agents), default=None)
        step = current_step(by_ticket.get(ticket.key, []), newest) if live else None
        shots = _shots(home, run_dir)
        columns.append(
            {
                "key": ticket.key,
                "summary": ticket.summary,
                "status": ticket.status,
                "column": column,
                "blockers": ticket.blockers or [],
                "stuck_reason": ticket.stuck_reason,
                "last": ticket.last,
                "cost": round(sum(_ticket_sessions(lines, ticket.key, every_run).values()), 2),
                "agents": agents,
                "step": step,
                "health": ticket_health(step, newest, ticket.gate_failures) if live else None,
                "gate_failures": ticket.gate_failures,
                "recent": recent_activity(home, ticket.key, run_dir, agents) if live else [],
                "ui_review": ticket.ui_review,
                "screenshots": shots,
                "verdict": verdict(ticket.ui_review, shots),
                "files": _files(home, run_dir, image=False),
            }
        )
    breakdown = report.breakdown(epic_key, run)
    complete = sum(1 for ticket in columns if ticket["column"] in ("landed", "done"))
    return {
        "key": epic_key,
        "summary": board.get("summary", ""),
        "branch": board.get("branch", ""),
        "status": run_status(state, stop_reason, columns),
        "progress": {"complete": complete, "total": len(columns)},
        "queue": queue(columns),
        "state": state,
        "stop_reason": stop_reason,
        "pr_url": pr_url,
        "started": run[0].get("time") if run else None,
        "updated": run[-1].get("time") if run else None,
        "cost": round(sum(this_run.values()), 2),
        "epic_cost": round(sum(every_run.values()), 2),
        "tickets": columns,
        "stats": ticket_stats(columns, by_ticket),
        "plan": plan_view(breakdown),
        "events": events,
        "epic_files": _files(home, home / "runs" / epic_key, image=False),
        "epic_agents": agent_logs(home / "runs" / epic_key),
    }


def run_status(state: str, stop_reason: str, tickets: list[dict[str, Any]]) -> str:
    """One word for the run: running, paused, completed, failed, blocked, stopped, or idle.

    Paused: every running ticket waits for the usage limit to reset. Completed: the Epic PR is open, or every
    ticket landed or was done before. Failed: the loop itself failed. Blocked: a ticket is stuck, or the run
    stopped for want of a ticket it could land.
    """
    columns = [ticket["column"] for ticket in tickets]
    if state == "running":
        working = [ticket for ticket in tickets if ticket["column"] == "running"]
        paused = working and all((ticket["step"] or {}).get("paused") for ticket in working)
        return "paused" if paused else "running"
    if state in ("pr-open", "pr-draft"):
        return "completed"
    if stop_reason == "loop-error":
        return "failed"
    if "stuck" in columns or stop_reason in ("circuit-breaker", "nothing-landed"):
        return "blocked"
    if columns and all(column in ("landed", "done") for column in columns):
        return "completed"
    return "stopped" if state == "stopped" else "idle"


def verdict(ui_review: dict[str, Any] | None, shots: list[dict[str, Any]]) -> str | None:
    """What the UI review made of the screenshots on disk: passed, unfixed (it landed with faults the review
    left), faults (a fix round follows), or unreviewed. A new review deletes the old screenshots before it
    saves its own, so a review line no older than the newest screenshot judged them.
    """
    if not shots:
        return None
    newest = max(shot["time"] for shot in shots)
    if ui_review is None or str(ui_review.get("time")) < newest:
        return "unreviewed"
    return {"pass": "passed", "fail": "faults", "unfixed": "unfixed"}.get(
        str(ui_review["result"]), "unreviewed"
    )


def ticket_health(step: dict[str, Any] | None, newest_log: str | None, gate_failures: int) -> dict[str, str]:
    """How a running ticket fares, from explicit conditions: on-track, attention, or blocked, with why."""
    if step and step.get("paused"):
        return {"state": "blocked", "reason": "It waits for the usage limit to reset."}
    if step and step["name"] in AGENT_STAGES:
        # The stage starts when its agent starts, so a new agent with no log yet is not quiet.
        quiet_since = max(str(newest_log or ""), str(step.get("since") or ""))
        minutes = (time.time() - datetime.fromisoformat(quiet_since).timestamp()) / 60 if quiet_since else 0
        if minutes > STALL_MINUTES:
            return {
                "state": "attention",
                "reason": f"The agent has written nothing for {int(minutes)} minutes.",
            }
    if gate_failures:
        times = "once" if gate_failures == 1 else f"{gate_failures} times"
        return {"state": "attention", "reason": f"The ticket gate failed {times}. The agent is fixing it."}
    return {"state": "on-track", "reason": ""}


def queue(tickets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The tickets that wait to start, in the order the loop takes them: the ready ones by key, as the
    frontier reads them, then the ones that wait on a blocker, after their blockers. A ticket whose blocker
    is stuck, or waits on a stuck one, is blocked and comes last.
    """
    by_key = {ticket["key"]: ticket for ticket in tickets}
    index = {ticket["key"]: number for number, ticket in enumerate(tickets)}

    def open_blockers(ticket: dict[str, Any]) -> list[str]:
        return [
            blocker["key"]
            for blocker in ticket["blockers"]
            if not blocker.get("done")
            and by_key.get(blocker["key"], {}).get("column") not in ("landed", "done")
        ]

    def depth(key: str, seen: frozenset[str] = frozenset()) -> tuple[int, bool]:
        """How many open blockers lie in a row before the ticket, and whether a stuck one is among them."""
        ticket = by_key.get(key)
        if ticket is None or key in seen:
            return 0, False
        if ticket["column"] == "stuck":
            return 0, True
        found = [depth(blocker, seen | {key}) for blocker in open_blockers(ticket)]
        return (1 + max(n for n, _ in found), any(stuck for _, stuck in found)) if found else (0, False)

    items = []
    for ticket in tickets:
        if ticket["column"] != "waiting":
            continue
        waits_on = open_blockers(ticket)
        levels, stuck = depth(ticket["key"])
        state = "blocked" if stuck else "waiting" if waits_on else "ready"
        items.append({"key": ticket["key"], "state": state, "waits_on": waits_on, "_order": levels})
    rank = {"ready": 0, "waiting": 1, "blocked": 2}
    items.sort(key=lambda item: (rank[item["state"]], item["_order"], index[item["key"]]))
    return [{key: value for key, value in item.items() if key != "_order"} for item in items]


def ticket_stats(columns: list[dict[str, Any]], by_ticket: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """The counts of the board, a ticket done before this run left out. Of the tickets that landed in this
    run: how many passed their first ticket gate, and the median time from their start to their landing.
    """
    names = ("landed", "running", "stuck", "waiting", "done")
    counts = {name: sum(1 for ticket in columns if ticket["column"] == name) for name in names}
    landed = landings(by_ticket)
    landed_here = len(landed)
    first_pass = sum(item["first_pass"] for item in landed)
    minutes = [item["minutes"] for item in landed if item["minutes"] is not None]
    return {
        "landed": counts["landed"],
        "total": len(columns) - counts["done"],
        "running": counts["running"],
        "stuck": counts["stuck"],
        "waiting": counts["waiting"],
        "first_pass_rate": first_pass / landed_here if landed_here else None,
        "median_land_minutes": statistics.median(minutes) if minutes else None,
    }


def landings(by_ticket: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """Each ticket that landed in a run, from its lines in that run: whether its first ticket gate passed,
    how many of its ticket gates failed, and its start and landing times with the minutes between them.
    """
    found = []
    for key, lines in by_ticket.items():
        land = next(
            (line for line in lines if line.get("step") == "land" and line.get("result") == "landed"), None
        )
        if land is None:
            continue
        gates = [line for line in lines if _is_gate(line, "ticket")]
        start = next((line for line in lines if line.get("step") == "start"), None)
        found.append(
            {
                "key": key,
                "first_pass": bool(gates) and gates[0].get("result") == "pass",
                "gate_failures": sum(1 for line in gates if line.get("result") == "fail"),
                "start": _time(start) if start else None,
                "land": _time(land),
                "minutes": (_time(land) - _time(start)) / 60 if start else None,
            }
        )
    return found


def plan_view(breakdown: dict[str, Any]) -> dict[str, Any]:
    """The plan meter of the run, and how many more tickets fit in the rest of each window at the share the
    run used per landed ticket. A meter whose window has reset since the run read it gives no estimate.
    """
    now: dict[str, dict[str, Any]] = {}
    fits: dict[str, int] = {}
    for window, value in breakdown["meter"].items():
        resets_at = value.get("resets_at")
        past = isinstance(resets_at, int | float) and resets_at < time.time()
        now[window] = {**value, "past": past}
        each = breakdown["plan_per_landed"].get(window)
        if each and not past:
            fits[window] = max(0, math.floor((100 - value["utilization"] * 100) / each + 1e-9))
    return {
        "used": breakdown["plan_used"],
        "per_landed": breakdown["plan_per_landed"],
        "now": now,
        "fits": fits,
    }


def current_step(lines: list[dict[str, Any]], newest_log: str | None) -> dict[str, Any] | None:
    """The step a running ticket is on, and when it began, from its lines in this run and the time its newest
    agent log last changed. An agent that still writes its log runs after the ticket's last line.
    """
    steps = [
        line
        for line in lines
        if line.get("step") not in QUIET_STEPS | AFTER_STEPS
        and not str(line.get("step")).startswith("tracker-")
        and line.get("result") != "started"
    ]
    if not steps:
        return None
    last = steps[-1]
    name, step, result = str(last.get("ticket")), last.get("step"), last.get("result")
    reviewed = any(line.get("step") == "code-review" for line in steps)
    gate_passed = _is_gate(last, "ticket") and result == "pass"
    review_passed = step == "code-review" and result == "pass"
    if newest_log is not None and newest_log > str(last.get("time")):
        # Which agent runs follows from the step before it.
        if gate_passed and not reviewed:
            current = "code-review"
        elif review_passed or (gate_passed and reviewed):
            current = "ui-review"
        else:
            current = "agent"
    elif name.endswith("-review"):
        current = "code-review"
    elif name.endswith("-ui"):
        current = "ui-review"
    elif step in ("agent", "build"):
        current = "ticket-gate" if result in ("done", "pass") else "agent"
    elif gate_passed:
        current = "land" if reviewed else "code-review"
    elif review_passed or (step == "ui-gate" and result == "pass") or _is_gate(last, "merge"):
        current = "land"
    else:
        current = "agent"
    return {"name": current, "since": last.get("time"), "paused": result == "usage-pause"}


def recent_activity(
    home: Path, key: str, run_dir: Path, agents: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """The last tool calls and messages of the ticket's newest agent log, read from its end."""
    if not agents:
        return []
    path = run_dir / f"agent-{agents[-1]['number']}.jsonl"
    try:
        size = path.stat().st_size
        with path.open("rb") as file:
            file.seek(max(0, size - TAIL_BYTES))
            data = file.read()
    except OSError:
        return []
    if size > TAIL_BYTES:
        data = data[data.find(b"\n") + 1 :]
    roots = (f"{home}/worktrees/{key}/", f"{home}/runs/{key}/")
    items: list[dict[str, Any]] = []
    for raw in data.splitlines():
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            items += [item for item in _items(event, roots) if item["kind"] in ("tool", "text")]
    return [
        {key: item[key] for key in ("kind", "tool", "summary", "text") if key in item}
        for item in items[-RECENT_ITEMS:]
    ]


def _is_gate(line: dict[str, Any], kind: str) -> bool:
    """A gate line names its log, such as `ticket-gate-1.log`. A ticket gate that finds no commit has none."""
    if kind == "ticket" and line.get("step") == "ticket-gate":
        return True
    return f"/{kind}-gate-" in str(line.get("detail") or "")


def _time(line: dict[str, Any]) -> float:
    return datetime.fromisoformat(str(line.get("time"))).timestamp()


def _session_costs(lines: list[dict[str, Any]]) -> dict[str, float]:
    """The cost of each agent session. A resumed session reports the cost of the whole session so far."""
    sessions: dict[str, float] = {}
    for number, line in enumerate(lines):
        cost = (line.get("usage") or {}).get("total_cost_usd")
        if isinstance(cost, int | float):
            sessions[line.get("session") or f"line-{number}"] = float(cost)
    return sessions


def _ticket_sessions(run: list[dict[str, Any]], key: str, sessions: dict[str, float]) -> dict[str, float]:
    ids = {line.get("session") for line in run if line.get("ticket") == key and line.get("usage")}
    return {session: cost for session, cost in sessions.items() if session in ids}


def _event(home: Path, line: dict[str, Any]) -> dict[str, Any]:
    detail = str(line.get("detail") or "")
    event = {
        "time": line.get("time"),
        "ticket": line.get("ticket"),
        "step": line.get("step"),
        "result": line.get("result"),
        "detail": detail.replace(f"{home}/", ""),
    }
    usage = line.get("usage") or {}
    if usage.get("total_cost_usd") is not None:
        event["cost"] = usage.get("total_cost_usd")
        event["turns"] = usage.get("num_turns")
    # A gate or stuck line names its log, which the page links to.
    for match in re.findall(rf"{re.escape(str(home))}/(runs/\S+)", detail):
        if (home / match).is_file():
            event["log"] = match
            break
    return event


def agent_logs(run_dir: Path) -> list[dict[str, Any]]:
    logs = []
    for path in run_dir.glob("agent-*.jsonl"):
        if match := AGENT_LOG.fullmatch(path.name):
            stat = path.stat()
            logs.append({"number": int(match[1]), "size": stat.st_size, "updated": _iso(stat.st_mtime)})
    return sorted(logs, key=lambda log: log["number"])


def _shots(home: Path, run_dir: Path) -> list[dict[str, Any]]:
    """The screenshots of the ticket's last UI review, each with the time it was saved."""
    return [
        {"path": path, "time": _iso((home / path).stat().st_mtime)}
        for path in _files(home, run_dir, image=True)
    ]


def _files(home: Path, run_dir: Path, image: bool) -> list[str]:
    images = {".png", ".jpg", ".jpeg", ".webp"}
    if not run_dir.is_dir():
        return []
    found = [
        path
        for path in run_dir.rglob("*")
        if path.is_file() and (path.suffix.lower() in images) == image and not AGENT_LOG.fullmatch(path.name)
    ]
    return [str(path.relative_to(home)) for path in sorted(found)]


def activity(home: Path, ticket: str, path: Path, offset: int) -> dict[str, Any]:
    """The events of one agent log from a byte offset, each as one line a person can scan.

    A line the agent still writes stays for the next read, so the next offset starts at a whole line.
    """
    size = path.stat().st_size
    with path.open("rb") as file:
        file.seek(min(offset, size))
        data = file.read(CHUNK_BYTES)
    end = data.rfind(b"\n") + 1
    items: list[dict[str, Any]] = []
    roots = (f"{home}/worktrees/{ticket}/", f"{home}/runs/{ticket}/")
    for raw in data[:end].splitlines():
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            items += _items(event, roots)
    return {"items": items, "offset": offset + end, "size": size}


def _items(event: dict[str, Any], roots: tuple[str, str]) -> Iterator[dict[str, Any]]:
    kind = event.get("type")
    parent = event.get("parent_tool_use_id")
    if kind == "system" and event.get("subtype") == "init":
        yield {"kind": "init", "model": event.get("model", ""), "session": event.get("session_id", "")}
    elif kind == "result":
        usage = {key: event.get(key) for key in ("total_cost_usd", "num_turns", "duration_ms")}
        yield {"kind": "result", "error": bool(event.get("is_error")), **usage}
    elif kind in ("assistant", "user"):
        content = (event.get("message") or {}).get("content")
        for block in content if isinstance(content, list) else []:
            item = _block(kind, block, roots)
            if item:
                yield {**item, "parent": parent}


def _block(kind: str, block: dict[str, Any], roots: tuple[str, str]) -> dict[str, Any] | None:
    worktree, run_dir = roots

    def short(text: str) -> str:
        return text.replace(worktree, "").replace(run_dir, "run/")

    if block.get("type") == "text" and kind == "assistant" and block.get("text", "").strip():
        return {"kind": "text", "text": short(block["text"].strip())[:DETAIL_CHARS]}
    if block.get("type") == "tool_use":
        name = str(block.get("name", ""))
        given = block.get("input")
        tool_input: dict[str, Any] = given if isinstance(given, dict) else {}
        if name == "StructuredOutput":
            return {
                "kind": "status",
                "status": tool_input.get("status", ""),
                "text": short(str(tool_input.get("reason", ""))),
                "decisions": [short(str(item)) for item in tool_input.get("decisions", [])],
            }
        label, summary, detail = tool_summary(name, tool_input)
        return {
            "kind": "tool",
            "id": block.get("id"),
            "tool": label,
            "summary": short(summary)[:SUMMARY_CHARS],
            "detail": short(detail)[:DETAIL_CHARS],
        }
    if block.get("type") == "tool_result":
        text = _result_text(block.get("content"))
        return {
            "kind": "output",
            "id": block.get("tool_use_id"),
            "error": bool(block.get("is_error")),
            "denied": DENIED in text,
            "text": short(text)[:DETAIL_CHARS],
        }
    return None


def _result_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
    return ""


def tool_summary(name: str, tool_input: dict[str, Any]) -> tuple[str, str, str]:
    """The label, the one-line summary, and the full input of one tool call."""

    def get(key: str) -> str:
        return str(tool_input.get(key, ""))

    first_line = get("command").strip().splitlines()[0] if get("command").strip() else ""
    if name == "Bash":
        return "Bash", get("description") or first_line, get("command")
    if name in ("Read", "Write", "Edit", "NotebookEdit"):
        path = get("file_path") or get("notebook_path")
        lines = len(get("content").splitlines())
        return name, path + (f" ({lines} lines)" if name == "Write" else ""), path
    if name in ("Grep", "Glob"):
        where = f" in {get('path')}" if get("path") else ""
        return name, f"{get('pattern')}{where}", json.dumps(tool_input)
    if name in ("Agent", "Task"):
        kind = f"{get('subagent_type')}: " if get("subagent_type") else ""
        return "Agent", f"{kind}{get('description')}", get("prompt")
    if name == "Skill":
        return "Skill", f"{get('skill')} {get('args')}".strip(), get("args")
    if name == "SubagentHandback":
        message = get("message").strip()
        return "Handback", message.splitlines()[0] if message else "", message
    if name in ("WebFetch", "WebSearch", "ToolSearch"):
        return name, get("url") or get("query"), json.dumps(tool_input)
    if name.startswith("mcp__"):
        _, server, tool = (name.split("__", 2) + ["", ""])[:3]
        return server, tool, json.dumps(tool_input, indent=1)
    return name, json.dumps(tool_input)[:SUMMARY_CHARS], json.dumps(tool_input, indent=1)


# --- The plan meter ---

_meter_lock = threading.Lock()
_meters: dict[Path, tuple[Any, dict[str, dict[str, Any]]]] = {}


def plan_meter(state_dir: Path) -> dict[str, dict[str, Any]]:
    """The newest reading of the account's plan meter on this host, for each window: its utilization, when
    it resets, when it was read, and whether it has reset since. The meter belongs to the account, so the
    newest reading of any run of any project counts. A running agent's log gives one that is minutes old; a
    finished agent's line in `decisions.jsonl` gives the reading at its end. Dollars never stand in for it.
    """
    readings = []
    for home in projects(state_dir).values():
        active = active_run(home)
        for epic in home.iterdir() if home.is_dir() else []:
            if not KEY.fullmatch(epic.name):
                continue
            readings.append(_lines_meter(epic / DECISIONS))
            if epic.name != active:
                continue
            for run_dir in (epic / "runs").iterdir() if (epic / "runs").is_dir() else []:
                logs = agent_logs(run_dir)
                if logs:
                    readings.append(_log_meter(run_dir / f"agent-{logs[-1]['number']}.jsonl"))
    newest: dict[str, dict[str, Any]] = {}
    for reading in readings:
        for window, value in reading.items():
            if window not in newest or value["read"] > newest[window]["read"]:
                newest[window] = value
    now = time.time()
    return {
        window: {**value, "past": isinstance(value["resets_at"], int | float) and value["resets_at"] < now}
        for window, value in newest.items()
    }


def _reading(plan: dict[str, dict[str, Any]], read: str) -> dict[str, dict[str, Any]]:
    return {
        window: {"utilization": value["end"], "resets_at": value.get("resets_at"), "read": read}
        for window, value in plan.items()
        if isinstance(value, dict) and isinstance(value.get("end"), int | float)
    }


def _lines_meter(path: Path) -> dict[str, dict[str, Any]]:
    """The newest reading among a log's agent lines, read again only when the log changes."""
    try:
        stat = path.stat()
    except OSError:
        return {}
    signature = (stat.st_size, stat.st_mtime)
    with _meter_lock:
        cached = _meters.get(path)
        if cached and cached[0] == signature:
            return cached[1]
    found: dict[str, dict[str, Any]] = {}
    for line in read_lines(path):
        if isinstance(line.get("plan"), dict):
            found |= _reading(line["plan"], str(line.get("time")))
    with _meter_lock:
        _meters[path] = (signature, found)
    return found


def _log_meter(path: Path) -> dict[str, dict[str, Any]]:
    """The newest `rate_limit_event` reading in an agent log, read from where the last call stopped. Its
    events carry no time, so the reading counts as read when the log last changed, which is no earlier.
    """
    try:
        stat = path.stat()
    except OSError:
        return {}
    with _meter_lock:
        offset, found = _meters.get(path, (0, {}))
        if stat.st_size < offset:
            offset, found = 0, {}
        start = max(offset, stat.st_size - METER_TAIL_BYTES)
        try:
            with path.open("rb") as file:
                file.seek(start)
                data = file.read(stat.st_size - start)
        except OSError:
            return found
        skip = data.find(b"\n") + 1 if start > offset else 0
        end = data.rfind(b"\n") + 1
        for raw in reversed(data[skip:end].splitlines()):
            if METER_EVENT not in raw:
                continue
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue
            reading = _reading(agent_plan([event]), _iso(stat.st_mtime))
            if reading:
                found = {**found, **reading}
                break
        _meters[path] = (start + max(end, skip), found)
        return found


# --- Server ---


class Forecast(Protocol):
    """The capacity forecast, which `loop watch` wires in from `forecast.py`."""

    def view(self) -> dict[str, Any]: ...

    def refresh(self) -> bool: ...


class Watch:
    def __init__(self, state_dir: Path, forecast: Forecast | None = None) -> None:
        self.state_dir = state_dir
        self.forecast = forecast

    def masker(self) -> Masker:
        # Read for each request, so a new `loop secrets` takes effect without a restart.
        return Masker(*(read_secrets(home) for home in projects(self.state_dir).values()))

    def handle(self, url: str) -> tuple[HTTPStatus, str, bytes]:
        """Each API path and file takes `?project=<name>`, and without it serves this repo's project."""
        parsed = urlparse(url)
        parts = [unquote(part) for part in parsed.path.strip("/").split("/") if part]
        query = parse_qs(parsed.query)
        if not parts:
            return HTTPStatus.OK, "text/html; charset=utf-8", PAGE.read_bytes()
        if parts == ["api", "projects"]:
            return self.json(project_list(self.state_dir))
        if parts == ["api", "home"]:
            return self.json(host_view(self.state_dir))
        if parts == ["api", "usage"]:
            return self.json(plan_meter(self.state_dir))
        if parts == ["api", "forecast"]:
            return self.json(self.forecast.view() if self.forecast else None)
        name = query.get("project", [""])[0]
        state_dir = projects(self.state_dir).get(name) if name else self.state_dir
        if state_dir is None:
            return self.missing()
        if parts == ["api", "epics"]:
            return self.json(epics(state_dir))
        if len(parts) == 3 and parts[:2] == ["api", "epic"] and KEY.fullmatch(parts[2]):
            if not (state_dir / parts[2] / DECISIONS).exists():
                return self.missing()
            return self.json(epic_view(state_dir, parts[2]))
        if len(parts) == 3 and parts[:2] == ["api", "report"] and KEY.fullmatch(parts[2]):
            against = query.get("against", [""])[0]
            found = comparison(state_dir, parts[2], against if KEY.fullmatch(against) else None)
            return self.json(found) if found else self.missing()
        if len(parts) == 5 and parts[:2] == ["api", "agent"] and all(KEY.fullmatch(p) for p in parts[2:4]):
            home = state_dir / parts[2]
            path = home / "runs" / parts[3] / f"agent-{parts[4]}.jsonl"
            if not parts[4].isdigit() or not path.is_file():
                return self.missing()
            offset = int(query.get("offset", ["0"])[0] or 0)
            return self.json(activity(home, parts[3], path, offset))
        if len(parts) >= 4 and parts[0] == "files" and KEY.fullmatch(parts[1]) and parts[2] == "runs":
            return self.file(state_dir / parts[1], "/".join(parts[2:]))
        return self.missing()

    def post(self, url: str) -> tuple[HTTPStatus, str, bytes]:
        """The one request that does something: read the backlog from Jira now. No run reads the result."""
        if urlparse(url).path.rstrip("/") == "/api/forecast/refresh" and self.forecast:
            return self.json({"started": self.forecast.refresh()})
        return self.missing()

    def json(self, data: Any) -> tuple[HTTPStatus, str, bytes]:
        body = json.dumps(self.masker().data(data)).encode()
        return HTTPStatus.OK, "application/json", body

    def file(self, home: Path, relative: str) -> tuple[HTTPStatus, str, bytes]:
        root = (home / "runs").resolve()
        path = (home / relative).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            return self.missing()
        kind = mimetypes.guess_type(path.name)[0] or "text/plain"
        if kind.startswith("image/"):
            return HTTPStatus.OK, kind, path.read_bytes()
        text = self.masker().text(path.read_text(errors="replace"))
        return HTTPStatus.OK, "text/plain; charset=utf-8", text.encode()

    def missing(self) -> tuple[HTTPStatus, str, bytes]:
        return HTTPStatus.NOT_FOUND, "text/plain", b"Not found"


def handler(watch: Watch) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - the name http.server calls.
            self.reply(*watch.handle(self.path))

        def do_POST(self) -> None:  # noqa: N802 - the name http.server calls.
            self.reply(*watch.post(self.path))

        def reply(self, status: HTTPStatus, kind: str, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            # An open page reloads itself when the page on disk changes, as after `loop` updates.
            self.send_header("X-Page-Version", str(PAGE.stat().st_mtime_ns))
            # The page asks for a screenshot by its saved time, so a new one has a new address.
            self.send_header(
                "Cache-Control", "private, max-age=86400" if kind.startswith("image/") else "no-store"
            )
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            pass

    return Handler


def addresses() -> list[str]:
    """Localhost, and this host's tailnet address when it has one. No other network reaches the page."""
    found = ["127.0.0.1"]
    try:
        result = process.run(["tailscale", "ip", "-4"], seconds=5)
    except OSError:
        return found
    if result.returncode == 0 and result.stdout.strip():
        found.append(result.stdout.split()[0])
    return found


def serve(
    state_dir: Path, port: int, hosts: list[str] | None = None, forecast: Forecast | None = None
) -> list[ThreadingHTTPServer]:
    """Starts one server for each address, each in its own thread, and returns them."""
    watch = Watch(state_dir, forecast)
    servers = []
    for host in hosts or addresses():
        try:
            server = ThreadingHTTPServer((host, port), handler(watch))
        except OSError as error:
            if host == "127.0.0.1":
                raise
            print(f"loop watch does not listen on {host}: {error}", flush=True)
            continue
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    return servers


def url(port: int, epic_key: str | None = None, host: str = "127.0.0.1", project: str | None = None) -> str:
    path = "/".join(part for part in (project, epic_key) if part)
    return f"http://{host}:{port}/" + (f"#/{path}" if path else "")
