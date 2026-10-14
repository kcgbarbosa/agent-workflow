"""The capacity forecast on the Usage view of `loop watch`: what each Claude plan delivered, what the open
Epics in Jira still hold, and what that work needs of the plan.

It reports only. The loop never reads what it writes, and it reads Jira through one search and never writes.
"""

from __future__ import annotations

import json
import os
import re
import statistics
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from . import report
from .config import Config, PlanSpan
from .jira import Jira
from .watch import KEY, all_runs, landings, plan_meter, read_secrets

# Anthropic's published plans: the usage of each against Pro's, and the monthly price in US dollars, from
# https://claude.com/pricing. Anthropic states the multiple for the 5-hour window, and none for the week.
PLANS: dict[str, dict[str, Any]] = {
    "pro": {"name": "Pro", "multiple": 1, "price": 20},
    "max-5x": {"name": "Max 5x", "multiple": 5, "price": 100},
    "max-20x": {"name": "Max 20x", "multiple": 20, "price": 200},
}
SNAPSHOT = "backlog.json"
# A plan with fewer landed tickets than this under a meter reading has preliminary figures, and the estimate
# also takes the other plans' runs, scaled by the multiple.
MIN_TICKETS = 5
CONFIDENT_TICKETS = 15
REFRESH_GAP_SECONDS = 30
WINDOW_MINUTES = 300
RESETS = re.compile(r"resets at (\S+?)\.?$")
EPIC_FIELDS = ["summary", "status"]
TICKET_FIELDS = ["summary", "status", "parent", "issuelinks"]
WINDOWS = ("five_hour", "seven_day")


class BacklogError(Exception):
    pass


class Search(Protocol):
    def search(self, jql: str, fields: list[str]) -> list[dict[str, Any]]: ...


# --- The Jira snapshot ---


def fetch(jira: Search, projects: list[str]) -> list[dict[str, Any]]:
    """The open Epics of the projects, each with its tickets: key, title, status, and blockers. No ticket
    text, so the snapshot can never stand in for a ticket's spec.
    """
    found: dict[str, dict[str, Any]] = {}
    jql = (
        f"project in ({', '.join(projects)}) AND issuetype = Epic AND statusCategory != Done ORDER BY key ASC"
    )
    for issue in jira.search(jql, EPIC_FIELDS):
        fields = issue["fields"]
        found[issue["key"]] = {
            "key": issue["key"],
            "summary": fields.get("summary", ""),
            "status": fields["status"]["name"],
            "tickets": [],
        }
    if not found:
        return []
    for issue in jira.search(f"parent in ({', '.join(found)}) ORDER BY key ASC", TICKET_FIELDS):
        fields = issue["fields"]
        parent = (fields.get("parent") or {}).get("key")
        if parent not in found:
            continue
        found[parent]["tickets"].append(
            {
                "key": issue["key"],
                "summary": fields.get("summary", ""),
                "status": fields["status"]["name"],
                "done": _is_done(fields["status"]),
                "blockers": [
                    {
                        "key": link["inwardIssue"]["key"],
                        "done": _is_done(link["inwardIssue"]["fields"]["status"]),
                    }
                    for link in fields.get("issuelinks") or []
                    if link["type"]["name"] == "Blocks" and "inwardIssue" in link
                ],
            }
        )
    return list(found.values())


def _is_done(status: dict[str, Any]) -> bool:
    return bool(status.get("statusCategory", {}).get("key") == "done")


def project_keys(state_dir: Path) -> list[str]:
    """The Jira projects of the Epics that ran on this host."""
    homes = state_dir.iterdir() if state_dir.is_dir() else []
    return sorted({home.name.split("-")[0] for home in homes if KEY.fullmatch(home.name)})


