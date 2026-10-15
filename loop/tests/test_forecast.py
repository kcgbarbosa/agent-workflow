"""The capacity forecast: it reads Jira and never writes it, keeps its last snapshot through an outage, tells
the runs of each plan apart, and estimates the open work from what the runs measured.
"""

from __future__ import annotations

import json
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fake_jira import FakeJira

from loop import config as config_file
from loop.config import ConfigError, PlanSpan
from loop.forecast import (
    Backlog,
    backlog_view,
    capacity,
    estimate,
    fetch,
    period,
    plan_of,
    run_records,
    verdict,
    view,
)
from loop.jira import Jira
from loop.watch import serve

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


def test_each_plan_reports_its_own_shares_and_the_time_to_land_less_the_waits(tmp_path: Path) -> None:
    records = run_records(runs(tmp_path), SPANS)
    pro = period("pro", [record for record in records if record["plan"] == "pro"])
    max5 = period("max-5x", [record for record in records if record["plan"] == "max-5x"])

    assert pro["landed"] == 2
    assert pro["first_pass_rate"] == 0.5
    assert pro["fixes_per_landed"]["ticket_gate"] == 0.5
    # DEMO-3 took 70 minutes, of which 30 waited for the limit. DEMO-2 took 20.
    assert pro["median_minutes"] == pytest.approx(30.0)
    assert pro["waits"] == 1 and pro["waited_hours"] == pytest.approx(0.5)
    assert pro["five_hour"]["per_ticket"] == pytest.approx(30.0)
    assert pro["seven_day"]["per_ticket"] == pytest.approx(2.0)
    assert pro["pro_windows_per_ticket"] == pytest.approx(0.3)
    assert max5["five_hour"]["per_ticket"] == pytest.approx(10.0)
    # Max 5x is five Pro windows, so 10% of it is half a Pro window.
    assert max5["pro_windows_per_ticket"] == pytest.approx(0.5)
    assert max5["preliminary"]


def test_a_plan_with_few_tickets_borrows_the_other_plans_runs_scaled_by_the_multiple(tmp_path: Path) -> None:
    records = run_records(runs(tmp_path), SPANS)
    each = estimate(records, "max-5x")

    assert each is not None
    assert each["scaled"] and each["plans"] == ["max-5x", "pro"]
    # Pro's 60% over two tickets is 12% of a Max 5x window; with Max 5x's own 10% over one: 22% over 3.
    assert each["five_hour"]["per_ticket"] == pytest.approx(22 / 3)
    assert each["five_hour"]["low"] == pytest.approx(6.0)
    assert each["five_hour"]["high"] == pytest.approx(10.0)
    assert each["confidence"] == "low"


def test_the_open_work_leaves_out_what_landed_and_waits_on_open_blockers() -> None:
    snapshot = {
        "synced": "2026-10-14T18:00:00+00:00",
        "epics": [
            {
                "key": "DEMO-5",
                "summary": "Spec Answers",
                "status": "To Do",
                "tickets": [
                    {"key": "DEMO-6", "summary": "a", "status": "In Review", "done": False, "blockers": []},
                    {"key": "DEMO-7", "summary": "b", "status": "To Do", "done": False, "blockers": []},
                    {
                        "key": "DEMO-8",
                        "summary": "c",
                        "status": "To Do",
                        "done": False,
                        "blockers": [{"key": "DEMO-7", "done": False}],
                    },
                    {"key": "DEMO-9", "summary": "d", "status": "Done", "done": True, "blockers": []},
                    # Landed by a run on this host, with Jira not moved yet.
                    {
                        "key": "DEMO-10",
                        "summary": "e",
                        "status": "In Progress",
                        "done": False,
                        "blockers": [],
                    },
                ],
            },
            {"key": "DEMO-20", "summary": "People", "status": "To Do", "tickets": []},
        ],
    }
    each = {
        "five_hour": {"per_ticket": 10.0, "low": 5.0, "high": 20.0},
        "seven_day": {"per_ticket": 1.0, "low": None, "high": None},
    }
    work = backlog_view(snapshot, {"DEMO-10"}, "In Review", each)

    assert work is not None
    assert work["left"] == 2
    assert work["epics"] == [
        {
            "key": "DEMO-5",
            "summary": "Spec Answers",
            "total": 5,
            "left": 2,
            "ready": 1,
            "need": {
                "five_hour": {"per_ticket": 20.0, "low": 10.0, "high": 40.0},
                "seven_day": {"per_ticket": 2.0},
            },
        }
    ]
    assert work["unsplit"] == [{"key": "DEMO-20", "summary": "People"}]
    assert backlog_view(None, set(), "In Review", each) is None


