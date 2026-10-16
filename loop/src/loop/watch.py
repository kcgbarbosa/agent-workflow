"""`loop watch`: a web page of the runs on this host.

It reads only what the run writes to the state folder: `decisions.jsonl`, `board.json`, the agent logs, the
gate logs, and the screenshots, and asks systemd which runs are active. Only Start and Stop change anything,
through the functions that `loop start` and `loop stop` call.
"""

from __future__ import annotations

import json
import math
import mimetypes
import re
import statistics
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qs, unquote, urlparse, urlsplit

from . import process, report, units
from .config import WATCH_PORT, Config, ConfigError, stored_secrets
from .forecast import BacklogError, jira_client, open_epics, project_keys
from .jira import JiraError
from .report import DECISIONS, KEY, LOOP_SUFFIX, epic_homes, is_gate, iso, plan_meter, projects, read_lines
from .steps import STEPS, current_step

BOARD = "board.json"
PAGE = Path(__file__).with_name("watch.html")
AGENT_LOG = re.compile(r"agent-(\d+)\.jsonl")
DENIED = "denied by the Claude Code auto mode classifier"
# A short secret would mask ordinary words.
MIN_SECRET = 8
# The steps that say nothing new on the page.
QUIET_STEPS = {
    "tracker-status",
    "tracker-flag",
    "tracker-comment",
    "tracker-attach",
    "tracker-comments",
    "meter",
}
# The Epic lines, besides a stop and the Epic PR, that end a run, with the reason the page gives.
END_LINES = {("finish", "nothing-landed"): "nothing-landed", ("base", "missing"): "base-missing"}
# The results of an agent that waits for a usage limit to reset.
LIMITED = ("usage-limit", "usage-pause")
RECENT_ITEMS = 3
TAIL_BYTES = 256_000
SUMMARY_CHARS = 160
DETAIL_CHARS = 4000
CHUNK_BYTES = 2_000_000
# The steps in which an agent writes its log.
AGENT_STEPS = {"build", "code-review", "ui-gate"}
# An agent that writes nothing for longer than this needs a look. A Bash call stops after 10 minutes, so a
# quiet agent past 15 runs no command.
STALL_MINUTES = 15


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


def running_epics(state_dir: Path) -> set[str]:
    """The Epic keys of the project whose run unit systemd has active."""
    name = state_dir.name.removesuffix(LOOP_SUFFIX)
    keys = [home.name for home in epic_homes(state_dir)]
    try:
        active = units.active([units.run_unit(name, key) for key in keys])
    except units.UnitError:
        return set()
    return {key for key in keys if units.run_unit(name, key) in active}


def host_view(state_dir: Path) -> list[dict[str, Any]]:
    """Each project on this host with the latest run of each of its Epics, the running one first, then the
    newest: its status, its tickets complete of the total, and the step of each running ticket. The home page
    lists them, and the page's project and Epic menus read them.
    """
    found = []
    for name, home in projects(state_dir).items():
        running = running_epics(home)
        runs = []
        for epic in sorted(
            epic_homes(home), key=lambda epic: (epic / DECISIONS).stat().st_mtime, reverse=True
        ):
            view = epic_view(home, epic.name, epic.name in running)
            working = [
                {"key": ticket["key"], "step": (ticket["step"] or {}).get("name")}
                for ticket in view["tickets"]
                if ticket["column"] == "running"
            ]
            runs.append(
                {
                    "key": epic.name,
                    "summary": view["summary"],
                    "updated": iso((epic / DECISIONS).stat().st_mtime),
                    "running": epic.name in running,
                    "status": view["status"],
                    "progress": view["progress"],
                    "stuck": view["stats"]["stuck"],
                    "working": working,
                }
            )
        runs.sort(key=lambda run: not run["running"])
        found.append({"name": name, "runs": runs})
    return found


def comparison(
    state_dir: Path, epic_key: str | None = None, against: str | None = None
) -> dict[str, Any] | None:
    """The breakdown of an Epic's latest run, or of the latest run on this host, against the run before it."""
    runs = report.all_runs(state_dir)
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


