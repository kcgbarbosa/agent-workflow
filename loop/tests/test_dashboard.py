"""The dashboard's run state comes from the log and systemd, so it is right after a kill, a stop, or a
restart. Each test drives the real `loop run`, then reads the page's API as the page does."""

from __future__ import annotations

import json
import os
import signal
import time
from typing import Any

from conftest import EPIC, World
from test_crash import two_tickets

from loop.watch import Watch


def api(world: World, path: str) -> Any:
    status, _, body = Watch(world.state).handle(path)
    return json.loads(body) if status == 200 else status


def epic(world: World) -> Any:
    return api(world, f"/api/epic/{EPIC}")


def ticket(view: dict[str, Any], key: str) -> dict[str, Any]:
    return next(item for item in view["tickets"] if item["key"] == key)


def started(world: World, key: str, step: str) -> str:
    """The time of the step's last `started` line."""
    lines = [
        line
        for line in world.decisions()
        if (line["ticket"], line["step"], line["result"]) == (key, step, "started")
    ]
    return str(lines[-1]["time"])


def wait_until(check: Any, seconds: float = 60) -> None:
    deadline = time.monotonic() + seconds
    while not check() and time.monotonic() < deadline:
        time.sleep(0.1)
    assert check()


def test_a_run_killed_mid_step_shows_as_stopped_with_the_step_it_stopped_in(world: World) -> None:
    two_tickets(world)
    world.kill_at("make:lint test")

    world.run()

    view = epic(world)
    assert view["status"] == "stopped"
    demo = ticket(view, "DEMO-2")
    assert demo["column"] == "stopped"
    assert demo["step"] == {
        "name": "ticket-gate",
        "since": started(world, "DEMO-2", "ticket-gate"),
        "paused": False,
    }


def test_a_running_run_shows_its_current_step_from_the_steps_started_line(world: World) -> None:
    two_tickets(world)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}, "stall": 120}]})
    world.start()
    world.wait_for_call("DEMO-2")

    view = epic(world)

    world.stop()
    assert view["status"] == "running"
    demo = ticket(view, "DEMO-2")
    assert demo["column"] == "running"
    assert demo["step"] == {"name": "build", "since": started(world, "DEMO-2", "build"), "paused": False}


def test_a_paused_run_shows_when_it_resumes(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"error": "usage", "resets_in": 3600}, {"write": {"a.txt": "a"}}]})
    # The run stops in its pause, when it notifies that it paused.
    world.kill_at(f"ntfy:{EPIC} paused", signal="SIGSTOP")
    world.start()
    wait_until(lambda: (world.fakes / "kill.fired").exists())

    view = epic(world)

    pid = json.loads((world.fakes / "units" / f"loop-demo-{EPIC}.service.json").read_text())["pid"]
    os.kill(pid, signal.SIGCONT)
    world.stop()
    (pause,) = [line for line in world.decisions() if line["result"] == "usage-pause"]
    assert view["status"] == "paused"
    assert view["resumes"] == pause["resumes"]
    assert ticket(view, "DEMO-2")["step"]["paused"]


def test_the_plan_meter_still_shows_for_a_running_run(world: World) -> None:
    resets = int(time.time()) + 3600
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"rate_limits": [{"five_hour": [0.42, resets]}], "stall": 120}]})
    world.start()
    wait_until(lambda: any(line["step"] == "meter" for line in world.decisions()))

    usage = api(world, "/api/usage")

    world.stop()
    assert usage["five_hour"]["utilization"] == 0.42
    assert usage["five_hour"]["resets_at"] == resets
    assert not usage["five_hour"]["past"]


# The fields the page reads, for each view.
HOME = {"name", "runs"}
HOME_RUN = {"key", "summary", "updated", "running", "status", "progress", "stuck", "working"}
EPIC_VIEW = {
    "key", "summary", "branch", "status", "resumes", "progress", "queue", "state", "stop_reason", "pr_url",
    "started", "updated", "tickets", "stats", "plan", "events", "epic_files", "epic_agents",
}  # fmt: skip
TICKET = {
    "key", "summary", "status", "column", "blockers", "stuck_reason", "last", "cost", "agents", "step",
    "health", "gate_failures", "recent", "screenshots", "verdict", "files",
}  # fmt: skip
METER = {"utilization", "resets_at", "read", "past"}


def test_every_view_keeps_the_data_it_has_today_except_fields_the_page_does_not_show(world: World) -> None:
    two_tickets(world)
    plan = json.loads((world.fakes / "plan.json").read_text())
    meter = [{"five_hour": [0.3, int(time.time()) + 3600]}]
    world.plan({**plan, "DEMO-3": [{"write": {"b.txt": "b"}, "rate_limits": meter}]})
    world.run()

    home = api(world, "/api/home")
    view = epic(world)
    report = api(world, f"/api/report/{EPIC}")
    feed = api(world, f"/api/agent/{EPIC}/DEMO-2/1")

    assert [set(project) for project in home] == [HOME]
    assert set(home[0]["runs"][0]) == HOME_RUN
    assert set(view) == EPIC_VIEW
    assert all(set(item) == TICKET for item in view["tickets"])
    assert set(view["stats"]) == {"landed", "stuck", "first_pass_rate", "median_land_minutes"}
    assert set(view["plan"]) == {"used", "per_landed", "fits"}
    assert all(set(agent) == {"number", "updated"} for item in view["tickets"] for agent in item["agents"])
    assert set(api(world, "/api/usage")["five_hour"]) == METER
    assert set(report) == {"previous", "rows"}
    assert set(feed) == {"items", "offset", "size"}
    assert feed["items"][0] == {"kind": "init", "model": ""}
    # The project list and the Epic list are part of the home view now.
    assert api(world, "/api/projects") == 404
    assert api(world, "/api/epics") == 404