def each_ticket(five: float, low: float, high: float, rate: float) -> dict[str, Any]:
    return {
        "five_hour": {"per_ticket": five, "low": low, "high": high},
        "seven_day": {"per_ticket": 2.0, "low": 2.0, "high": 2.0},
        "landed_per_window": {"per_ticket": rate, "low": rate, "high": rate},
    }


def test_the_plan_limits_the_loop_only_when_every_run_says_so() -> None:
    meter_now = {"seven_day": {"utilization": 0.5, "past": False}}
    # The loop lands 10 tickets in 5 hours of running. At 20% a ticket in every run, 5 fit: the plan limits.
    tight = capacity(each_ticket(20.0, 20.0, 20.0, 10.0), "max-5x", meter_now, 30)
    assert tight is not None
    assert tight["limit"] == "plan"
    assert tight["five_hour_by_usage"] == pytest.approx(5.0)
    assert tight["week_left_tickets"] == pytest.approx(25.0)
    assert tight["weeks_for_backlog"] == pytest.approx(0.6)
    # Max 20x fits 20, but the loop's pace caps it at 10: twice what it lands now, for $100 more.
    [upgrade] = tight["upgrades"]
    assert upgrade["plan"] == "max-20x" and upgrade["price_more"] == 100
    assert upgrade["gain"] == pytest.approx(2.0)

    roomy = capacity(each_ticket(5.0, 5.0, 5.0, 10.0), "max-5x", meter_now, 30)
    assert roomy is not None and roomy["limit"] == "loop"
    assert roomy["upgrades"][0]["gain"] == pytest.approx(1.0)

    # The runs range from 5% to 20% a ticket, so a window fits 5 to 20 against the 10 the loop lands.
    wide = capacity(each_ticket(10.0, 5.0, 20.0, 10.0), "max-5x", meter_now, 30)
    assert wide is not None and wide["limit"] == "unclear"
    assert (wide["five_hour_fewest"], wide["five_hour_most"]) == pytest.approx((5.0, 20.0))
    assert (wide["upgrades"][0]["gain_low"], wide["upgrades"][0]["gain_high"]) == pytest.approx((1.0, 2.0))

    own = {"metered_tickets": 20, "waits": 0}
    assert verdict("max-5x", own, each_ticket(5.0, 5.0, 5.0, 10.0), roomy)["state"] == "fits"
    assert verdict("max-5x", own, each_ticket(20.0, 20.0, 20.0, 10.0), tight)["state"] == "limits"
    unclear = verdict("max-5x", own, each_ticket(10.0, 5.0, 20.0, 10.0), wide)
    assert unclear["state"] == "unclear"
    assert "cannot tell yet" in unclear["says"] and "about 5.0 to 20.0" in unclear["says"]
    waited = verdict("max-5x", own | {"waits": 1}, each_ticket(10.0, 5.0, 20.0, 10.0), wide)
    assert waited["state"] == "limits" and "wait for a usage limit once" in waited["says"]
    early = verdict("max-5x", own | {"metered_tickets": 2}, each_ticket(20.0, 20.0, 20.0, 10.0), tight)
    assert early["state"] == "preliminary"
    assert early["says"].startswith("Preliminary.")
    assert "Land 3 more tickets on Max 5x" in early["collect"][0]
    assert verdict(None, None, None, None)["state"] == "unknown"


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


def test_a_limit_counts_once_across_restarts_and_stuck_counts_tickets(tmp_path: Path) -> None:
    pro = period("pro", run_records(restarts(tmp_path), SPANS))

    assert pro["waits"] == 1
    # The first run waited 20 minutes before it ended, and the restart 59 until the reset.
    assert pro["waited_hours"] == pytest.approx(79 / 60)
    assert pro["stuck"] == 1
    assert pro["fixes_per_landed"] == {"ticket_gate": 0, "merge_gate": 1, "code_review": 1, "ui_review": 1}