class Backlog:
    """The snapshot of the open Epics, read from Jira every `minutes` and on request, and kept in
    `backlog.json` so a restart shows the last one with its age. A failed read keeps the last snapshot and
    says why.
    """

    def __init__(self, state_dir: Path, client: Callable[[], Search], minutes: int) -> None:
        self.state_dir = state_dir
        self.path = state_dir / SNAPSHOT
        self.interval = minutes * 60
        self._client = client
        self._wake = threading.Event()
        self._lock = threading.Lock()
        self.snapshot: dict[str, Any] | None = _load(self.path)
        self.error: str | None = None
        self.error_at: str | None = None
        self.syncing = False
        self.asked = 0.0

    def start(self) -> None:
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self) -> None:
        while True:
            self.sync()
            self._wake.wait(self.interval)
            self._wake.clear()

    def refresh(self) -> bool:
        """Asks for a read now. A read that runs, or one in the last 30 seconds, makes it wait."""
        with self._lock:
            if self.syncing or time.time() - self.asked < REFRESH_GAP_SECONDS:
                return False
        self._wake.set()
        return True

    def sync(self) -> None:
        with self._lock:
            self.syncing, self.asked = True, time.time()
        try:
            projects = project_keys(self.state_dir)
            if not projects:
                raise BacklogError("No run on this host names a Jira project yet.")
            snapshot = {
                "synced": _iso(time.time()),
                "projects": projects,
                "epics": fetch(self._client(), projects),
            }
        except Exception as error:  # noqa: BLE001 - a failed read changes the forecast only.
            with self._lock:
                self.error, self.error_at, self.syncing = str(error)[:300], _iso(time.time()), False
            return
        try:
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps(snapshot))
            os.replace(temporary, self.path)
            problem = None
        except OSError as failure:
            problem = f"The snapshot was read but not saved: {failure}"
        with self._lock:
            self.snapshot, self.syncing = snapshot, False
            self.error, self.error_at = problem, (_iso(time.time()) if problem else None)

    def status(self) -> dict[str, Any]:
        with self._lock:
            synced = self.snapshot.get("synced") if self.snapshot else None
            age = time.time() - datetime.fromisoformat(synced).timestamp() if synced else None
            return {
                "synced": synced,
                # Two missed reads in a row make the snapshot stale.
                "stale": age is None or age > 2 * self.interval + 60,
                "error": self.error,
                "error_at": self.error_at,
                "syncing": self.syncing,
                "interval_minutes": self.interval // 60,
            }


def _load(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text())
    except OSError, json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) and isinstance(data.get("epics"), list) else None


# --- What each plan delivered ---


def plan_of(spans: tuple[PlanSpan, ...], start: float, end: float) -> str | None:
    """The plan of a run: a plan key, `ambiguous` when a change may fall inside the run, or None before the
    first span. A span with a date only leaves the runs of that day to either plan.
    """
    current: str | None = None
    for span in spans:
        since = span.since.timestamp()
        until = since if span.exact else since + 86400
        if until <= start:
            current = span.plan
        elif since < end:
            return span.plan if span.plan == current else "ambiguous"
        else:
            break
    return current


def run_records(state_dir: Path, spans: tuple[PlanSpan, ...]) -> list[dict[str, Any]]:
    """Each run on this host with its plan, its landed tickets, its plan usage, and its usage-limit waits."""
    records = []
    for epic, run in all_runs(state_dir):
        started, ended = _time(run[0]), _time(run[-1])
        by_ticket: dict[str, list[dict[str, Any]]] = {}
        for line in run:
            name = str(line.get("ticket", ""))
            key = match[0] if (match := KEY.match(name)) else name
            if key != epic:
                by_ticket.setdefault(key, []).append(line)
        waits = _waits(run, ended)
        landed = landings(by_ticket)
        for item in landed:
            if item["minutes"] is not None:
                waited = sum(_overlap(wait, item["start"], item["land"]) for wait in waits) / 60
                item["active_minutes"] = max(0.0, item["minutes"] - waited)
        records.append(
            {
                "epic": epic,
                "started": started,
                "ended": ended,
                "plan": plan_of(spans, started, ended),
                "landed": landed,
                "stuck": sum(1 for line in run if line.get("step") == "stuck"),
                "used": report.plan_usage(run)["used"],
                "waits": waits,
                "limit_stops": sum(
                    1 for line in run if line.get("step") == "stop" and line.get("result") == "usage-limit"
                ),
            }
        )
    return records


def _waits(run: list[dict[str, Any]], ended: float) -> list[tuple[float, float]]:
    """Each wait for a usage limit to reset, from the first pause line that names the reset to the reset, or
    to the run's last line when the run ended first. Parallel tickets wait for the same reset once.
    """
    first: dict[str, float] = {}
    for line in run:
        if line.get("result") != "usage-pause":
            continue
        match = RESETS.search(str(line.get("detail") or ""))
        if match:
            first.setdefault(match[1], _time(line))
    waits = []
    for resets, since in first.items():
        try:
            until = datetime.fromisoformat(resets).timestamp()
        except ValueError:
            continue
        waits.append((since, max(since, min(until, ended))))
    return waits


