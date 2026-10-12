"""`loop report`: what one run cost, broken down, and how it compares with the run before it.

A run starts at a start line of its Epic and ends before the next one (loop.md rule 11). The breakdown reads
only the lines of `decisions.jsonl`, so it works for any run whose log is on this host.
"""

from __future__ import annotations

import re
from typing import Any

HAIKU = "claude-haiku-5-5"
# Haiku 5.5 bills a prompt of up to 100K tokens at these rates, in dollars per million tokens, and a longer
# one at five times them. The 1-hour cache write, the dearer one, stands for every write, so a session that
# stayed under 100K never shows a cost above these rates.
HAIKU_SHORT_RATES = {
    "inputTokens": 0.10,
    "outputTokens": 0.50,
    "cacheReadInputTokens": 0.01,
    "cacheCreationInputTokens": 0.20,
}
TOKEN_FIELDS = tuple(HAIKU_SHORT_RATES)
FINDINGS = re.compile(r"(\d+) (?:findings|faults)")
ROLES = {"head": "Head agent and its subagents", "review": "Reviews", "pr": "PR body"}
# The dollar figures are what the API would bill. KC pays a plan, and its meter is the cost that counts.
LIST_PRICE = "list price (API)"
WINDOWS = {"five_hour": "Five-hour", "seven_day": "Seven-day"}