def epic_view(state_dir: Path, epic_key: str, running: bool | None = None) -> dict[str, Any]:
    """The state of one Epic's latest run: the run, the tickets in columns, and the steps. `running` is
    whether systemd has the run's unit active, which the view asks systemd when the caller does not know."""
    home = state_dir / epic_key
    lines = read_lines(home / DECISIONS)
    if running is None:
        running = epic_key in running_epics(state_dir)
    # The latest run starts at the last start line of the Epic.
    starts = [
        index
        for index, line in enumerate(lines)
        if line.get("ticket") == epic_key and line.get("step") == "start"
    ]
    run = lines[starts[-1] :] if starts else lines
    board = _board(home)

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

    # A run that ended wrote its end line. One with none was killed.
    state, stop_reason = ("stopped", "killed") if starts else ("idle", "")
    pr_url = ""
    every_run = _session_costs(lines)
    # A UI review of a ticket that landed in an earlier run is in an earlier run's lines.
    for line in lines:
        if (
            line.get("step") == "ui-gate"
            and line.get("ticket") in tickets
            and line.get("result") != "started"
        ):
            tickets[line["ticket"]].ui_review = {"result": line.get("result"), "time": line.get("time")}
    events, resumes = [], None
    for line in run:
        step, result = line.get("step", ""), line.get("result", "")
        key = report.ticket_key(line)
        if key == epic_key:
            if step == "stop" or (step, result) in END_LINES:
                state, stop_reason = "stopped", END_LINES.get((step, result), result)
            elif step == "pr" and result in ("pr-open", "pr-draft"):
                state, stop_reason, pr_url = result, "", line.get("detail", "")
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
            if is_gate(line, "ticket") and result != "started":
                ticket.gate_failures = ticket.gate_failures + 1 if result == "fail" else 0
            if step == "ui-gate" and result != "started":
                ticket.ui_review = {"result": result, "time": line.get("time")}
            if step not in QUIET_STEPS and not step.startswith("tracker-"):
                ticket.last = {"step": step, "result": result, "time": line.get("time")}
        if result == "usage-pause" and line.get("resumes"):
            resumes = max(resumes or "", str(line["resumes"]))
        if step not in QUIET_STEPS:
            events.append(_event(home, line))
    if running:
        state, stop_reason = "running", ""
    paused = running and resumes is not None and datetime.fromisoformat(resumes).timestamp() > time.time()

    columns = []
    for ticket in tickets.values():
        own = by_ticket.get(ticket.key, [])
        step = current_step(own)
        if ticket.landed:
            column = "landed"
        elif ticket.stuck_reason or ticket.flagged:
            column = "stuck"
        elif ticket.done:
            column = "done"
        elif ticket.started and running:
            column = "running"
        elif step and state == "stopped":
            column = "stopped"
        else:
            column = "waiting"
        if step:
            step["paused"] = paused and _limited(own)
        run_dir = home / "runs" / ticket.key
        agents = agent_logs(run_dir)
        live = column == "running"
        newest = max((log["updated"] for log in agents), default=None)
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
                "agents": [{"number": log["number"], "updated": log["updated"]} for log in agents],
                "step": step if live or column == "stopped" else None,
                "health": ticket_health(step, newest, ticket.gate_failures) if live else None,
                "gate_failures": ticket.gate_failures,
                "recent": recent_activity(home, ticket.key, run_dir, agents) if live else [],
                "screenshots": shots,
                "verdict": verdict(ticket.ui_review, shots),
                "files": _files(home, run_dir, image=False),
            }
        )
    breakdown = report.breakdown(epic_key, run)
    complete = sum(1 for ticket in columns if ticket["column"] in ("landed", "done"))
    status = "paused" if paused else run_status(state, stop_reason, columns)
    return {
        "key": epic_key,
        "summary": board.get("summary", ""),
        "branch": board.get("branch", ""),
        "status": status,
        "resumes": resumes if status == "paused" else None,
        "progress": {"complete": complete, "total": len(columns)},
        "queue": queue(columns),
        "state": state,
        "stop_reason": stop_reason,
        "pr_url": pr_url,
        "started": run[0].get("time") if run else None,
        "updated": run[-1].get("time") if run else None,
        "tickets": columns,
        "stats": ticket_stats(columns, by_ticket),
        "plan": plan_view(breakdown),
        "events": events,
        "epic_files": _files(home, home / "runs" / epic_key, image=False),
        "epic_agents": [
            {"number": log["number"], "updated": log["updated"]}
            for log in agent_logs(home / "runs" / epic_key)
        ],
    }


def _limited(lines: list[dict[str, Any]]) -> bool:
    """Whether the ticket's last agent run met a usage limit, with no step after it."""
    last = next((line for line in reversed(lines) if line.get("step") in ("agent", *STEPS)), None)
    return last is not None and last.get("step") == "agent" and last.get("result") in LIMITED


def run_status(state: str, stop_reason: str, tickets: list[dict[str, Any]]) -> str:
    """One word for the run: running, completed, failed, blocked, stopped, or idle. A paused run is running.

    Completed: the Epic PR is open, or every ticket landed or was done before. Failed: the loop itself failed.
    Blocked: a ticket is stuck, or the run stopped for want of a ticket it could land.
    """
    columns = [ticket["column"] for ticket in tickets]
    if state == "running":
        return "running"
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
    return {"pass": "passed", "fail": "faults", "open": "unfixed", "unfixed": "unfixed"}.get(
        str(ui_review["result"]), "unreviewed"
    )