def _overlap(wait: tuple[float, float], start: float | None, end: float) -> float:
    return max(0.0, min(wait[1], end) - max(wait[0], start or end))


def period(plan: str | None, records: list[dict[str, Any]]) -> dict[str, Any]:
    """What one plan delivered: the work landed, its quality, its time, and its share of each window."""
    landed = [item for record in records for item in record["landed"]]
    metered = [record for record in records if record["used"]]
    metered_tickets = sum(len(record["landed"]) for record in metered)
    minutes = [item["active_minutes"] for item in landed if "active_minutes" in item]
    waits = [wait for record in records for wait in record["waits"]]
    multiple = PLANS[plan]["multiple"] if plan in PLANS else None
    shares = {window: _share(metered, window) for window in WINDOWS}
    five = shares["five_hour"]["per_ticket"]
    return {
        "plan": plan,
        "name": PLANS[plan]["name"] if plan in PLANS else ("Unclear" if plan == "ambiguous" else "Not set"),
        "runs": len(records),
        "from": _iso(min(record["started"] for record in records)) if records else None,
        "to": _iso(max(record["ended"] for record in records)) if records else None,
        "landed": len(landed),
        "first_pass_rate": sum(item["first_pass"] for item in landed) / len(landed) if landed else None,
        "gate_failures_per_landed": sum(item["gate_failures"] for item in landed) / len(landed)
        if landed
        else None,
        "stuck": sum(record["stuck"] for record in records),
        "median_minutes": statistics.median(minutes) if minutes else None,
        "metered_tickets": metered_tickets,
        "five_hour": shares["five_hour"],
        "seven_day": shares["seven_day"],
        "pro_windows_per_ticket": five / 100 * multiple if five is not None and multiple else None,
        "waits": len(waits),
        "waited_hours": sum(until - since for since, until in waits) / 3600,
        "limit_stops": sum(record["limit_stops"] for record in records),
        "preliminary": metered_tickets < MIN_TICKETS,
    }


def _share(records: list[dict[str, Any]], window: str) -> dict[str, Any]:
    """A window's share per landed ticket, in percent: the runs' total over their tickets, with the lowest and
    the highest run. Each record may carry a `factor` that scales its share to another plan's window.
    """
    used = landed = 0.0
    each = []
    for record in records:
        if window not in record["used"]:
            continue
        share = record["used"][window] * record.get("factor", 1.0)
        used += share
        landed += len(record["landed"])
        if record["landed"]:
            each.append(share / len(record["landed"]))
    return {
        "per_ticket": used / landed if landed else None,
        "low": min(each) if each else None,
        "high": max(each) if each else None,
    }


# --- The estimate, the backlog, and the verdict ---


def current_plan(spans: tuple[PlanSpan, ...], now: float) -> str | None:
    started = [span.plan for span in spans if span.since.timestamp() <= now]
    return started[-1] if started else None


def estimate(records: list[dict[str, Any]], plan: str | None) -> dict[str, Any] | None:
    """The share of each window one ticket needs on the plan. The plan's own runs give it once they landed
    enough tickets under a meter reading; until then every attributed run counts, scaled by the multiples.
    """
    metered = [record for record in records if record["used"] and record["landed"]]
    own = [record for record in metered if record["plan"] == plan]
    scaled = False
    if sum(len(record["landed"]) for record in own) >= MIN_TICKETS or plan not in PLANS:
        basis = own
    else:
        basis = [
            record | {"factor": PLANS[record["plan"]]["multiple"] / PLANS[plan]["multiple"]}
            for record in metered
            if record["plan"] in PLANS
        ]
        scaled = any(record["plan"] != plan for record in basis)
    tickets = sum(len(record["landed"]) for record in basis)
    if not tickets:
        return None
    minutes = [
        item["active_minutes"] for record in basis for item in record["landed"] if "active_minutes" in item
    ]
    return {
        "scaled": scaled,
        "plans": sorted({str(record["plan"]) for record in basis}),
        "tickets": tickets,
        "runs": len(basis),
        "from": _iso(min(record["started"] for record in basis)),
        "to": _iso(max(record["ended"] for record in basis)),
        "five_hour": _share(basis, "five_hour"),
        "seven_day": _share(basis, "seven_day"),
        "median_minutes": statistics.median(minutes) if minutes else None,
        "confidence": "high"
        if tickets >= CONFIDENT_TICKETS
        else "medium"
        if tickets >= MIN_TICKETS
        else "low",
    }