def test_a_run_that_landed_nothing_still_counts_toward_the_share_and_the_pace(tmp_path: Path) -> None:
    each = estimate(run_records(restarts(tmp_path), SPANS), "pro")

    assert each is not None and not each["scaled"]
    # 20% in the run that landed nothing and 10% in the one that landed DEMO-3.
    assert each["five_hour"] == pytest.approx({"per_ticket": 30.0, "low": 10.0, "high": 10.0})
    # One ticket in 10 + 51 minutes of running less the waits.
    assert each["landed_per_window"]["per_ticket"] == pytest.approx(300 / 61)
    assert each["landed_per_window"]["high"] == pytest.approx(300 / 51)
    assert each["confidence"] == "low" and each["own_tickets"] == 1


# --- Jira ---


def jira(fake: FakeJira) -> Jira:
    return Jira(fake.url, "kc@example.com", "token", sleep=lambda _: None)


def board(fake: FakeJira) -> None:
    fake.add("DEMO-1", "The Loop", issue_type="Epic", status="Done")
    fake.add("DEMO-5", "Spec Answers", issue_type="Epic")
    fake.add("DEMO-20", "People", issue_type="Epic")
    fake.add("DEMO-6", "Record events", parent="DEMO-5", status="In Review")
    fake.add("DEMO-7", "Answer a question", parent="DEMO-5")
    fake.add("DEMO-8", "Ask from Home", parent="DEMO-5", blockers=["DEMO-7"])
    fake.add("DEMO-2", "Old work", parent="DEMO-1", status="Done")


def test_the_snapshot_holds_the_open_epics_and_no_ticket_text() -> None:
    fake = FakeJira()
    try:
        board(fake)
        epics = fetch(jira(fake), ["DEMO"])
    finally:
        fake.close()

    assert [epic["key"] for epic in epics] == ["DEMO-5", "DEMO-20"]
    assert [ticket["key"] for ticket in epics[0]["tickets"]] == ["DEMO-6", "DEMO-7", "DEMO-8"]
    assert epics[0]["tickets"][2]["blockers"] == [{"key": "DEMO-7", "done": False}]
    assert "Build" not in json.dumps(epics)
    # Only searches: the forecast never writes to Jira.
    assert {request for request in fake.requests} == {("POST", "/rest/api/3/search/jql")}


def test_a_sync_follows_each_change_in_jira_and_keeps_the_last_snapshot_through_an_outage(
    tmp_path: Path,
) -> None:
    (tmp_path / "DEMO-5").mkdir()
    fake = FakeJira()
    try:
        board(fake)
        backlog = Backlog(tmp_path, lambda: jira(fake), 5)
        backlog.sync()
        first = backlog.snapshot
        assert first is not None and backlog.status()["error"] is None
        assert not backlog.status()["stale"]

        # A new ticket, a removed one, one moved to another Epic, a new status, and a new blocker.
        fake.add("DEMO-9", "Edit synonyms", parent="DEMO-5")
        del fake.issues["DEMO-6"]
        fake.issues["DEMO-7"].parent = "DEMO-20"
        fake.issues["DEMO-8"].status = "Done"
        fake.issues["DEMO-9"].blockers = ["DEMO-8"]
        backlog.sync()
        epics = {epic["key"]: epic for epic in backlog.snapshot["epics"]}  # type: ignore[index]
        assert [t["key"] for t in epics["DEMO-5"]["tickets"]] == ["DEMO-8", "DEMO-9"]
        assert [t["key"] for t in epics["DEMO-20"]["tickets"]] == ["DEMO-7"]
        assert epics["DEMO-5"]["tickets"][0]["done"]
        assert epics["DEMO-5"]["tickets"][1]["blockers"] == [{"key": "DEMO-8", "done": True}]
        synced = backlog.snapshot["synced"]  # type: ignore[index]

        # Jira fails every attempt: the last snapshot stays, and the status says why.
        fake.errors = [503] * 4
        backlog.sync()
        status = backlog.status()
        assert backlog.snapshot["synced"] == synced  # type: ignore[index]
        assert "HTTP 503" in str(status["error"])
        assert not status["syncing"]
    finally:
        fake.close()

    # A restart shows the saved snapshot with its age.
    again = Backlog(tmp_path, lambda: jira(fake), 5)
    assert again.snapshot is not None and again.snapshot["synced"] == synced


