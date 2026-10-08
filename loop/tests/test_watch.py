"""`loop watch`: the page shows what the run logs, and never a secret or a file outside the run folders."""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path
from typing import Any

from loop.cli import one_run
from loop.watch import Watch, active_run, epic_view, serve

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

    assert "<title>Loop Watch</title>" in page
    assert epics == [
        {"key": EPIC, "summary": "The Loop", "updated": epics[0]["updated"], "running": False},
    ]
