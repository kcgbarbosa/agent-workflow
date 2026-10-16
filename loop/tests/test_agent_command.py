"""The command line and the settings of every agent run, which the scenario tests leave to this file."""

from __future__ import annotations

import json
from pathlib import Path

from conftest import EPIC, SECRETS, write_config

from loop import config, tiers
from loop.claude import REVIEW_EFFORT, REVIEW_MODEL, agent_settings
from loop.prompts import AGENT_SCHEMA, DISPATCH, REVIEW_SCHEMA
from loop.run import EpicRun, TicketRun
from loop.tracker import Ticket


def test_the_agent_command_line(tmp_path: Path) -> None:
    write_config(tmp_path)
    loaded = config.load(tmp_path, state_dir=tmp_path / "state")
    epic = EpicRun(EPIC, loaded, SECRETS)
    worktree = tmp_path / "worktree"
    worktree.mkdir()
    ticket = Ticket(
        key="DEMO-2", summary="Add the first part", issue_type="Task", status="To Do",
        done=False, flagged=False, blockers=(), text="",
    )  # fmt: skip
    run = TicketRun(ticket, 2, "feat/DEMO-2-add-the-first-part", worktree, tmp_path / "run")
    agents, dispatch, settings = json.dumps(tiers.load()), DISPATCH.read_text(), agent_settings(loaded)

    def tail(schema: str, name: str) -> list[str]:
        return [
            "--permission-mode", "auto", "--permission-prompts", "none",
            "--output-format", "stream-json", "--verbose", "--json-schema", schema, "-n", name,
            "--agents", agents, "--append-system-prompt", dispatch, "--settings", settings,
        ]  # fmt: skip

    head = epic.agent_command(run, "/implement", None, "DEMO-2", AGENT_SCHEMA, "claude-sonnet-5-5", "low")
    assert head == [
        "claude", "-p", "/implement",
        "--model", "claude-sonnet-5-5", "--effort", "low", "--autocompact", "200000",
        *tail(AGENT_SCHEMA, "DEMO-2"),
    ]  # fmt: skip

    # A worktree with a `.mcp.json` gets its servers and no other. A fix resumes the session.
    (worktree / ".mcp.json").write_text('{"mcpServers": {}}\n')
    fix = epic.agent_command(run, "Fix it.", "s-1", "DEMO-2", AGENT_SCHEMA, "claude-sonnet-5-5", "low")
    assert fix == [
        "claude", "-p", "Fix it.", "--resume", "s-1",
        "--model", "claude-sonnet-5-5", "--effort", "low", "--autocompact", "200000",
        "--mcp-config", str(worktree / ".mcp.json"), "--strict-mcp-config",
        *tail(AGENT_SCHEMA, "DEMO-2"),
    ]  # fmt: skip

    review = epic.agent_command(
        run, "/code-review", None, "DEMO-2-review", REVIEW_SCHEMA, REVIEW_MODEL, REVIEW_EFFORT
    )
    assert review[review.index("--model") : review.index("--autocompact")] == [
        "--model", REVIEW_MODEL, "--effort", REVIEW_EFFORT,
    ]  # fmt: skip
    assert review[-len(tail(REVIEW_SCHEMA, "DEMO-2-review")) :] == tail(REVIEW_SCHEMA, "DEMO-2-review")


def test_each_agent_may_run_the_gates_and_reset_its_stack_without_a_prompt(tmp_path: Path) -> None:
    write_config(tmp_path)

    settings = json.loads(agent_settings(config.load(tmp_path, state_dir=tmp_path / "state")))

    assert settings["permissions"]["allow"] == [
        "Bash(make check)", "Bash(make check *)", "Bash(make lint test)", "Bash(make lint test *)",
    ]  # fmt: skip
    assert "Bash(docker volume rm *)" in settings["permissions"]["deny"]
    rules = settings["autoMode"]["allow"]
    assert rules[0] == "$defaults" and settings["autoMode"]["environment"][0] == "$defaults"
    assert any("`demo-<ticket key>`" in rule and "The volumes stay." in rule for rule in rules)
    assert settings["worktree"] == {"baseRef": "head"}