def test_a_snapshot_older_than_two_reads_is_stale(tmp_path: Path) -> None:
    old = datetime.fromtimestamp(time.time() - 3600, UTC).isoformat(timespec="seconds")
    (tmp_path / "backlog.json").write_text(json.dumps({"synced": old, "projects": ["DEMO"], "epics": []}))
    status = Backlog(tmp_path, lambda: jira(FakeJira()), 5).status()

    assert status["synced"] == old and status["stale"]


def test_a_host_with_no_run_or_no_secret_says_why_and_shows_no_backlog(tmp_path: Path) -> None:
    backlog = Backlog(tmp_path, lambda: jira(FakeJira()), 5)
    backlog.sync()

    assert backlog.snapshot is None
    assert "No run on this host" in str(backlog.status()["error"])


def test_a_refresh_waits_for_the_one_before_it(tmp_path: Path) -> None:
    backlog = Backlog(tmp_path, lambda: jira(FakeJira()), 5)
    assert backlog.refresh()
    backlog.asked = time.time()
    assert not backlog.refresh()


# --- The page ---


class Forecast:
    def __init__(self, state_dir: Path) -> None:
        self.state_dir = state_dir
        self.refreshed = 0

    def view(self) -> dict[str, Any]:
        return view(self.state_dir, None, SPANS, "In Review", {})

    def refresh(self) -> bool:
        self.refreshed += 1
        return True


def test_the_page_serves_the_forecast_and_a_refresh(tmp_path: Path) -> None:
    forecast = Forecast(runs(tmp_path))
    servers = serve(tmp_path, 0, ["127.0.0.1"], forecast)
    port = servers[0].server_address[1]
    try:
        found = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/api/forecast").read())
        request = urllib.request.Request(f"http://127.0.0.1:{port}/api/forecast/refresh", method="POST")
        started = json.loads(urllib.request.urlopen(request).read())
        epics = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/api/epics").read())
    finally:
        for server in servers:
            server.shutdown()

    assert [item["plan"] for item in found["periods"]] == ["pro", "max-5x"]
    assert found["plan"]["name"] == "Max 5x"
    assert found["backlog"] is None and found["sync"] is None
    assert started == {"started": True} and forecast.refreshed == 1
    assert sorted(epic["key"] for epic in epics) == ["DEMO-1", "DEMO-5"]


def test_a_page_with_no_forecast_answers_null(tmp_path: Path) -> None:
    servers = serve(tmp_path, 0, ["127.0.0.1"])
    port = servers[0].server_address[1]
    try:
        found = urllib.request.urlopen(f"http://127.0.0.1:{port}/api/forecast").read()
    finally:
        for server in servers:
            server.shutdown()

    assert json.loads(found) is None


# --- The boundary ---


def test_no_part_of_the_run_reads_the_forecast_or_its_snapshot() -> None:
    source = LOOP / "src" / "loop"
    for name in ("run.py", "prompts.py", "dispatch.md", "stream.py", "tiers.py", "repo.py", "tracker.py"):
        text = (source / name).read_text()
        assert "forecast" not in text and "backlog.json" not in text, name


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
    assert plain.plans == () and plain.backlog_minutes == 5

    (tmp_path / "loop.toml").write_text(
        base
        + """[watch]
backlog_minutes = 10
plans = [
  { plan = "max-5x", since = 2026-10-14T16:30:00Z },
  { plan = "pro", since = 2026-10-01 },
]
"""
    )
    loaded = config_file.load(tmp_path)
    assert loaded.backlog_minutes == 10
    assert loaded.plans == SPANS

    (tmp_path / "loop.toml").write_text(base + '[watch]\nplans = [{ plan = "team", since = 2026-10-01 }]\n')
    with pytest.raises(ConfigError, match="plan must be one of"):
        config_file.load(tmp_path)
