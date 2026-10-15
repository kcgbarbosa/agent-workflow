"""`loop watch`: the page shows what the run logs, and never a secret or a file outside the run folders."""

from __future__ import annotations

import json
import os
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from loop.cli import one_run
from loop.watch import (
    Watch,
    active_run,
    epic_view,
    plan_meter,
    queue,
    run_status,
    serve,
    ticket_health,
    verdict,
)

EPIC = "DEMO-1"
TOKEN = "secret-token-value"


def write_lines(path: Path, lines: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(line) + "\n" for line in lines))


def step(ticket: str, step: str, result: str, **extra: Any) -> dict[str, Any]:
    line: dict[str, Any] = {"time": "2026-10-08T02:00:00+00:00", "epic": EPIC, "ticket": ticket, "step": step}
    line |= {"result": result, "commit": None, "session": None, "detail": ""}
    return line | extra


def state_dir(tmp_path: Path) -> Path:
    home = tmp_path / EPIC
    log = home / "runs" / "DEMO-3" / "merge-gate-1.log"
    log.parent.mkdir(parents=True)
    log.write_text(f"connection refused\nJIRA_API_TOKEN={TOKEN}\n")
    write_lines(
        home / "decisions.jsonl",
        [
            step(EPIC, "start", "ok"),
            step("DEMO-2", "start", "new"),
            step("DEMO-2", "agent", "done", session="s1", usage={"total_cost_usd": 4.0, "num_turns": 9}),
            step(EPIC, "stop", "usage-limit"),
            # The latest run starts here. Its session reports the cost of the whole session so far.
            step(EPIC, "start", "ok"),
            step("DEMO-2", "start", "restart"),
            step("DEMO-2", "agent", "done", session="s1", usage={"total_cost_usd": 5.5, "num_turns": 12}),
            step("DEMO-2", "land", "landed", commit="abc"),
            step("DEMO-2", "tracker-status", "ok"),
            step("DEMO-3", "start", "new"),
            step("DEMO-3", "agent", "done", session="s2", usage={"total_cost_usd": 2.0, "num_turns": 3}),
            step("DEMO-3", "stuck", "stuck", detail=f"The merge gate failed. {log}"),
        ],
    )
    board = {
        "epic": EPIC,
        "summary": "The Loop",
        "branch": "feat/DEMO-1-the-loop",
        "tickets": [
            {
                "key": key,
                "summary": f"Part {key}",
                "status": "To Do",
                "done": done,
                "flagged": False,
                "landed": key == "DEMO-2",
                "blockers": blockers,
            }  # fmt: skip
            for key, done, blockers in [
                ("DEMO-2", False, []),
                ("DEMO-3", False, []),
                ("DEMO-4", False, [{"key": "DEMO-3", "done": False}]),
                ("DEMO-5", True, []),
            ]
        ],
    }
    (home / "board.json").write_text(json.dumps(board))
    (tmp_path / "secrets.json").write_text(json.dumps({"JIRA_API_TOKEN": TOKEN, "NTFY_TOPIC": "short"}))
    return tmp_path


def test_the_page_puts_each_ticket_in_its_column_with_the_cost_of_the_run(tmp_path: Path) -> None:
    view = epic_view(state_dir(tmp_path), EPIC)

    columns = {ticket["key"]: ticket["column"] for ticket in view["tickets"]}
    assert columns == {"DEMO-2": "landed", "DEMO-3": "stuck", "DEMO-4": "waiting", "DEMO-5": "done"}
    assert view["state"] == "idle" and view["summary"] == "The Loop"
    # Each session counts once, at its last cost, because a resumed session reports its whole cost so far.
    assert view["cost"] == 7.5 and view["epic_cost"] == 7.5
    stuck = next(ticket for ticket in view["tickets"] if ticket["key"] == "DEMO-3")
    assert stuck["stuck_reason"] == "The merge gate failed. runs/DEMO-3/merge-gate-1.log"
    assert stuck["files"] == ["runs/DEMO-3/merge-gate-1.log"]
    steps = [(event["ticket"], event["step"]) for event in view["events"]]
    assert steps[0] == (EPIC, "start") and ("DEMO-2", "tracker-status") not in steps
    assert (
        next(event for event in view["events"] if event["step"] == "stuck")["log"]
        == "runs/DEMO-3/merge-gate-1.log"
    )


