"""The capacity forecast: the open work in Jira, what the current plan fits, and each plan's runs side by
side. It reads Jira only when asked, keeps the read a few minutes, and never writes to Jira.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fake_jira import FakeJira

from loop import config as config_file
from loop.config import ConfigError, PlanSpan
from loop.forecast import Forecaster, fetch, period, plan_of, run_records
from loop.jira import Jira
from loop.watch import Watch

LOOP = Path(__file__).resolve().parents[1]
SPANS = (
    PlanSpan("pro", datetime(2026, 10, 1, tzinfo=UTC), False),
    PlanSpan("max-5x", datetime(2026, 10, 14, 16, 30, tzinfo=UTC), True),
)


def write_lines(path: Path, lines: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(line) + "\n" for line in lines))


def line(epic: str, ticket: str, step: str, result: str, at: str, **extra: Any) -> dict[str, Any]:
    base = {"time": at, "epic": epic, "ticket": ticket, "step": step, "result": result, "detail": ""}
    return base | extra


def meter(five: tuple[float, float], week: tuple[float, float]) -> dict[str, Any]:
    return {
        "five_hour": {"start": five[0], "end": five[1], "resets_at": 1},
        "seven_day": {"start": week[0], "end": week[1], "resets_at": 2},
    }


def runs(tmp_path: Path) -> Path:
    """A Pro run that landed two tickets in 60% of a 5-hour window and waited 30 minutes for a usage limit,
    and a Max 5x run that landed one ticket in 10%.
    """
    write_lines(
        tmp_path / "DEMO-1" / "decisions.jsonl",
        [
            line("DEMO-1", "DEMO-1", "start", "ok", "2026-10-12T10:00:00+00:00"),
            line("DEMO-1", "DEMO-2", "start", "new", "2026-10-12T10:00:00+00:00"),
            line("DEMO-1", "DEMO-2", "ticket-gate", "pass", "2026-10-12T10:10:00+00:00"),
            line(
                "DEMO-1",
                "DEMO-2",
                "agent",
                "done",
                "2026-10-12T10:10:00+00:00",
                plan=meter((0, 0.3), (0.1, 0.12)),
            ),
            line("DEMO-1", "DEMO-2", "land", "landed", "2026-10-12T10:20:00+00:00"),
            line("DEMO-1", "DEMO-3", "start", "new", "2026-10-12T10:20:00+00:00"),
            line(
                "DEMO-1",
                "DEMO-3",
                "agent",
                "usage-pause",
                "2026-10-12T10:30:00+00:00",
                detail="The usage limit resets at 2026-10-12T11:00:00+00:00.",
            ),
            line("DEMO-1", "DEMO-3", "ticket-gate", "fail", "2026-10-12T11:10:00+00:00"),
            line("DEMO-1", "DEMO-3", "ticket-gate", "pass", "2026-10-12T11:20:00+00:00"),
            line(
                "DEMO-1",
                "DEMO-3",
                "agent",
                "done",
                "2026-10-12T11:20:00+00:00",
                plan=meter((0.3, 0.6), (0.12, 0.14)),
            ),
            line("DEMO-1", "DEMO-3", "land", "landed", "2026-10-12T11:30:00+00:00"),
        ],
    )
    write_lines(
        tmp_path / "DEMO-5" / "decisions.jsonl",
        [
            line("DEMO-5", "DEMO-5", "start", "ok", "2026-10-14T17:00:00+00:00"),
            line("DEMO-5", "DEMO-6", "start", "new", "2026-10-14T17:00:00+00:00"),
            line("DEMO-5", "DEMO-6", "ticket-gate", "pass", "2026-10-14T17:20:00+00:00"),
            line(
                "DEMO-5",
                "DEMO-6",
                "agent",
                "done",
                "2026-10-14T17:20:00+00:00",
                plan=meter((0, 0.1), (0, 0.01)),
            ),
            line("DEMO-5", "DEMO-6", "land", "landed", "2026-10-14T17:30:00+00:00"),
        ],
    )
    return tmp_path


CONFIG = """
name = "demo"
[tracker]
kind = "jira"
url = "{url}"
[gates]
ticket = ["make", "test"]
merge = ["make", "check"]
[watch]
plans = [
  {{ plan = "pro", since = 2026-10-01 }},
  {{ plan = "max-5x", since = 2026-10-14T16:30:00Z }},
]
[secrets]
JIRA_EMAIL = {{ item = "a", field = "username" }}
JIRA_API_TOKEN = {{ item = "a", field = "password" }}
NTFY_TOPIC = {{ item = "b", field = "password" }}
"""


def board(fake: FakeJira) -> None:
    """DEMO-5 has two tickets left. DEMO-6 is in review, and the Max 5x run landed it. DEMO-20 has none."""
    fake.add("DEMO-1", "The Loop", issue_type="Epic", status="Done")
    fake.add("DEMO-5", "Spec Answers", issue_type="Epic")
    fake.add("DEMO-20", "People", issue_type="Epic")
    fake.add("DEMO-6", "Record events", parent="DEMO-5", status="In Review")
    fake.add("DEMO-7", "Answer a question", parent="DEMO-5")
    fake.add("DEMO-8", "Ask from Home", parent="DEMO-5", blockers=["DEMO-7"])
    fake.add("DEMO-9", "Done before", parent="DEMO-5", status="Done")
    fake.add("DEMO-2", "Old work", parent="DEMO-1", status="Done")


@pytest.fixture
def fake() -> Any:
    jira = FakeJira()
    board(jira)
    yield jira
    jira.close()


def forecaster(tmp_path: Path, fake: FakeJira) -> Forecaster:
    """The forecast of the demo project over the runs of `runs`, as `loop watch` builds it."""
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "loop.toml").write_text(CONFIG.format(url=fake.url))
    state = runs(tmp_path / "state")
    (state / "secrets.json").write_text(json.dumps({"JIRA_EMAIL": "kc@example.com", "JIRA_API_TOKEN": "t"}))
    return Forecaster(config_file.load(repo, state_dir=state))


def page(found: Forecaster) -> dict[str, Any]:
    """The forecast as the page reads it."""
    _, _, body = Watch(found.config.state_dir, found).handle("/api/forecast")
    data: dict[str, Any] = json.loads(body)
    return data


def test_open_work_has_a_row_per_open_epic_with_the_tickets_left_and_the_window_shares_they_need(
    tmp_path: Path, fake: FakeJira
) -> None:
    """Open work: one row per open Epic, with the tickets left and the share of a 5-hour and a weekly window
    they need."""
    found = page(forecaster(tmp_path, fake))

    # Max 5x landed one ticket in 10% of a 5-hour window and 1% of the week.
    assert found["open"] == {
        "epics": [
            {
                "key": "DEMO-5",
                "summary": "Spec Answers",
                "left": 2,
                "need": {"five_hour": 20.0, "seven_day": 2.0},
            },
            {"key": "DEMO-20", "summary": "People", "left": None, "need": {}},
        ],
        "left": 2,
        "need": {"five_hour": 20.0, "seven_day": 2.0},
    }


def test_capacity_gives_tickets_per_window_and_weeks_for_the_open_work_with_a_line_per_bigger_plan(
    tmp_path: Path, fake: FakeJira
) -> None:
    """Capacity: tickets per 5-hour window, tickets per week, and weeks for the open work, with one line per
    bigger plan scaled by its stated multiple."""
    found = page(forecaster(tmp_path, fake))

    assert found["plan"]["name"] == "Max 5x"
    # Only Max 5x's own run counts: the Pro runs are not scaled across.
    assert found["capacity"] == pytest.approx(
        {
            "tickets": 1,
            "runs": 1,
            "five_hour": 10.0,
            "week": 100.0,
            "weeks": 0.02,
            "bigger": [
                {"name": "Max 20x", "price_more": 100, "five_hour": 40.0, "week": 400.0, "weeks": 0.005}
            ],
        }
    )


def test_plans_compared_has_the_fix_rates_in_one_row_and_no_meter_detail_rows(
    tmp_path: Path, fake: FakeJira
) -> None:
    """Plans compared: the same table, with the fix rates in one row and the meter detail rows gone."""
    found = page(forecaster(tmp_path, fake))

    pro, max5 = found["periods"]
    assert set(pro) == {
        "plan", "name", "runs", "from", "to", "landed", "first_pass_rate", "fixes_per_landed", "stuck",
        "median_minutes", "waits", "waited_hours",
    }  # fmt: skip
    assert (pro["plan"], pro["landed"], pro["first_pass_rate"]) == ("pro", 2, 0.5)
    # One failed ticket gate over two landed tickets.
    assert pro["fixes_per_landed"] == 0.5
    # DEMO-3 took 70 minutes, of which 30 waited for the limit. DEMO-2 took 20.
    assert pro["median_minutes"] == pytest.approx(30.0)
    assert (pro["waits"], pro["waited_hours"]) == (1, pytest.approx(0.5))
    assert (max5["plan"], max5["landed"], max5["fixes_per_landed"]) == ("max-5x", 1, 0)


def test_jira_is_read_when_the_panel_opens_and_the_result_is_kept_for_a_few_minutes(
    tmp_path: Path, fake: FakeJira
) -> None:
    """Jira is read when the panel opens, and the result is kept for a few minutes."""
    found = forecaster(tmp_path, fake)
    now = [1000.0]
    found.backlog.clock = lambda: now[0]
    assert fake.requests == []

    first = page(found)
    reads = [len(fake.requests)]
    fake.add("DEMO-10", "Another part", parent="DEMO-5")
    now[0] += 4 * 60
    kept = page(found)
    reads.append(len(fake.requests))
    now[0] += 2 * 60
    again = page(found)
    reads.append(len(fake.requests))

    # Each read is two searches: the open Epics, then their tickets.
    assert reads == [2, 2, 4]
    assert first["open"]["left"] == 2 and kept["open"] == first["open"]
    assert again["open"]["left"] == 3
    assert first["jira"]["error"] is None and again["jira"]["read"]
    # Only searches: the forecast never writes to Jira.
    assert {request for request in fake.requests} == {("POST", "/rest/api/3/search/jql")}


def test_a_failed_jira_read_says_why_and_shows_no_open_work(tmp_path: Path, fake: FakeJira) -> None:
    found = forecaster(tmp_path, fake)
    fake.errors = [403]

    data = page(found)

    assert data["open"] is None
    assert "HTTP 403" in data["jira"]["error"]
    assert data["capacity"]["weeks"] is None


def test_a_run_takes_the_plan_of_its_time_and_a_change_inside_it_is_unclear() -> None:
    def at(text: str) -> float:
        return datetime.fromisoformat(text).timestamp()

    assert plan_of(SPANS, at("2026-09-30T10:00:00+00:00"), at("2026-09-30T11:00:00+00:00")) is None
    # A date with no time leaves its own day to either plan.
    assert plan_of(SPANS, at("2026-10-01T10:00:00+00:00"), at("2026-10-01T11:00:00+00:00")) == "ambiguous"
    assert plan_of(SPANS, at("2026-10-12T10:00:00+00:00"), at("2026-10-12T11:00:00+00:00")) == "pro"
    assert plan_of(SPANS, at("2026-10-14T16:00:00+00:00"), at("2026-10-14T17:00:00+00:00")) == "ambiguous"
    assert plan_of(SPANS, at("2026-10-14T17:00:00+00:00"), at("2026-10-14T18:00:00+00:00")) == "max-5x"
    assert plan_of((), at("2026-10-14T17:00:00+00:00"), at("2026-10-14T18:00:00+00:00")) is None


def test_a_limit_counts_once_across_restarts_and_stuck_counts_tickets(tmp_path: Path) -> None:
    pro = period("pro", run_records(restarts(tmp_path), SPANS))

    assert pro["waits"] == 1
    # The first run waited 20 minutes before it ended, and the restart 59 until the reset.
    assert pro["waited_hours"] == pytest.approx(79 / 60)
    assert pro["stuck"] == 1
    # A failed merge gate, a code review with findings, and a UI review with faults, over one landed ticket.
    assert pro["fixes_per_landed"] == 3


def restarts(tmp_path: Path) -> Path:
    """A Pro run that lands nothing, fails its merge gate, waits for a limit, and stops on a stuck ticket.
    A restart waits for the same reset, finds the ticket stuck again, and lands another after a code review
    with findings and a UI review with faults.
    """
    log = f"{tmp_path}/DEMO-1/runs/DEMO-2/merge-gate-1.log"
    reset = "The usage limit resets at 2026-10-12T12:00:00+00:00."
    write_lines(
        tmp_path / "DEMO-1" / "decisions.jsonl",
        [
            line("DEMO-1", "DEMO-1", "start", "ok", "2026-10-12T10:00:00+00:00"),
            line("DEMO-1", "DEMO-2", "start", "new", "2026-10-12T10:00:00+00:00"),
            line(
                "DEMO-1", "DEMO-2", "agent", "done", "2026-10-12T10:05:00+00:00", plan=meter((0, 0.2), (0, 0))
            ),
            line("DEMO-1", "DEMO-2", "make check", "fail", "2026-10-12T10:05:00+00:00", detail=log),
            line("DEMO-1", "DEMO-2", "agent", "usage-pause", "2026-10-12T10:10:00+00:00", detail=reset),
            line("DEMO-1", "DEMO-2", "stuck", "stuck", "2026-10-12T10:30:00+00:00"),
            line("DEMO-1", "DEMO-1", "start", "ok", "2026-10-12T11:00:00+00:00"),
            line("DEMO-1", "DEMO-2", "start", "restart", "2026-10-12T11:00:00+00:00"),
            line("DEMO-1", "DEMO-2", "agent", "usage-pause", "2026-10-12T11:01:00+00:00", detail=reset),
            line("DEMO-1", "DEMO-2", "stuck", "stuck", "2026-10-12T12:10:00+00:00"),
            line("DEMO-1", "DEMO-3", "start", "new", "2026-10-12T12:10:00+00:00"),
            line("DEMO-1", "DEMO-3", "code-review", "findings", "2026-10-12T12:20:00+00:00"),
            line("DEMO-1", "DEMO-3", "ui-gate", "fail", "2026-10-12T12:30:00+00:00"),
            line(
                "DEMO-1",
                "DEMO-3",
                "agent",
                "done",
                "2026-10-12T12:40:00+00:00",
                plan=meter((0.2, 0.3), (0, 0)),
            ),
            line("DEMO-1", "DEMO-3", "land", "landed", "2026-10-12T12:50:00+00:00"),
        ],
    )
    return tmp_path


def test_the_jira_read_holds_the_open_epics_and_no_ticket_text(fake: FakeJira) -> None:
    epics = fetch(Jira(fake.url, "kc@example.com", "token", sleep=lambda _: None), ["DEMO"])

    assert [epic["key"] for epic in epics] == ["DEMO-5", "DEMO-20"]
    assert [ticket["key"] for ticket in epics[0]["tickets"]] == ["DEMO-6", "DEMO-7", "DEMO-8", "DEMO-9"]
    assert "Build" not in json.dumps(epics)


def test_a_page_with_no_forecast_answers_null(tmp_path: Path) -> None:
    assert Watch(tmp_path).handle("/api/forecast")[2] == b"null"
    assert Watch(tmp_path).post("/api/forecast/refresh")[0] == 404


def test_no_part_of_the_run_reads_the_forecast() -> None:
    source = LOOP / "src" / "loop"
    for name in ("run.py", "prompts.py", "dispatch.md", "stream.py", "tiers.py", "repo.py", "jira.py"):
        assert "forecast" not in (source / name).read_text(), name


def test_loop_toml_takes_a_plan_history_and_refuses_an_unknown_plan(tmp_path: Path) -> None:
    base = """
name = "demo"
[tracker]
kind = "jira"
url = "https://example.atlassian.net"
[gates]
ticket = ["make", "test"]
merge = ["make", "check"]
[secrets]
JIRA_EMAIL = { item = "a", field = "username" }
JIRA_API_TOKEN = { item = "a", field = "password" }
NTFY_TOPIC = { item = "b", field = "password" }
"""
    (tmp_path / "loop.toml").write_text(base)
    plain = config_file.load(tmp_path)
    assert plain.plans == ()

    (tmp_path / "loop.toml").write_text(
        base
        + """[watch]
plans = [
  { plan = "max-5x", since = 2026-10-14T16:30:00Z },
  { plan = "pro", since = 2026-10-01 },
]
"""
    )
    loaded = config_file.load(tmp_path)
    assert loaded.plans == SPANS

    (tmp_path / "loop.toml").write_text(base + '[watch]\nplans = [{ plan = "team", since = 2026-10-01 }]\n')
    with pytest.raises(ConfigError, match="plan must be one of"):
        config_file.load(tmp_path)
