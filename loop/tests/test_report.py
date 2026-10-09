"""`loop report`: what a run cost by role, model, and subagent, against the run before it on this host."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from conftest import write_config

from loop import config
from loop.cli import claude_problem, main
from loop.report import breakdown, compare, haiku_over_cap, split_runs
from loop.watch import Watch, comparison

HAIKU = "claude-haiku-5-5"
SETUP_BEFORE = {
    "claude": "2.1.288",
    "tiers": {"scout": "claude-sonnet-5-5 low"},
    "review": "claude-sonnet-5-5 high",
}
SETUP_AFTER = {
    "claude": "2.1.295",
    "tiers": {"scout": "claude-haiku-5-5 low"},
    "review": "claude-opus-5-5 medium",
}


def line(epic: str, time: str, ticket: str, step: str, result: str, **extra: Any) -> dict[str, Any]:
    return {
        "time": time,
        "epic": epic,
        "ticket": ticket,
        "step": step,
        "result": result,
        "session": None,
    } | extra


def usage(cost: float, models: dict[str, Any], subagents: dict[str, int] | None = None) -> dict[str, Any]:
    return {
        "total_cost_usd": cost,
        "num_turns": 4,
        "duration_ms": 120_000,
        "subagents": subagents or {},
        "models": models,
    }


def haiku(tokens: int, cost: float) -> dict[str, Any]:
    tokens_by_kind = {
        "inputTokens": tokens,
        "outputTokens": 0,
        "cacheReadInputTokens": 0,
        "cacheCreationInputTokens": 0,
    }
    return tokens_by_kind | {"costUSD": cost, "costBasis": "list"}


def run_lines(
    epic: str, day: str, setup: dict[str, Any], cost: float, haiku_cost: float
) -> list[dict[str, Any]]:
    """A run that lands two tickets: a head session resumed once, a review, and the PR body."""
    t = f"2026-10-{day}T10:00:00+00:00"
    head = {"claude-opus-5-5": {"costUSD": cost - haiku_cost}, HAIKU: haiku(1_000_000, haiku_cost)}
    review = usage(1.0, {"claude-opus-5-5": {"costUSD": 1.0}})
    pr = usage(0.5, {"claude-opus-5-5": {"costUSD": 0.5}})
    return [
        line(epic, t, epic, "start", "ok", setup=setup),
        line(epic, t, "A-2", "start", "new"),
        line(epic, t, "A-2", "agent", "done", session="s1", usage=usage(cost / 2, head, {"scout": 1})),
        line(epic, t, "A-2-review", "agent", "done", session="r1", usage=review),
        line(epic, t, "A-2", "code-review", "findings", detail="2 findings"),
        line(epic, t, "A-2", "ui-gate", "fail", detail="1 faults"),
        # A resumed session reports the cost of the whole session so far, so only its last line counts.
        line(
            epic, t, "A-2", "agent", "done", session="s1", usage=usage(cost, head, {"scout": 3, "runner": 1})
        ),
        line(epic, t, "A-2", "land", "landed"),
        line(epic, t, "A-3", "land", "landed"),
        line(epic, t, "A-4", "stuck", "stuck"),
        line(epic, t, f"{epic}-pr", "agent", "done", session="p1", usage=pr),
    ]


def write_run(state: Path, epic: str, lines: list[dict[str, Any]]) -> None:
    log = state / epic / "decisions.jsonl"
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("a") as file:
        file.write("".join(json.dumps(item) + "\n" for item in lines))


def test_a_run_breaks_down_by_role_model_and_subagent() -> None:
    # 1M Haiku input tokens cost $0.10 at the short-prompt rate, so $0.10 stays under it.
    lines = run_lines("DEMO-1", "08", SETUP_AFTER, cost=4.0, haiku_cost=0.10)

    (run,) = split_runs("DEMO-1", lines)
    result = breakdown("DEMO-1", run)

    assert result["cost"] == pytest.approx(5.5)
    assert result["roles"] == pytest.approx({"head": 4.0, "review": 1.0, "pr": 0.5})
    assert result["models"][HAIKU]["costUSD"] == pytest.approx(0.10)
    assert result["models"]["claude-opus-5-5"]["costUSD"] == pytest.approx(3.9 + 1.0 + 0.5)
    assert result["subagents"] == {"scout": 3, "runner": 1}
    assert (result["landed"], result["stuck"], result["findings"]) == (2, 1, 3)
    assert result["cost_per_landed"] == pytest.approx(2.75)
    assert result["agent_minutes"] == pytest.approx(6)
    assert result["haiku_over_cap"] == 0 and result["setup"] == SETUP_AFTER


def test_haiku_cost_above_the_short_prompt_rate_shows_a_prompt_past_100k() -> None:
    assert haiku_over_cap({HAIKU: haiku(1_000_000, 0.10)}) == 0
    # A prompt past 100K bills its tokens at five times the rate.
    assert haiku_over_cap({HAIKU: haiku(1_000_000, 0.30)}) == pytest.approx(0.20)
    assert haiku_over_cap({HAIKU: {**haiku(1_000_000, 0.30), "costBasis": "unknown"}}) == 0
    assert haiku_over_cap({"claude-opus-5-5": {"inputTokens": 10, "costUSD": 9.0}}) == 0


def test_the_latest_run_compares_with_the_run_before_it_on_this_host(tmp_path: Path) -> None:
    write_run(tmp_path, "DEMO-1", run_lines("DEMO-1", "07", SETUP_BEFORE, cost=8.0, haiku_cost=0))
    write_run(tmp_path, "DEMO-2", run_lines("DEMO-2", "08", SETUP_AFTER, cost=4.0, haiku_cost=0.30))
    # A later run of DEMO-1 that stopped before any agent ran is no baseline, and not the run asked about.
    write_run(tmp_path, "DEMO-1", [line("DEMO-1", "2026-10-09T10:00:00+00:00", "DEMO-1", "start", "ok")])

    found = comparison(tmp_path, "DEMO-2")

    assert found is not None and found["previous"] is not None
    assert found["previous"]["epic"] == "DEMO-1" and found["current"]["epic"] == "DEMO-2"
    rows = {(row["section"], row["label"]): row for row in found["rows"]}
    cost = rows[("Run", "Cost")]
    assert (cost["previous"], cost["current"], cost["change"]) == (9.5, 5.5, -42)
    assert rows[("Run", "Haiku cost above the 100K rate")]["current"] == pytest.approx(0.20)
    assert (rows[("Cost by model", HAIKU)]["previous"], rows[("Cost by model", HAIKU)]["change"]) == (
        0,
        "new",
    )
    assert rows[("Setup", "review")]["change"] == "changed"
    assert rows[("Setup", "tiers scout")]["current"] == "claude-haiku-5-5 low"
    assert comparison(tmp_path, "DEMO-2", against="DEMO-1") is not None


def test_a_first_run_has_nothing_to_compare_with() -> None:
    current = breakdown("DEMO-1", run_lines("DEMO-1", "08", SETUP_AFTER, cost=4.0, haiku_cost=0))

    rows = compare(current, None)

    assert all(row["previous"] is None and row["change"] is None for row in rows)


def test_loop_report_prints_the_comparison(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    write_config(tmp_path)
    settings = config.load(tmp_path, state_dir=tmp_path / "state")
    monkeypatch.setattr(config, "load", lambda repo: settings)
    write_run(settings.state_dir, "DEMO-1", run_lines("DEMO-1", "07", SETUP_BEFORE, cost=8.0, haiku_cost=0))
    write_run(settings.state_dir, "DEMO-2", run_lines("DEMO-2", "08", SETUP_AFTER, cost=4.0, haiku_cost=0))

    assert main(["report", "--repo", str(tmp_path)]) == 0
    table = capsys.readouterr().out
    assert "The run of DEMO-2 2026-10-08 10:00, against DEMO-1 2026-10-07 10:00." in table
    assert "$9.50" in table and "$5.50" in table and "-42%" in table

    assert main(["report", "DEMO-2", "--json", "--repo", str(tmp_path)]) == 0
    assert json.loads(capsys.readouterr().out)["current"]["landed"] == 2

    assert main(["report", "DEMO-9", "--repo", str(tmp_path)]) == 1
    assert "no run of DEMO-9" in capsys.readouterr().err


def test_the_watch_page_serves_the_report(tmp_path: Path) -> None:
    write_run(tmp_path, "DEMO-1", run_lines("DEMO-1", "07", SETUP_BEFORE, cost=8.0, haiku_cost=0))

    status, kind, body = Watch(tmp_path).handle("/api/report/DEMO-1")
    assert status == 200 and kind == "application/json"
    assert json.loads(body)["previous"] is None
    assert Watch(tmp_path).handle("/api/report/DEMO-9")[0] == 404


def test_the_loop_refuses_a_claude_that_does_not_know_the_tier_models() -> None:
    assert claude_problem("2.1.295") is None and claude_problem("2.2.0") is None
    problem = claude_problem("2.1.288")
    assert problem and "2.1.295 or later" in problem
    assert claude_problem("")