def split_runs(epic: str, lines: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """The lines of each run of the Epic, the oldest first. Lines before the first start belong to no run."""
    starts = [i for i, line in enumerate(lines) if line.get("ticket") == epic and line.get("step") == "start"]
    ends = [*starts[1:], len(lines)]
    return [lines[start:end] for start, end in zip(starts, ends, strict=True)]


def role(name: str) -> str:
    """The role of an agent session, from the name the script logs it under."""
    if name.endswith(("-review", "-ui")):
        return "review"
    if name.endswith("-pr"):
        return "pr"
    return "head"


def sessions(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The last agent line of each session. A resumed session reports the cost of the whole session so far."""
    last: dict[str, dict[str, Any]] = {}
    for number, line in enumerate(lines):
        usage = line.get("usage")
        if isinstance(usage, dict) and isinstance(usage.get("total_cost_usd"), int | float):
            last[line.get("session") or f"line-{number}"] = line
    return list(last.values())


def haiku_over_cap(models: dict[str, Any]) -> float:
    """The least that a session paid above the Haiku 5.5 short-prompt rates, so 0 when it stayed under."""
    over = 0.0
    for model, fields in models.items():
        if (
            not model.startswith(HAIKU)
            or not isinstance(fields, dict)
            or fields.get("costBasis") == "unknown"
        ):
            continue
        cost = fields.get("costUSD")
        if not isinstance(cost, int | float):
            continue
        short = sum(float(fields.get(name) or 0) * rate for name, rate in HAIKU_SHORT_RATES.items()) / 1e6
        # A cent's hundredth, or 1% of the cost, absorbs the rounding of the CLI's cost.
        if cost - short > max(0.0001, short * 0.01):
            over += cost - short
    return over


def plan_usage(run: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """The plan points a run used, and the meter at its last agent line (loop.md rule 11).

    The meter is the account's, so parallel sessions, and KC's own, move it together. For each window, which
    one reset time names, the run used the highest end less the lowest start of its agent lines. One point
    is 1% of the window.
    """
    spans: dict[tuple[str, Any], tuple[float, float]] = {}
    now: dict[str, dict[str, Any]] = {}
    for line in run:
        plan = line.get("plan")
        for window, value in plan.items() if isinstance(plan, dict) else ():
            if not isinstance(value, dict):
                continue
            start, end = value.get("start"), value.get("end")
            if not isinstance(start, int | float) or not isinstance(end, int | float):
                continue
            span = (window, value.get("resets_at"))
            low, high = spans.get(span, (start, end))
            spans[span] = (min(low, start), max(high, end))
            now[window] = {"utilization": end, "resets_at": value.get("resets_at")}
    used: dict[str, float] = {}
    for (window, _), (low, high) in spans.items():
        used[window] = round(used.get(window, 0.0) + (high - low) * 100, 1)
    return {"used": used, "now": now}


def head_drivers(run: list[dict[str, Any]]) -> dict[str, Any]:
    """What drives the head agent's cost, per ticket it worked on: its turns, the peak context of its
    sessions, and its hand-offs to each subagent tier. Each turn sends the whole context again.
    """
    tickets: set[str] = set()
    turns = 0.0
    handoffs: dict[str, int] = {}
    for line in sessions(run):
        name = str(line.get("ticket", ""))
        if role(name) != "head" or name == run[0].get("ticket"):
            continue
        tickets.add(name)
        turns += line["usage"].get("num_turns") or 0
        for kind, count in (line["usage"].get("subagents") or {}).items():
            handoffs[kind] = handoffs.get(kind, 0) + int(count)
    # Each agent line gives the peak of its own run, so a ticket's peak is the largest of its lines.
    peaks: dict[str, int] = {}
    for line in run:
        peak = (line.get("usage") or {}).get("peak_context") if line.get("step") == "agent" else None
        name = str(line.get("ticket", ""))
        if name in tickets and isinstance(peak, int):
            peaks[name] = max(peaks.get(name, 0), peak)
    count = len(tickets)
    return {
        "tickets": count,
        "turns_per_ticket": round(turns / count, 1) if count else None,
        "peak_context_per_ticket": round(sum(peaks.values()) / len(peaks)) if peaks else None,
        "handoffs_per_ticket": {kind: round(n / count, 1) for kind, n in handoffs.items()} if count else {},
    }


def breakdown(epic: str, run: list[dict[str, Any]]) -> dict[str, Any]:
    """The cost of one run by role, model, and subagent, with what the run delivered for it."""
    roles = dict.fromkeys(ROLES, 0.0)
    models: dict[str, dict[str, float]] = {}
    subagents: dict[str, int] = {}
    cost = turns = agent_ms = over = 0.0
    over_sessions = 0
    for line in sessions(run):
        usage = line["usage"]
        cost += usage["total_cost_usd"]
        turns += usage.get("num_turns") or 0
        agent_ms += usage.get("duration_ms") or 0
        roles[role(str(line.get("ticket", "")))] += usage["total_cost_usd"]
        for kind, count in (usage.get("subagents") or {}).items():
            subagents[kind] = subagents.get(kind, 0) + int(count)
        for model, fields in (usage.get("models") or {}).items():
            total = models.setdefault(model, dict.fromkeys(("costUSD", *TOKEN_FIELDS), 0.0))
            for name in total:
                total[name] += float(fields.get(name) or 0)
        session_over = haiku_over_cap(usage.get("models") or {})
        over += session_over
        over_sessions += session_over > 0
    landed = sum(1 for line in run if line.get("step") == "land" and line.get("result") == "landed")
    plan = plan_usage(run)
    findings = 0
    for line in run:
        if line.get("step") in ("code-review", "ui-gate") and (
            match := FINDINGS.match(str(line.get("detail")))
        ):
            findings += int(match[1])
    return {
        "epic": epic,
        "started": run[0].get("time") if run else None,
        "ended": run[-1].get("time") if run else None,
        "setup": (run[0].get("setup") if run else None) or {},
        "landed": landed,
        "stuck": sum(1 for line in run if line.get("step") == "stuck"),
        "cost": cost,
        "cost_per_landed": cost / landed if landed else None,
        "plan_used": plan["used"],
        "plan_per_landed": {window: round(points / landed, 1) for window, points in plan["used"].items()}
        if landed
        else {},
        "meter": plan["now"],
        "head": head_drivers(run),
        "turns": int(turns),
        "agent_minutes": agent_ms / 60000,
        "findings": findings,
        "haiku_over_cap": over,
        "haiku_over_cap_sessions": over_sessions,
        "roles": roles,
        "models": models,
        "subagents": subagents,
    }


def pick(
    runs: list[tuple[str, list[dict[str, Any]]]], epic: str, against: str | None = None
) -> tuple[tuple[str, list[dict[str, Any]]] | None, tuple[str, list[dict[str, Any]]] | None]:
    """The Epic's latest run, and the run to compare it with: the latest run of `against`, or else the
    latest run on this host that started before it and has an agent line. `runs` is sorted oldest first.
    """
    current = next((item for item in reversed(runs) if item[0] == epic), None)
    if current is None:
        return None, None
    if against:
        return current, next(
            (item for item in reversed(runs) if item[0] == against and item != current), None
        )
    started = str(current[1][0].get("time"))
    earlier = (item for item in reversed(runs) if str(item[1][0].get("time")) < started and sessions(item[1]))
    return current, next(earlier, None)


def _row(section: str, label: str, kind: str, previous: Any, current: Any) -> dict[str, Any]:
    change: int | str | None = None
    if kind == "text":
        change = "changed" if previous is not None and previous != current else None
    elif isinstance(previous, int | float) and isinstance(current, int | float):
        change = round((current - previous) / previous * 100) if previous else "new" if current else None
    return {
        "section": section,
        "label": label,
        "kind": kind,
        "previous": previous,
        "current": current,
        "change": change,
    }


def compare(current: dict[str, Any], previous: dict[str, Any] | None) -> list[dict[str, Any]]:
    """One row per figure, with the previous run's value and the change in percent."""
    old = previous or {}
    rows = []
    before_used, after_used = old.get("plan_used") or {}, current["plan_used"]
    before_each, after_each = old.get("plan_per_landed") or {}, current["plan_per_landed"]
    for window, name in WINDOWS.items():
        if window in before_used or window in after_used:
            rows += [
                _row(
                    "Plan usage",
                    f"{name} points used",
                    "points",
                    before_used.get(window),
                    after_used.get(window),
                ),
                _row(
                    "Plan usage",
                    f"{name} points per landed ticket",
                    "points",
                    before_each.get(window),
                    after_each.get(window),
                ),
            ]
    rows += [
        _row("Run", "Tickets landed", "count", old.get("landed"), current["landed"]),
        _row("Run", "Tickets stuck", "count", old.get("stuck"), current["stuck"]),
        _row("Run", f"Cost, {LIST_PRICE}", "money", old.get("cost"), current["cost"]),
        _row(
            "Run",
            f"Cost per landed ticket, {LIST_PRICE}",
            "money",
            old.get("cost_per_landed"),
            current["cost_per_landed"],
        ),
        _row("Run", "Agent minutes", "minutes", old.get("agent_minutes"), current["agent_minutes"]),
        _row("Run", "Agent turns", "count", old.get("turns"), current["turns"]),
        _row("Run", "Review findings", "count", old.get("findings"), current["findings"]),
        _row(
            "Run",
            f"Haiku cost above the 100K rate, {LIST_PRICE}",
            "money",
            old.get("haiku_over_cap"),
            current["haiku_over_cap"],
        ),
    ]
    before_head, after_head = old.get("head") or {}, current["head"]
    rows += [
        _row(
            "Head agent",
            "Turns per ticket",
            "count",
            before_head.get("turns_per_ticket"),
            after_head["turns_per_ticket"],
        ),
        _row(
            "Head agent",
            "Peak context per ticket",
            "tokens",
            before_head.get("peak_context_per_ticket"),
            after_head["peak_context_per_ticket"],
        ),
    ]
    before_handoffs, after_handoffs = (
        before_head.get("handoffs_per_ticket") or {},
        after_head["handoffs_per_ticket"],
    )
    for tier in sorted({*before_handoffs, *after_handoffs}):
        rows.append(
            _row(
                "Head agent",
                f"Hand-offs per ticket: {tier}",
                "count",
                before_handoffs.get(tier, 0 if previous else None),
                after_handoffs.get(tier, 0),
            )
        )
    for key, label in ROLES.items():
        rows.append(
            _row(
                f"Cost by role, {LIST_PRICE}",
                label,
                "money",
                (old.get("roles") or {}).get(key),
                current["roles"][key],
            )
        )
    for section, field, kind in (
        (f"Cost by model, {LIST_PRICE}", "models", "money"),
        ("Subagent calls", "subagents", "count"),
    ):
        before, after = old.get(field) or {}, current[field]
        for name in sorted({*before, *after}):
            rows.append(_row(section, name, kind, _figure(before.get(name)), _figure(after.get(name)) or 0))
    before_setup, after_setup = _flat(old.get("setup") or {}), _flat(current["setup"])
    for name in sorted({*before_setup, *after_setup}):
        rows.append(_row("Setup", name, "text", before_setup.get(name), after_setup.get(name)))
    return rows


def _figure(item: Any) -> Any:
    """A model's cost, or a subagent's count."""
    return item["costUSD"] if isinstance(item, dict) else item


def _flat(setup: dict[str, Any]) -> dict[str, str]:
    flat = {}
    for key, value in setup.items():
        if isinstance(value, dict):
            flat.update({f"{key} {name}": str(item) for name, item in value.items()})
        else:
            flat[key] = str(value)
    return flat


def text(current: dict[str, Any], previous: dict[str, Any] | None, rows: list[dict[str, Any]]) -> str:
    """The comparison as a table for a terminal."""
    now = f"{current['epic']} {_day(current['started'])}"
    then = f"{previous['epic']} {_day(previous['started'])}" if previous else "no earlier run"
    lines = [f"The run of {now}, against {then}."]
    widths = (50, 16, 16)
    section = ""
    for row in rows:
        if row["section"] != section:
            section = row["section"]
            lines += ["", f"{section:<{widths[0]}}{'Before':>{widths[1]}}{'This run':>{widths[2]}}  Change"]
        change = row["change"]
        shown = f"{change:+d}%" if isinstance(change, int) else (change or "")
        before, after = _value(row["kind"], row["previous"]), _value(row["kind"], row["current"])
        lines.append(f"  {row['label']:<{widths[0] - 2}}{before:>{widths[1]}}{after:>{widths[2]}}  {shown}")
    return "\n".join(lines)


def _value(kind: str, value: Any) -> str:
    if value is None:
        return "-"
    if kind == "money":
        return f"${value:,.2f}"
    if kind == "minutes":
        return f"{value:,.0f} min"
    if kind == "points":
        return f"{value:,.1f} pt"
    if kind == "tokens":
        return f"{value:,.0f}"
    return str(value)


def _day(time: str | None) -> str:
    return (time or "")[:16].replace("T", " ")