def test_an_agent_log_reads_as_one_line_per_tool_call(tmp_path: Path) -> None:
    home = state_dir(tmp_path) / EPIC
    worktree = f"{home}/worktrees/DEMO-3"
    denied = "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [X]."

    def message(kind: str, *blocks: dict[str, Any], parent: str | None = None) -> dict[str, Any]:
        return {"type": kind, "message": {"content": list(blocks)}, "parent_tool_use_id": parent}

    events = [
        {"type": "system", "subtype": "init", "model": "claude-opus-5-5", "session_id": "s2"},
        message("assistant", {"type": "thinking", "thinking": ""}),
        message("assistant", {"type": "text", "text": "Reading the code."}),
        message(
            "assistant",
            {"type": "tool_use", "id": "t1", "name": "Edit", "input": {"file_path": f"{worktree}/app.py"}},
        ),
        message("user", {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}),
        message(
            "assistant",
            {
                "type": "tool_use",
                "id": "t2",
                "name": "Bash",
                "input": {"command": "docker stop x", "description": "Stop the old stack"},
            },
        ),  # fmt: skip
        message("user", {"type": "tool_result", "tool_use_id": "t2", "is_error": True, "content": denied}),
        message(
            "assistant",
            {"type": "tool_use", "id": "t3", "name": "Grep", "input": {"pattern": "TODO"}},
            parent="t9",
        ),
        message(
            "assistant",
            {
                "type": "tool_use",
                "id": "t4",
                "name": "StructuredOutput",
                "input": {"status": "blocked", "reason": "Port in use.", "decisions": []},
            },
        ),  # fmt: skip
        {"type": "result", "total_cost_usd": 2.0, "num_turns": 3, "duration_ms": 60000},
    ]
    log = home / "runs" / "DEMO-3" / "agent-1.jsonl"
    log.write_text("".join(json.dumps(event) + "\n" for event in events) + '{"type": "assist')

    status, _, body = Watch(tmp_path).handle(f"/api/agent/{EPIC}/DEMO-3/1?offset=0")
    data = json.loads(body)

    assert status == 200
    shapes = [
        (item["kind"], item.get("tool"), item.get("summary") or item.get("text")) for item in data["items"]
    ]
    assert shapes[:4] == [
        ("init", None, None),
        ("text", None, "Reading the code."),
        ("tool", "Edit", "app.py"),
        ("output", None, "ok"),
    ]
    assert ("tool", "Bash", "Stop the old stack") in shapes
    assert next(item for item in data["items"] if item.get("id") == "t2" and item["kind"] == "output")[
        "denied"
    ]
    assert next(item for item in data["items"] if item.get("id") == "t3")["parent"] == "t9"
    assert ("status", None, "Port in use.") in shapes
    # The line the agent still writes waits for the next read.
    assert data["offset"] < data["size"]
    later = json.loads(Watch(tmp_path).handle(f"/api/agent/{EPIC}/DEMO-3/1?offset={data['offset']}")[2])
    assert later["items"] == [] and later["offset"] == data["offset"]


def test_no_secret_reaches_the_page(tmp_path: Path) -> None:
    home = state_dir(tmp_path) / EPIC
    log = home / "runs" / "DEMO-3" / "agent-1.jsonl"
    log.write_text(
        json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": TOKEN}]}}) + "\n"
    )
    watch = Watch(tmp_path)

    agent = watch.handle(f"/api/agent/{EPIC}/DEMO-3/1")[2].decode()
    gate_log = watch.handle(f"/files/{EPIC}/runs/DEMO-3/merge-gate-1.log")[2].decode()

    assert TOKEN not in agent and "[JIRA_API_TOKEN]" in agent
    assert TOKEN not in gate_log and "JIRA_API_TOKEN=[JIRA_API_TOKEN]" in gate_log


