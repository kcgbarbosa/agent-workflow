"""The capacity forecast on the Usage view of `loop watch`: the open work in Jira, what the current plan
fits, and what each Claude plan delivered.

It reports only. No run reads it, and it reads Jira through one search and never writes.
"""

from __future__ import annotations

import re
import statistics
import threading
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

from . import report
from .config import Config, PlanSpan, stored_secrets
from .jira import Jira
from .report import KEY, all_runs, is_gate, iso, landings, line_time, ticket_key

# Anthropic's published plans: the usage of each against Pro's, and the monthly price in US dollars, from
# https://claude.com/pricing. Anthropic states the multiple for the 5-hour window, and none for the week.
PLANS: dict[str, dict[str, Any]] = {
    "pro": {"name": "Pro", "multiple": 1, "price": 20},
    "max-5x": {"name": "Max 5x", "multiple": 5, "price": 100},
    "max-20x": {"name": "Max 20x", "multiple": 20, "price": 200},
}
RESETS = re.compile(r"resets at (\S+?)\.?$")
EPIC_FIELDS = ["summary", "status"]
TICKET_FIELDS = ["status", "parent"]
WINDOWS = ("five_hour", "seven_day")


class BacklogError(Exception):
    pass


class Search(Protocol):
    def search(self, jql: str, fields: list[str]) -> list[dict[str, Any]]: ...


# --- The open work in Jira ---


def jira_client(config: Config) -> Search:
    """The Jira client of the project. The secrets are read for each call, so a new `loop secrets` takes
    effect without a restart."""
    secrets = stored_secrets(config.state_dir)
    if not secrets.get("JIRA_EMAIL") or not secrets.get("JIRA_API_TOKEN"):
        raise BacklogError("This host has no Jira secret in its secrets file. Run `loop secrets`.")
    return Jira(config.tracker_url, secrets["JIRA_EMAIL"], secrets["JIRA_API_TOKEN"])


def open_epics(jira: Search, projects: list[str]) -> list[dict[str, Any]]:
    """The open Epics of the projects: key, title, and status."""
    if not projects:
        return []
    jql = (
        f"project in ({', '.join(projects)}) AND issuetype = Epic AND statusCategory != Done ORDER BY key ASC"
    )
    return [
        {
            "key": issue["key"],
            "summary": issue["fields"].get("summary", ""),
            "status": issue["fields"]["status"]["name"],
        }
        for issue in jira.search(jql, EPIC_FIELDS)
    ]


def fetch(jira: Search, projects: list[str]) -> list[dict[str, Any]]:
    """The open Epics of the projects, each with its tickets' keys and statuses. No ticket text, so the read
    can never stand in for a ticket's spec.
    """
    found = {epic["key"]: {**epic, "tickets": []} for epic in open_epics(jira, projects)}
    if not found:
        return []
    for issue in jira.search(f"parent in ({', '.join(found)}) ORDER BY key ASC", TICKET_FIELDS):
        fields = issue["fields"]
        parent = (fields.get("parent") or {}).get("key")
        if parent not in found:
            continue
        found[parent]["tickets"].append(
            {"key": issue["key"], "status": fields["status"]["name"], "done": _is_done(fields["status"])}
        )
    return list(found.values())


def _is_done(status: dict[str, Any]) -> bool:
    return bool(status.get("statusCategory", {}).get("key") == "done")


def project_keys(state_dir: Path) -> list[str]:
    """The Jira projects of the Epics that ran on this host."""
    homes = state_dir.iterdir() if state_dir.is_dir() else []
    return sorted({home.name.split("-")[0] for home in homes if KEY.fullmatch(home.name)})


