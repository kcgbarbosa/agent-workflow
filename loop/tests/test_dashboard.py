"""The dashboard's run state comes from the log and systemd, so it is right after a kill, a stop, or a
restart. Each test drives the real `loop run`, then reads the page's API as the page does."""

from __future__ import annotations

import json
import os
import signal
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from conftest import EPIC, MAGIC_DNS, SECRETS, TAILNET, World, write_config
from test_crash import two_tickets

from loop import config, watch
from loop.watch import Watch

Send = Callable[..., tuple[int, Any]]


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


@contextmanager
def dashboard(world: World) -> Iterator[Send]:
    """`loop watch` of the demo repo, as its unit serves it, and a function that sends it a request with a
    Host header. The default Host is localhost."""
    write_config(world.repo, world.jira.url, parallel=1)
    world.write_secrets(SECRETS)
    settings = config.load(world.repo)
    servers = watch.serve(settings.state_dir, 0, ["127.0.0.1"], config=settings)
    port = servers[0].server_address[1]

    def send(method: str, path: str, host: str = "localhost") -> tuple[int, Any]:
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}{path}", method=method, headers={"Host": f"{host}:{port}"}
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                body = response.read()
                status = response.status
        except urllib.error.HTTPError as error:
            body, status = error.read(), error.code
        try:
            return status, json.loads(body)
        except json.JSONDecodeError:
            return status, body.decode()

    try:
        yield send
    finally:
        for server in servers:
            server.shutdown()


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
HOME = {"name", "runs", "control"}
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


def test_start_lists_the_projects_open_epics_with_what_a_run_of_each_does_and_starts_the_one_kc_picks(
    world: World,
) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    # A flagged ticket stays open after the run, so the Epic has work to resume.
    world.jira.add("DEMO-3", "Add a part that waits for KC", parent=EPIC, flagged=True)
    world.jira.add("DEMO-4", "An Epic that is done", issue_type="Epic", status="Done")
    world.jira.add("DEMO-5", "The Second Loop", issue_type="Epic")
    world.jira.add("DEMO-6", "Add the next part", parent="DEMO-5")
    world.jira.add("DEMO-7", "An Epic with no tickets yet", issue_type="Epic")
    world.jira.add("DEMO-8", "An Epic whose tickets are done", issue_type="Epic")
    world.jira.add("DEMO-9", "A part that is done", parent="DEMO-8", status="Done")
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}], "DEMO-6": [{"write": {"b.txt": "b"}, "stall": 120}]})
    assert world.run() == 0

    with dashboard(world) as send:
        _, home = send("GET", "/api/home")
        _, start = send("GET", "/api/start")
        started = send("POST", "/api/start/DEMO-5")
        world.wait_for_call("DEMO-6")
        _, view = send("GET", "/api/epic/DEMO-5")
        send("POST", "/api/stop/DEMO-5")

    assert [(project["name"], project["control"]) for project in home] == [("demo", True)]
    assert start["epics"] == [
        {"key": "DEMO-5", "summary": "The Second Loop", "state": "ready", "open": 1},
        {"key": EPIC, "summary": "The Loop", "state": "resume", "open": 1},
        {"key": "DEMO-8", "summary": "An Epic whose tickets are done", "state": "landed", "open": 0},
        {"key": "DEMO-7", "summary": "An Epic with no tickets yet", "state": "no-tickets", "open": 0},
    ]
    assert started == (200, {"started": "DEMO-5"})
    assert view["status"] == "running"
    assert ticket(view, "DEMO-6")["column"] == "running"


def test_a_running_run_has_a_stop_button_after_a_stop_the_view_shows_the_run_as_stopped(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}, "stall": 120}]})

    with dashboard(world) as send:
        send("POST", f"/api/start/{EPIC}")
        world.wait_for_call("DEMO-2")
        _, running = send("GET", f"/api/epic/{EPIC}")
        stopped = send("POST", f"/api/stop/{EPIC}")
        _, after = send("GET", f"/api/epic/{EPIC}")
        again = send("POST", f"/api/stop/{EPIC}")

    assert running["status"] == "running"
    assert stopped == (200, {"stopped": EPIC})
    assert not world.unit_active()
    assert (after["status"], after["stop_reason"]) == ("stopped", "stopped")
    assert again == (409, {"error": f"No run of {EPIC} is active."})


def test_both_work_from_the_iphone_at_the_tailnet_address(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}, "stall": 120}]})

    with dashboard(world) as send:
        page = send("GET", "/", host=MAGIC_DNS.split(".")[0])
        started = send("POST", f"/api/start/{EPIC}", host=TAILNET)
        refused = send("POST", f"/api/start/{EPIC}", host=MAGIC_DNS)
        world.wait_for_call("DEMO-2")
        stopped = send("POST", f"/api/stop/{EPIC}", host=MAGIC_DNS)
        _, after = send("GET", f"/api/epic/{EPIC}", host=TAILNET)

    assert page[0] == 200
    assert "<title>My Loop</title>" in page[1]
    assert started == (200, {"started": EPIC})
    assert refused[0] == 409
    assert f"A run is active: loop-demo-{EPIC}.service" in refused[1]["error"]
    assert stopped == (200, {"stopped": EPIC})
    assert after["status"] == "stopped"


def test_a_request_with_a_host_that_is_not_t14s_gets_403(world: World) -> None:
    with dashboard(world) as send:
        answers = [
            send("GET", "/", host="rebind.example.com"),
            send("GET", "/api/home", host="rebind.example.com"),
            send("GET", "/api/start", host="100.64.0.8"),
            send("POST", f"/api/start/{EPIC}", host="t14.rebind.example.com"),
            send("POST", f"/api/stop/{EPIC}", host="rebind.example.com"),
        ]

    assert [status for status, _ in answers] == [403] * len(answers)
    assert not [call for call in world.records("systemd") if call["tool"] == "systemd-run"]