def test_the_page_serves_no_file_outside_the_run_folders(tmp_path: Path) -> None:
    watch = Watch(state_dir(tmp_path))

    for path in (
        f"/files/{EPIC}/runs/../../secrets.json",
        f"/files/{EPIC}/runs/%2E%2E/decisions.jsonl",
        f"/files/{EPIC}/worktrees/DEMO-3/.env",
        "/files/../secrets.json",
        f"/api/agent/{EPIC}/DEMO-3/..",
    ):
        assert watch.handle(path)[0] == 404, path


def test_the_page_knows_the_active_run_from_the_lock(tmp_path: Path) -> None:
    with one_run(tmp_path, EPIC):
        assert active_run(tmp_path) == EPIC
    assert active_run(tmp_path) is None


def test_loop_watch_serves_the_page_and_the_api(tmp_path: Path) -> None:
    servers = serve(state_dir(tmp_path), 0, ["127.0.0.1"])
    port = servers[0].server_address[1]
    try:
        page = urllib.request.urlopen(f"http://127.0.0.1:{port}/").read().decode()
        epics = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/api/epics").read())
    finally:
        for server in servers:
            server.shutdown()

    assert "<title>My Loop</title>" in page
    assert epics == [
        {"key": EPIC, "summary": "The Loop", "updated": epics[0]["updated"], "running": False},
    ]


def at(minutes: int) -> str:
    return f"2026-10-08T02:{minutes:02d}:00+00:00"


def gate(key: str, kind: str, number: int, result: str, minutes: int, home: Path) -> dict[str, Any]:
    command = "make lint test" if kind == "ticket" else "make check"
    log = f"{home}/runs/{key}/{kind}-gate-{number}.log"
    return step(key, command, result, time=at(minutes), detail=log)


def stats_state(tmp_path: Path, resets: int) -> Path:
    """Two tickets that landed, one at the first ticket gate and one after a fix, and the plan meter."""
    home = tmp_path / EPIC

    def meter(five: tuple[float, float], seven: tuple[float, float]) -> dict[str, Any]:
        return {
            "five_hour": {"start": five[0], "end": five[1], "resets_at": resets},
            "seven_day": {"start": seven[0], "end": seven[1], "resets_at": resets + 86400},
        }

    write_lines(
        home / "decisions.jsonl",
        [
            step(EPIC, "start", "ok", time=at(0)),
            step("DEMO-2", "start", "new", time=at(0)),
            step("DEMO-3", "start", "new", time=at(0)),
            step("DEMO-2", "agent", "done", time=at(8), plan=meter((0.10, 0.40), (0.50, 0.51))),
            step("DEMO-2", "push", "ok", time=at(8)),
            gate("DEMO-2", "ticket", 1, "pass", 10, home),
            step("DEMO-2-review", "agent", "done", time=at(15), plan=meter((0.40, 0.45), (0.51, 0.52))),
            step("DEMO-2", "code-review", "pass", time=at(15)),
            gate("DEMO-2", "merge", 1, "pass", 30, home),
            step("DEMO-2", "land", "landed", time=at(30)),
            step("DEMO-3", "agent", "done", time=at(20)),
            gate("DEMO-3", "ticket", 1, "fail", 22, home),
            step("DEMO-3", "agent", "done", time=at(30)),
            gate("DEMO-3", "ticket", 2, "pass", 32, home),
            step("DEMO-3-review", "agent", "done", time=at(40)),
            step("DEMO-3", "code-review", "pass", time=at(40)),
            step("DEMO-3", "land", "landed", time=at(50)),
            step("DEMO-4", "start", "new", time=at(50)),
        ],
    )
    return tmp_path