def backlog_view(
    snapshot: dict[str, Any] | None, landed: set[str], landed_status: str, each: dict[str, Any] | None
) -> dict[str, Any] | None:
    """Each open Epic with its tickets left, how many of them can start now, and what they need of the plan.
    A ticket is left when Jira has it open, not in the landed status, and no run on this host landed it.
    """
    if snapshot is None:
        return None
    left: set[str] = set()
    for epic in snapshot["epics"]:
        for ticket in epic["tickets"]:
            if not ticket["done"] and ticket["status"] != landed_status and ticket["key"] not in landed:
                left.add(ticket["key"])
    epics, unsplit = [], []
    for epic in snapshot["epics"]:
        if not epic["tickets"]:
            unsplit.append({"key": epic["key"], "summary": epic["summary"]})
            continue
        mine = [ticket for ticket in epic["tickets"] if ticket["key"] in left]
        ready = [
            ticket
            for ticket in mine
            if not any(
                b["key"] in left or (not b["done"] and b["key"] not in landed) for b in ticket["blockers"]
            )
        ]
        epics.append(
            {
                "key": epic["key"],
                "summary": epic["summary"],
                "total": len(epic["tickets"]),
                "left": len(mine),
                "ready": len(ready),
                "need": _need(len(mine), each),
            }
        )
    return {
        "epics": epics,
        "unsplit": unsplit,
        "left": len(left),
        "need": _need(len(left), each),
    }


def _need(tickets: int, each: dict[str, Any] | None) -> dict[str, Any]:
    """The share of each window the tickets need, in percent of one window, with its range."""
    if each is None:
        return {}
    return {
        window: {key: tickets * value for key, value in each[window].items() if value is not None}
        for window in WINDOWS
        if each[window]["per_ticket"] is not None
    }


def capacity(
    each: dict[str, Any] | None, plan: str | None, parallel: int, meter: dict[str, Any], left: int | None
) -> dict[str, Any] | None:
    """What the plan allows against what the loop can do. In a 5-hour window the loop lands as many tickets
    as its time allows, unless the plan's share runs out first: then the plan is the limit.
    """
    if each is None or each["five_hour"]["per_ticket"] in (None, 0):
        return None
    five = each["five_hour"]["per_ticket"]
    week = each["seven_day"]["per_ticket"]
    by_time = WINDOW_MINUTES / each["median_minutes"] * parallel if each["median_minutes"] else None
    by_usage = 100 / five
    weekly = meter.get("seven_day")
    week_left = (
        max(0.0, 100 - weekly["utilization"] * 100) / week
        if week and weekly and not weekly.get("past")
        else None
    )
    upgrades = []
    for key, other in PLANS.items():
        if plan in PLANS and other["multiple"] > PLANS[plan]["multiple"]:
            factor = other["multiple"] / PLANS[plan]["multiple"]
            effective = min(by_time, by_usage) if by_time else by_usage
            more = min(by_time, by_usage * factor) if by_time else by_usage * factor
            upgrades.append(
                {
                    "plan": key,
                    "name": other["name"],
                    "price_more": other["price"] - PLANS[plan]["price"],
                    "five_hour_tickets": by_usage * factor,
                    "week_tickets": 100 / week * factor if week else None,
                    "gain": more / effective if effective else None,
                }
            )
    return {
        "five_hour_by_usage": by_usage,
        "five_hour_by_time": by_time,
        "plan_limits": by_time is not None and by_usage < by_time,
        "week_tickets": 100 / week if week else None,
        "week_left_tickets": week_left,
        "weeks_for_backlog": left * week / 100 if week and left is not None else None,
        "upgrades": upgrades,
    }