def ticket_health(step: dict[str, Any] | None, newest_log: str | None, gate_failures: int) -> dict[str, str]:
    """How a running ticket fares, from explicit conditions: on-track, attention, or blocked, with why."""
    if step and step.get("paused"):
        return {"state": "blocked", "reason": "It waits for the usage limit to reset."}
    if step and step["name"] in AGENT_STEPS:
        # The step starts when its agent starts, so a new agent with no log yet is not quiet.
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
    """The landed and stuck tickets of the board. Of the tickets that landed in this run: how many passed
    their first ticket gate, and the median time from their start to their landing.
    """
    landed = report.landings(by_ticket)
    first_pass = sum(item["first_pass"] for item in landed)
    minutes = [item["minutes"] for item in landed if item["minutes"] is not None]
    return {
        "landed": sum(1 for ticket in columns if ticket["column"] == "landed"),
        "stuck": sum(1 for ticket in columns if ticket["column"] == "stuck"),
        "first_pass_rate": first_pass / len(landed) if landed else None,
        "median_land_minutes": statistics.median(minutes) if minutes else None,
    }


def plan_view(breakdown: dict[str, Any]) -> dict[str, Any]:
    """The share of each window the run used, per landed ticket too, and how many more tickets fit in the
    rest of each window at that share. A meter whose window has reset since the run read it gives no
    estimate.
    """
    fits: dict[str, int] = {}
    for window, value in breakdown["meter"].items():
        resets_at = value.get("resets_at")
        past = isinstance(resets_at, int | float) and resets_at < time.time()
        each = breakdown["plan_per_landed"].get(window)
        if each and not past:
            fits[window] = max(0, math.floor((100 - value["utilization"] * 100) / each + 1e-9))
    return {"used": breakdown["plan_used"], "per_landed": breakdown["plan_per_landed"], "fits": fits}


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
            logs.append({"number": int(match[1]), "size": stat.st_size, "updated": iso(stat.st_mtime)})
    return sorted(logs, key=lambda log: log["number"])