def test_the_page_derives_the_ticket_stats_and_the_plan_meter(tmp_path: Path) -> None:
    resets = int(time.time()) + 3600
    view = epic_view(stats_state(tmp_path, resets), EPIC)

    # A review session belongs to its ticket, not to a ticket of its own.
    assert sorted(ticket["key"] for ticket in view["tickets"]) == ["DEMO-2", "DEMO-3", "DEMO-4"]
    assert view["stats"] == {
        "landed": 2,
        "total": 3,
        "running": 0,
        "stuck": 0,
        "waiting": 1,
        "first_pass_rate": 0.5,
        "median_land_minutes": 40.0,
    }
    plan = view["plan"]
    assert plan["used"] == {"five_hour": 35.0, "seven_day": 2.0}
    assert plan["per_landed"] == {"five_hour": 17.5, "seven_day": 1.0}
    assert plan["now"]["five_hour"] == {"utilization": 0.45, "resets_at": resets, "past": False}
    # (100 - 45) / 17.5 and (100 - 52) / 1, rounded down.
    assert plan["fits"] == {"five_hour": 3, "seven_day": 48}


def test_a_meter_past_its_reset_gives_no_estimate(tmp_path: Path) -> None:
    resets = int(time.time()) - 3600
    plan = epic_view(stats_state(tmp_path, resets), EPIC)["plan"]

    assert plan["now"]["five_hour"]["past"] and not plan["now"]["seven_day"]["past"]
    assert plan["fits"] == {"seven_day": 48}


def test_a_running_ticket_shows_its_current_step_and_its_last_activity(tmp_path: Path) -> None:
    home = tmp_path / EPIC
    write_lines(
        home / "decisions.jsonl",
        [
            step(EPIC, "start", "ok", time=at(0)),
            step("DEMO-2", "start", "new", time=at(0)),
            step("DEMO-3", "start", "new", time=at(0)),
            step("DEMO-4", "start", "new", time=at(0)),
            step("DEMO-3", "agent", "done", time=at(5)),
            step("DEMO-3", "push", "ok", time=at(5)),
            step("DEMO-4", "agent", "done", time=at(5)),
            gate("DEMO-4", "ticket", 1, "pass", 7, home),
            step("DEMO-4-review", "agent", "done", time=at(9)),
            step("DEMO-4", "code-review", "pass", time=at(9)),
        ],
    )
    tool = {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls", "description": "List"}}
    events = [
        {"type": "system", "subtype": "init", "session_id": "s1"},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "Reading the ticket."}]}},
        {"type": "assistant", "message": {"content": [tool]}},
    ]
    for key in ("DEMO-2", "DEMO-4"):
        log = home / "runs" / key / "agent-1.jsonl"
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text("".join(json.dumps(event) + "\n" for event in events))
    # The DEMO-4 log is newer than its last line, so an agent runs after the code review: the UI review.
    os.utime(home / "runs" / "DEMO-4" / "agent-1.jsonl", (time.time(), time.time()))

    with one_run(tmp_path, EPIC):
        view = epic_view(tmp_path, EPIC)

    tickets = {ticket["key"]: ticket for ticket in view["tickets"]}
    assert all(ticket["column"] == "running" for ticket in tickets.values())
    assert tickets["DEMO-2"]["step"] == {"name": "agent", "since": at(0), "paused": False}
    assert tickets["DEMO-3"]["step"] == {"name": "ticket-gate", "since": at(5), "paused": False}
    assert tickets["DEMO-4"]["step"] == {"name": "ui-review", "since": at(9), "paused": False}
    assert [item.get("summary") or item.get("text") for item in tickets["DEMO-2"]["recent"]] == [
        "Reading the ticket.",
        "List",
    ]
    assert tickets["DEMO-3"]["recent"] == []


def test_the_overview_counts_complete_tickets_and_puts_a_ticket_behind_a_stuck_one_last(
    tmp_path: Path,
) -> None:
    view = epic_view(state_dir(tmp_path), EPIC)

    # DEMO-2 landed and DEMO-5 was done before the run. DEMO-3 is stuck, so DEMO-4, which waits on it, is
    # blocked, and the run that stopped for it needs KC.
    assert view["progress"] == {"complete": 2, "total": 4}
    assert view["status"] == "blocked"
    assert view["queue"] == [{"key": "DEMO-4", "state": "blocked", "waits_on": ["DEMO-3"]}]


def ticket(key: str, column: str, *blockers: str) -> dict[str, Any]:
    return {"key": key, "column": column, "blockers": [{"key": b, "done": False} for b in blockers]}