def verdict(
    plan: str | None, own: dict[str, Any] | None, each: dict[str, Any] | None, room: dict[str, Any] | None
) -> dict[str, Any]:
    """Whether the plan limits the work, in plain sentences, and what would settle it when the data cannot."""
    if plan is None:
        return {
            "state": "unknown",
            "says": "Set plans under [watch] in loop.toml to tell the runs of each plan apart.",
            "collect": [],
        }
    name = PLANS[plan]["name"]
    tickets = own["metered_tickets"] if own else 0
    collect = []
    if tickets < MIN_TICKETS:
        collect.append(
            f"Land {MIN_TICKETS - tickets} more tickets on {name} with a meter reading ({tickets} so far)."
        )
    if own and own["waits"] == 0:
        collect.append(f"Note whether {name} ever makes the loop wait for a usage limit. It has not yet.")
    collect.append(f"Watch the weekly meter across one full week on {name}, from one reset to the next.")
    if each is None or room is None:
        return {
            "state": "insufficient",
            "says": "No run has landed a ticket under a meter reading yet.",
            "collect": collect,
        }
    waits = own["waits"] if own else 0
    if room["plan_limits"]:
        says = (
            f"{name} runs out before the loop does. A 5-hour window fits about "
            f"{room['five_hour_by_usage']:.1f} tickets by usage, and the loop lands about "
            f"{room['five_hour_by_time']:.1f} in 5 hours."
        )
        state = "limits"
    elif waits:
        says = (
            f"{name} made the loop wait for a usage limit {waits} times, though a 5-hour window fits more "
            "tickets than the loop lands in it. Your own sessions share the meter."
        )
        state = "limits"
    else:
        says = f"{name} is not the limit. A 5-hour window fits more tickets than the loop lands in it."
        state = "fits"
    if room["weeks_for_backlog"] is not None and room["weeks_for_backlog"] > 1:
        says += f" The open tickets need about {room['weeks_for_backlog']:.1f} weeks of the weekly allowance."
    if tickets < MIN_TICKETS:
        state = "preliminary"
        says = f"Preliminary. {says}"
    return {"state": state, "says": says, "collect": collect if state != "fits" else []}


def view(
    state_dir: Path,
    backlog: Backlog | None,
    spans: tuple[PlanSpan, ...],
    landed_status: str,
    parallel: int,
    meter: dict[str, Any],
) -> dict[str, Any]:
    records = run_records(state_dir, spans)
    plan = current_plan(spans, time.time())
    order = [*PLANS, "ambiguous", None]
    periods = [
        period(key, [record for record in records if record["plan"] == key])
        for key in order
        if any(record["plan"] == key for record in records)
    ]
    own = next((item for item in periods if item["plan"] == plan), None)
    each = estimate(records, plan)
    landed = {item["key"] for record in records for item in record["landed"]}
    work = backlog_view(backlog.snapshot if backlog else None, landed, landed_status, each)
    room = capacity(each, plan, parallel, meter, work["left"] if work else None)
    return {
        "plan": {"key": plan, **PLANS[plan]} if plan in PLANS else None,
        "periods": periods,
        "estimate": each,
        "backlog": work,
        "sync": backlog.status() if backlog else None,
        "capacity": room,
        "verdict": verdict(plan, own, each, room),
        "landed_status": landed_status,
        "min_tickets": MIN_TICKETS,
    }


class Forecaster:
    """The forecast of one project, the one whose `loop.toml` started `loop watch`."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.backlog = Backlog(config.state_dir, self._jira, config.backlog_minutes)

    def _jira(self) -> Search:
        # Read for each sync, so a new `loop secrets` takes effect without a restart.
        secrets = read_secrets(self.config.state_dir)
        if not secrets.get("JIRA_EMAIL") or not secrets.get("JIRA_API_TOKEN"):
            raise BacklogError("This host has no Jira secret in its secrets file. Run `loop secrets`.")
        return Jira(self.config.tracker_url, secrets["JIRA_EMAIL"], secrets["JIRA_API_TOKEN"])

    def start(self) -> None:
        self.backlog.start()

    def view(self) -> dict[str, Any]:
        config = self.config
        found = view(
            config.state_dir,
            self.backlog,
            config.plans,
            config.landed_status,
            config.parallel,
            plan_meter(config.state_dir),
        )
        return {"project": config.name, **found}

    def refresh(self) -> bool:
        return self.backlog.refresh()


def _time(line: dict[str, Any]) -> float:
    return datetime.fromisoformat(str(line.get("time"))).timestamp()


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, UTC).isoformat(timespec="seconds")
