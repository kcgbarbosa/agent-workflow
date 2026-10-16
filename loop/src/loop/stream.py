"""Reads the stream-json output of a `claude -p` run: its result, its cost, and its plan meter."""

from __future__ import annotations

import json
from typing import Any

# The usage fields the log keeps per model. A `costBasis` of "unknown" marks a cost the CLI guessed.
MODEL_USAGE = (
    "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "costUSD", "costBasis",
)  # fmt: skip
# The tokens of one assistant message that make up the context it sent.
CONTEXT_TOKENS = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")


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


def agent_plan(events: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """The plan meter over one run, from its `rate_limit_event` lines: the first and the last utilization
    of each window, and when the window resets (loop.md rule 11). A window the run has no value for is left
    out. When a window resets during the run, its entry starts again in the new window.
    """
    plan: dict[str, dict[str, Any]] = {}
    for event in events:
        info = event.get("rate_limit_info") if event.get("type") == "rate_limit_event" else None
        if not isinstance(info, dict):
            continue
        windows = info.get("unifiedWindows")
        if not isinstance(windows, dict):
            # A CLI that gives no windows reports the one window that is closest to its limit.
            windows = {info.get("rateLimitType"): info}
        for window, value in windows.items():
            if not isinstance(window, str) or not isinstance(value, dict):
                continue
            utilization, resets_at = value.get("utilization"), value.get("resetsAt")
            if not isinstance(utilization, int | float) or isinstance(utilization, bool):
                continue
            entry = plan.get(window)
            if entry is None or entry["resets_at"] != resets_at:
                entry = plan[window] = {"start": utilization}
            entry["end"], entry["resets_at"] = utilization, resets_at
    return plan


def peak_context(events: list[dict[str, Any]]) -> int:
    """The largest context the session sent in one turn: the input, cache read, and cache write tokens of
    its biggest assistant message. A subagent's messages carry a parent tool call, and they are not counted.
    """
    peak = 0
    seen: set[str] = set()
    for event in events:
        message = event.get("message") if event.get("type") == "assistant" else None
        if not isinstance(message, dict) or event.get("parent_tool_use_id"):
            continue
        # The stream repeats a message for each of its content blocks.
        if message.get("id") in seen:
            continue
        seen.add(str(message.get("id")))
        usage = message.get("usage")
        if isinstance(usage, dict):
            peak = max(peak, sum(int(usage.get(name) or 0) for name in CONTEXT_TOKENS))
    return peak


def agent_usage(result: dict[str, Any], events: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """The cost, turns, duration, subagents, and per-model usage of one result event, with the peak context
    of the run's events (loop.md rule 11).
    """
    models = result.get("modelUsage")
    return {
        "peak_context": peak_context(events or []),
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