def test_the_queue_takes_the_ready_tickets_first_and_each_waiting_one_after_its_blockers() -> None:
    tickets = [
        ticket("DEMO-2", "running"),
        ticket("DEMO-3", "waiting", "DEMO-4"),
        ticket("DEMO-4", "waiting", "DEMO-2"),
        ticket("DEMO-5", "waiting"),
        ticket("DEMO-6", "landed"),
        ticket("DEMO-7", "waiting", "DEMO-6"),
    ]

    assert [(item["key"], item["state"]) for item in queue(tickets)] == [
        ("DEMO-5", "ready"),
        ("DEMO-7", "ready"),
        ("DEMO-4", "waiting"),
        ("DEMO-3", "waiting"),
    ]


def test_the_run_status_names_a_pause_a_finish_and_a_failure() -> None:
    paused = {**ticket("DEMO-2", "running"), "step": {"name": "agent", "paused": True}}
    working = {**ticket("DEMO-3", "running"), "step": {"name": "agent", "paused": False}}

    assert run_status("running", "", [paused]) == "paused"
    assert run_status("running", "", [paused, working]) == "running"
    assert run_status("pr-open", "", [ticket("DEMO-2", "landed")]) == "completed"
    assert run_status("idle", "", [ticket("DEMO-2", "landed"), ticket("DEMO-3", "done")]) == "completed"
    assert run_status("stopped", "loop-error", [ticket("DEMO-2", "waiting")]) == "failed"
    assert run_status("stopped", "usage-limit", [ticket("DEMO-2", "waiting")]) == "stopped"
    assert run_status("idle", "", [ticket("DEMO-2", "waiting")]) == "idle"


def test_a_running_ticket_needs_attention_only_for_a_reason_it_names() -> None:
    now = time.time()

    def ago(minutes: int) -> str:
        return datetime.fromtimestamp(now - minutes * 60, UTC).isoformat(timespec="seconds")

    agent = {"name": "agent", "since": ago(40), "paused": False}
    assert ticket_health(agent, ago(2), 0) == {"state": "on-track", "reason": ""}
    assert ticket_health(agent, ago(20), 0)["state"] == "attention"
    # A gate runs no agent, so a quiet log says nothing then.
    assert ticket_health({**agent, "name": "ticket-gate"}, ago(20), 0)["state"] == "on-track"
    assert (
        ticket_health(agent, ago(2), 2)["reason"] == "The ticket gate failed 2 times. The agent is fixing it."
    )
    assert ticket_health({**agent, "paused": True}, ago(30), 0)["state"] == "blocked"


def test_a_screenshot_counts_as_reviewed_only_when_a_ui_review_line_follows_it() -> None:
    shots = [{"path": "runs/DEMO-2/home.png", "time": at(10)}]

    assert verdict(None, []) is None
    assert verdict(None, shots) == "unreviewed"
    assert verdict({"result": "pass", "time": at(5)}, shots) == "unreviewed"
    assert verdict({"result": "pass", "time": at(12)}, shots) == "passed"
    assert verdict({"result": "fail", "time": at(12)}, shots) == "faults"
    assert verdict({"result": "unfixed", "time": at(12)}, shots) == "unfixed"


def test_the_plan_meter_is_the_newest_reading_on_the_host_and_never_the_cost(tmp_path: Path) -> None:
    resets = int(time.time()) + 3600
    home = stats_state(tmp_path, resets) / EPIC
    # The finished agent lines end at 45% of the five-hour window. The running agent has read 61% since.
    event = {
        "type": "rate_limit_event",
        "rate_limit_info": {"unifiedWindows": {"five_hour": {"utilization": 0.61, "resetsAt": resets}}},
    }
    log = home / "runs" / "DEMO-4" / "agent-1.jsonl"
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text(json.dumps(event) + "\n" + json.dumps({"type": "result", "total_cost_usd": 9.0}) + "\n")

    assert plan_meter(tmp_path)["five_hour"]["utilization"] == 0.45
    with one_run(tmp_path, EPIC):
        meter = plan_meter(tmp_path)

    assert meter["five_hour"]["utilization"] == 0.61 and not meter["five_hour"]["past"]
    assert meter["seven_day"] == {
        "utilization": 0.52,
        "resets_at": resets + 86400,
        "read": at(15),
        "past": False,
    }


