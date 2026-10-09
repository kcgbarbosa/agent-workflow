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
    rows = [
        _row("Run", "Tickets landed", "count", old.get("landed"), current["landed"]),
        _row("Run", "Tickets stuck", "count", old.get("stuck"), current["stuck"]),
        _row("Run", "Cost", "money", old.get("cost"), current["cost"]),
        _row(
            "Run", "Cost per landed ticket", "money", old.get("cost_per_landed"), current["cost_per_landed"]
        ),
        _row("Run", "Agent minutes", "minutes", old.get("agent_minutes"), current["agent_minutes"]),
        _row("Run", "Agent turns", "count", old.get("turns"), current["turns"]),
        _row("Run", "Review findings", "count", old.get("findings"), current["findings"]),
        _row(
            "Run",
            "Haiku cost above the 100K rate",
            "money",
            old.get("haiku_over_cap"),
            current["haiku_over_cap"],
        ),
    ]
    for key, label in ROLES.items():
        rows.append(
            _row("Cost by role", label, "money", (old.get("roles") or {}).get(key), current["roles"][key])
        )
    for section, field, kind in (
        ("Cost by model", "models", "money"),
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
    widths = (34, 24, 24)
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
    return str(value)


def _day(time: str | None) -> str:
    return (time or "")[:16].replace("T", " ")