def _shots(home: Path, run_dir: Path) -> list[dict[str, Any]]:
    """The screenshots of the ticket's last UI review, each with the time it was saved."""
    return [
        {"path": path, "time": iso((home / path).stat().st_mtime)}
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
        yield {"kind": "init", "model": event.get("model", "")}
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


# --- Server ---


class Forecast(Protocol):
    """The capacity forecast, which `loop watch` wires in from `forecast.py`."""

    def view(self) -> dict[str, Any]: ...


class Watch:
    """`config` is the project whose `loop.toml` started `loop watch`. Start and Stop act on it only."""

    def __init__(
        self, state_dir: Path, forecast: Forecast | None = None, config: Config | None = None
    ) -> None:
        self.state_dir = state_dir
        self.forecast = forecast
        self.config = config

    def masker(self) -> Masker:
        # Read for each request, so a new `loop secrets` takes effect without a restart.
        return Masker(*(stored_secrets(home) for home in projects(self.state_dir).values()))

    def handle(self, url: str) -> tuple[HTTPStatus, str, bytes]:
        """Each API path and file takes `?project=<name>`, and without it serves this repo's project."""
        parsed = urlparse(url)
        parts = [unquote(part) for part in parsed.path.strip("/").split("/") if part]
        query = parse_qs(parsed.query)
        if not parts:
            return HTTPStatus.OK, "text/html; charset=utf-8", PAGE.read_bytes()
        if parts == ["api", "home"]:
            control = self.config.name if self.config else None
            return self.json(
                [{**project, "control": project["name"] == control} for project in host_view(self.state_dir)]
            )
        if parts == ["api", "start"] and self.config:
            return self.json(self.startable(self.config))
        if parts == ["api", "usage"]:
            return self.json(plan_meter(self.state_dir))
        if parts == ["api", "forecast"]:
            return self.json(self.forecast.view() if self.forecast else None)
        name = query.get("project", [""])[0]
        state_dir = projects(self.state_dir).get(name) if name else self.state_dir
        if state_dir is None:
            return self.missing()
        if len(parts) == 3 and parts[:2] == ["api", "epic"] and KEY.fullmatch(parts[2]):
            if not (state_dir / parts[2] / DECISIONS).exists():
                return self.missing()
            return self.json(epic_view(state_dir, parts[2]))
        if len(parts) == 3 and parts[:2] == ["api", "report"] and KEY.fullmatch(parts[2]):
            against = query.get("against", [""])[0]
            found = comparison(state_dir, parts[2], against if KEY.fullmatch(against) else None)
            if found is None:
                return self.missing()
            previous = found["previous"]
            before = {"epic": previous["epic"], "started": previous["started"]} if previous else None
            return self.json({"previous": before, "rows": found["rows"]})
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

    def startable(self, config: Config) -> dict[str, Any]:
        """The open Epics that Start lists: those of the Jira projects whose Epics ran on this host."""
        try:
            epics = open_epics(jira_client(config), project_keys(config.state_dir))
        except (BacklogError, JiraError) as error:
            return {"epics": [], "error": str(error)}
        return {"epics": [{"key": epic["key"], "summary": epic["summary"]} for epic in epics]}

    def post(self, url: str) -> tuple[HTTPStatus, str, bytes]:
        """Start and Stop of a run, the only requests that change anything."""
        parts = urlparse(url).path.strip("/").split("/")
        if len(parts) != 3 or parts[1] not in ("start", "stop") or not KEY.fullmatch(parts[2]):
            return self.missing()
        command, epic_key = parts[1], parts[2]
        if parts[0] != "api" or self.config is None:
            return self.missing()
        try:
            if command == "start":
                units.start_epic(self.config.repo, epic_key, None, new_code=False)
                return self.json({"started": epic_key})
            if units.stop_run(self.config.name, epic_key):
                return self.json({"stopped": epic_key})
            return self.refused(f"No run of {epic_key} is active.")
        except (units.UnitError, ConfigError) as error:
            return self.refused(str(error))

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

    def refused(self, reason: str) -> tuple[HTTPStatus, str, bytes]:
        return HTTPStatus.CONFLICT, "application/json", json.dumps({"error": reason}).encode()

    def missing(self) -> tuple[HTTPStatus, str, bytes]:
        return HTTPStatus.NOT_FOUND, "text/plain", b"Not found"


FORBIDDEN = HTTPStatus.FORBIDDEN, "text/plain", b"Forbidden"


def handler(watch: Watch, names: set[str]) -> type[BaseHTTPRequestHandler]:
    """Answers only a Host of this host's `names`. A site whose name resolves to this host, as in DNS
    rebinding, sends its own name, and gets 403."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - the name http.server calls.
            self.reply(*(watch.handle(self.path) if self.allowed() else FORBIDDEN))

        def do_POST(self) -> None:  # noqa: N802 - the name http.server calls.
            self.reply(*(watch.post(self.path) if self.allowed() else FORBIDDEN))

        def allowed(self) -> bool:
            try:
                return urlsplit(f"//{self.headers.get('Host', '')}").hostname in names
            except ValueError:
                return False

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


def tailnet() -> tuple[str, str] | None:
    """This host's IPv4 address on the tailnet and its MagicDNS name, when it is on a tailnet."""
    try:
        result = process.run(["tailscale", "status", "--json"], seconds=5)
        own = json.loads(result.stdout)["Self"]
    except OSError, ValueError, KeyError, TypeError:
        return None
    address = next((ip for ip in own.get("TailscaleIPs") or [] if "." in ip), None)
    return (address, str(own.get("DNSName", "")).rstrip(".").lower()) if address else None


def addresses() -> list[str]:
    """Localhost, and this host's tailnet address when it has one. No other network reaches the page."""
    found = tailnet()
    return ["127.0.0.1", found[0]] if found else ["127.0.0.1"]


def host_names() -> set[str]:
    """The names a request may give as its Host: localhost, the tailnet address, and the MagicDNS name, in
    full and as the host name alone, which the tailnet's search domain completes."""
    names = {"localhost", "127.0.0.1"}
    if found := tailnet():
        address, dns = found
        names |= {address, dns, dns.split(".")[0]} - {""}
    return names


def serve(
    state_dir: Path,
    port: int,
    hosts: list[str] | None = None,
    forecast: Forecast | None = None,
    config: Config | None = None,
) -> list[ThreadingHTTPServer]:
    """Starts one server for each address, each in its own thread, and returns them."""
    watch = Watch(state_dir, forecast, config)
    names = host_names()
    servers = []
    for host in hosts or addresses():
        try:
            server = ThreadingHTTPServer((host, port), handler(watch, names))
        except OSError as error:
            if host == "127.0.0.1":
                raise
            print(f"loop watch does not listen on {host}: {error}", flush=True)
            continue
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    return servers


def url(epic_key: str | None = None, host: str = "127.0.0.1", project: str | None = None) -> str:
    path = "/".join(part for part in (project, epic_key) if part)
    return f"http://{host}:{WATCH_PORT}/" + (f"#/{path}" if path else "")