class Backlog:
    """The open Epics with their tickets, read from Jira when the forecast is asked for, and kept for
    `minutes`, so a page that stays open reads Jira at most that often. A failed read is kept too."""

    def __init__(
        self,
        state_dir: Path,
        client: Callable[[], Search],
        minutes: int,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.state_dir = state_dir
        self.seconds = minutes * 60
        self._client = client
        self.clock = clock
        self._lock = threading.Lock()
        self._kept: tuple[float, dict[str, Any]] | None = None

    def read(self) -> dict[str, Any]:
        """`epics`, or None with the `error` that stopped the read, and the time of the read."""
        with self._lock:
            if self._kept and self.clock() - self._kept[0] < self.seconds:
                return self._kept[1]
            try:
                projects = project_keys(self.state_dir)
                if not projects:
                    raise BacklogError("No run on this host names a Jira project yet.")
                found: dict[str, Any] = {"epics": fetch(self._client(), projects), "error": None}
            except Exception as error:  # noqa: BLE001 - a failed read changes the forecast only.
                found = {"epics": None, "error": str(error)[:300]}
            self._kept = (self.clock(), {**found, "read": iso(time.time())})
            return self._kept[1]


def open_work(
    epics: list[dict[str, Any]], landed: set[str], landed_status: str, each: dict[str, Any] | None
) -> dict[str, Any]:
    """Each open Epic with its tickets left and the share of each window they need. A ticket is left when Jira
    has it open, not in the landed status, and no run on this host landed it. An Epic with no tickets yet has
    none left to count.
    """
    rows = []
    for epic in epics:
        left = sum(
            1
            for ticket in epic["tickets"]
            if not ticket["done"] and ticket["status"] != landed_status and ticket["key"] not in landed
        )
        tickets = left if epic["tickets"] else None
        rows.append(
            {"key": epic["key"], "summary": epic["summary"], "left": tickets, "need": _need(tickets, each)}
        )
    total = sum(row["left"] or 0 for row in rows)
    return {"epics": rows, "left": total, "need": _need(total, each)}


def _need(tickets: int | None, each: dict[str, Any] | None) -> dict[str, float]:
    """The share of each window the tickets need, in percent of one window."""
    if each is None or tickets is None:
        return {}
    return {window: tickets * each[window] for window in WINDOWS if each[window] is not None}


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
    """Each run on this host with its plan, its landed and stuck tickets, its fix rounds, its plan usage, and
    its usage-limit waits.
    """
    records = []
    for epic, run in all_runs(state_dir):
        started, ended = line_time(run[0]), line_time(run[-1])
        by_ticket: dict[str, list[dict[str, Any]]] = {}
        for line in run:
            key = ticket_key(line)
            if key != epic:
                by_ticket.setdefault(key, []).append(line)
        waits = _waits(run, ended)
        landed = landings(by_ticket)
        for item in landed:
            if item["minutes"] is not None:
                overlap = sum(_overlap(wait, item["start"], item["land"]) for wait in waits) / 60
                item["active_minutes"] = max(0.0, item["minutes"] - overlap)
        records.append(
            {
                "epic": epic,
                "started": started,
                "ended": ended,
                "plan": plan_of(spans, started, ended),
                "landed": landed,
                "stuck": {ticket_key(line) for line in run if line.get("step") == "stuck"},
                "fixes": _fixes(run),
                "used": report.plan_usage(run)["used"],
                "waits": waits,
            }
        )
    return records


# The rounds of fixing that a run's lines record, by what asked for the fix.
FIXES = ("ticket_gate", "merge_gate", "code_review", "ui_review")


def _fixes(run: list[dict[str, Any]]) -> dict[str, int]:
    """Each failed ticket gate and merge gate, each code review with findings, and each UI review with
    faults, of every ticket in the run, landed or not.
    """
    counts = dict.fromkeys(FIXES, 0)
    for line in run:
        result = line.get("result")
        if is_gate(line, "ticket") and result == "fail":
            counts["ticket_gate"] += 1
        elif is_gate(line, "merge") and result == "fail":
            counts["merge_gate"] += 1
        elif line.get("step") == "code-review" and result == "findings":
            counts["code_review"] += 1
        elif line.get("step") == "ui-gate" and result == "fail":
            counts["ui_review"] += 1
    return counts


def _waits(run: list[dict[str, Any]], ended: float) -> list[dict[str, Any]]:
    """Each wait for a usage limit to reset, from the first pause line that names the reset to the reset, or
    to the run's last line when the run ended first. Parallel tickets wait for the same reset once.
    """
    first: dict[str, float] = {}
    for line in run:
        if line.get("result") != "usage-pause":
            continue
        match = RESETS.search(str(line.get("detail") or ""))
        if match:
            first.setdefault(match[1], line_time(line))
    waits = []
    for resets, since in first.items():
        try:
            until = datetime.fromisoformat(resets).timestamp()
        except ValueError:
            continue
        waits.append({"resets": resets, "since": since, "until": max(since, min(until, ended))})
    return waits


def _overlap(wait: dict[str, Any], start: float | None, end: float) -> float:
    return float(max(0.0, min(wait["until"], end) - max(wait["since"], start or end)))


def period(plan: str | None, records: list[dict[str, Any]]) -> dict[str, Any]:
    """What one plan delivered: the work landed, its rework, and its time. A usage limit counts once however
    many runs waited for its reset, as when a run restarts and pauses again.
    """
    landed = [item for record in records for item in record["landed"]]
    minutes = [item["active_minutes"] for item in landed if "active_minutes" in item]
    waited: dict[str, float] = {}
    for record in records:
        for wait in record["waits"]:
            waited[wait["resets"]] = waited.get(wait["resets"], 0.0) + wait["until"] - wait["since"]
    fixes = sum(sum(record["fixes"].values()) for record in records)
    return {
        "plan": plan,
        "name": PLANS[plan]["name"] if plan in PLANS else ("Unclear" if plan == "ambiguous" else "Not set"),
        "runs": len(records),
        "from": iso(min(record["started"] for record in records)) if records else None,
        "to": iso(max(record["ended"] for record in records)) if records else None,
        "landed": len(landed),
        "first_pass_rate": sum(item["first_pass"] for item in landed) / len(landed) if landed else None,
        "fixes_per_landed": fixes / len(landed) if landed else None,
        "stuck": len(set().union(*(record["stuck"] for record in records))),
        "median_minutes": statistics.median(minutes) if minutes else None,
        "waits": len(waited),
        "waited_hours": sum(waited.values()) / 3600,
    }


# --- What the current plan fits ---


def current_plan(spans: tuple[PlanSpan, ...], now: float) -> str | None:
    started = [span.plan for span in spans if span.since.timestamp() <= now]
    return started[-1] if started else None


def per_ticket(records: list[dict[str, Any]], plan: str | None) -> dict[str, Any] | None:
    """The share of each window, in percent, that one ticket needed in the plan's own runs: their total over
    their landed tickets. A run that landed nothing counts toward the total, since its work went into tickets
    that landed later.
    """
    own = [record for record in records if record["plan"] == plan and record["used"]]
    tickets = sum(len(record["landed"]) for record in own)
    if not tickets:
        return None

    def share(window: str) -> float | None:
        used = [record["used"][window] for record in own if window in record["used"]]
        return sum(used) / tickets if used else None

    return {"tickets": tickets, "runs": len(own), **{window: share(window) for window in WINDOWS}}


def capacity(each: dict[str, Any] | None, plan: str | None, left: int | None) -> dict[str, Any] | None:
    """The tickets that fit in a 5-hour window and in a week, the weeks the open work needs, and the same for
    each bigger plan, scaled by its multiple."""
    if each is None:
        return None
    five, week = each["five_hour"], each["seven_day"]

    def fits(factor: float) -> dict[str, float | None]:
        return {
            "five_hour": 100 / five * factor if five else None,
            "week": 100 / week * factor if week else None,
            "weeks": left * week / 100 / factor if week and left is not None else None,
        }

    bigger = [
        {
            "name": other["name"],
            "price_more": other["price"] - PLANS[plan]["price"],
            **fits(other["multiple"] / PLANS[plan]["multiple"]),
        }
        for other in PLANS.values()
        if plan in PLANS and other["multiple"] > PLANS[plan]["multiple"]
    ]
    return {"tickets": each["tickets"], "runs": each["runs"], **fits(1), "bigger": bigger}


def view(
    state_dir: Path, backlog: Backlog | None, spans: tuple[PlanSpan, ...], landed_status: str
) -> dict[str, Any]:
    records = run_records(state_dir, spans)
    plan = current_plan(spans, time.time())
    order = [*PLANS, "ambiguous", None]
    periods = [
        period(key, [record for record in records if record["plan"] == key])
        for key in order
        if any(record["plan"] == key for record in records)
    ]
    each = per_ticket(records, plan)
    landed = {item["key"] for record in records for item in record["landed"]}
    jira = backlog.read() if backlog else None
    work = (
        open_work(jira["epics"], landed, landed_status, each) if jira and jira["epics"] is not None else None
    )
    return {
        "plan": {"key": plan, **PLANS[plan]} if plan in PLANS else None,
        "jira": {"read": jira["read"], "error": jira["error"]} if jira else None,
        "open": work,
        "capacity": capacity(each, plan, work["left"] if work else None),
        "periods": periods,
        "landed_status": landed_status,
    }


class Forecaster:
    """The forecast of one project, the one whose `loop.toml` started `loop watch`."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.backlog = Backlog(config.state_dir, lambda: jira_client(config), config.backlog_minutes)

    def view(self) -> dict[str, Any]:
        config = self.config
        found = view(config.state_dir, self.backlog, config.plans, config.landed_status)
        return {"project": config.name, **found}