def test_one_page_serves_each_project_on_the_host(tmp_path: Path) -> None:
    ours = tmp_path / "demo-loop"
    state_dir(ours)
    theirs = tmp_path / "other-loop" / "OTHER-1"
    write_lines(theirs / "decisions.jsonl", [step("OTHER-1", "start", "ok")])
    (theirs / "runs" / "OTHER-2").mkdir(parents=True)
    (theirs / "runs" / "OTHER-2" / "gate.log").write_text("other-secret-value\n")
    (tmp_path / "other-loop" / "secrets.json").write_text(json.dumps({"OTHER_TOKEN": "other-secret-value"}))
    watch = Watch(ours)

    projects = json.loads(watch.handle("/api/projects")[2])
    epics = json.loads(watch.handle("/api/epics?project=other")[2])

    assert projects == [{"name": "demo", "running": None}, {"name": "other", "running": None}]
    assert [epic["key"] for epic in epics] == ["OTHER-1"]
    assert [epic["key"] for epic in json.loads(watch.handle("/api/epics")[2])] == [EPIC]
    assert watch.handle("/files/OTHER-1/runs/OTHER-2/gate.log?project=other")[2] == b"[OTHER_TOKEN]\n"
    assert watch.handle("/api/epics?project=none")[0] == 404


def test_the_home_page_lists_the_runs_of_each_project_with_the_running_one_first(tmp_path: Path) -> None:
    ours = tmp_path / "demo-loop"
    state_dir(ours)
    theirs = tmp_path / "other-loop"
    write_lines(theirs / "OTHER-1" / "decisions.jsonl", [step("OTHER-1", "start", "ok")])
    write_lines(
        theirs / "OTHER-2" / "decisions.jsonl",
        [step("OTHER-2", "start", "ok"), step("OTHER-3", "start", "new"), step("OTHER-3", "agent", "done")],
    )
    later = time.time() + 60
    os.utime(theirs / "OTHER-1" / "decisions.jsonl", (later, later))
    (theirs / "OTHER-2" / "board.json").write_text(
        json.dumps({"summary": "Other", "tickets": [{"key": "OTHER-3"}, {"key": "OTHER-4"}]})
    )

    with one_run(theirs, "OTHER-2"):
        home = json.loads(Watch(ours).handle("/api/home")[2])

    names = [(project["name"], project["running"]) for project in home]
    assert names == [("demo", None), ("other", "OTHER-2")]
    assert home[0]["runs"][0] | {"updated": None} == {
        "key": EPIC,
        "summary": "The Loop",
        "updated": None,
        "running": False,
        "status": "blocked",
        "progress": {"complete": 2, "total": 4},
        "stuck": 1,
        "working": [],
        "pr_url": "",
    }
    # OTHER-1 changed last, and the running run still comes first.
    assert [run["key"] for run in home[1]["runs"]] == ["OTHER-2", "OTHER-1"]
    assert home[1]["runs"][0]["working"] == [{"key": "OTHER-3", "step": "ticket-gate"}]


def test_a_screenshot_is_cached_and_the_data_is_not(tmp_path: Path) -> None:
    home = state_dir(tmp_path) / EPIC
    (home / "runs" / "DEMO-3" / "home.png").write_bytes(b"\x89PNG")
    servers = serve(tmp_path, 0, ["127.0.0.1"])
    port = servers[0].server_address[1]
    try:
        image = urllib.request.urlopen(f"http://127.0.0.1:{port}/files/{EPIC}/runs/DEMO-3/home.png?v=1")
        data = urllib.request.urlopen(f"http://127.0.0.1:{port}/api/epic/{EPIC}")
    finally:
        for server in servers:
            server.shutdown()

    assert image.headers["Cache-Control"] == "private, max-age=86400"
    assert data.headers["Cache-Control"] == "no-store"
    # An open page reloads itself when this changes.
    assert data.headers["X-Page-Version"] == image.headers["X-Page-Version"] != ""
