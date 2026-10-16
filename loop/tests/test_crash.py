"""Crash and stop scenarios: a real signal stops `loop run` in a step, or between a side effect and its log
line, and a rerun must finish the Epic as one run with no stop would.
"""

from __future__ import annotations

import collections
import json
import signal

import pytest
from conftest import EPIC, World, sh

from loop.prompts import STUCK_COMMENT

NOTE = "A judgement call that follows the docs."
PR_BODY = "## Summary\n\nBuilds the Loop."
EPIC_BRANCH = f"feat/{EPIC}-the-loop"


def two_tickets(world: World) -> None:
    """DEMO-2 changes the UI and leaves a note. DEMO-3 waits for it. A session that runs again says the
    same."""
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.jira.add("DEMO-3", "Add the second part", parent=EPIC, blockers=["DEMO-2"])
    first = {"write": {"frontend/src/a.tsx": "a"}, "notes": [NOTE]}
    world.plan(
        {
            "DEMO-2": [first, {"notes": [NOTE]}],
            "DEMO-2-ui": [{"screenshot": True}, {"screenshot": True}],
            "DEMO-3": [{"write": {"b.txt": "b"}}],
            f"{EPIC}-pr": [{"pr_body": PR_BODY}, {"pr_body": PR_BODY}],
        }
    )


def assert_built_once(world: World, head_runs: int = 1) -> None:
    """Each ticket landed once, with each status once, no comment or attachment twice, one review result of
    each kind, and one PR. Origin holds the Epic branch. A killed session can still finish as an orphan, so
    the reviews count by the results the loop logged. DEMO-2's head agent runs `head_runs` times."""
    assert len(world.calls("DEMO-2")) == head_runs
    assert len(world.calls("DEMO-3")) == 1
    merges = collections.Counter(s for s in world.epic_log() if s.startswith("merge("))
    assert merges == {"merge(DEMO-2): Add the first part": 1, "merge(DEMO-3): Add the second part": 1}
    for key in ("DEMO-2", "DEMO-3"):
        issue = world.jira.issues[key]
        assert issue.statuses == ["In Progress", "In Review"], key
        assert not issue.flagged, key
        repeated = [text for text, count in collections.Counter(issue.comments).items() if count > 1]
        assert repeated == [], key
        assert len(issue.attachments) == len(set(issue.attachments)), key
        assert world.results(key, "code-review") == ["pass"], key
    assert world.results("DEMO-2", "ui-gate") == ["pass"]
    assert len(world.gh("pr", "create")) == 1
    (pr,) = world.prs()
    assert not pr["draft"]
    local = sh(world.repo, "git", "rev-parse", EPIC_BRANCH)
    assert sh(world.origin, "git", "rev-parse", EPIC_BRANCH) == local


# The points before DEMO-2's build logs its result, so its agent runs again.
BUILD_AGAIN = {"claude:DEMO-2", "jira:POST DEMO-2 comment", "push:feat/DEMO-2"}
# Each point as the fakes and the hooks name it, with the time it fires. They follow one run's order.
IN_A_STEP = [
    pytest.param("claude:DEMO-2", 1, id="build-agent"),
    pytest.param("make:lint test", 1, id="ticket-gate"),
    pytest.param("claude:DEMO-2-review", 1, id="code-review"),
    pytest.param("claude:DEMO-2-ui", 1, id="ui-review"),
    pytest.param("make:check", 1, id="land-merge-gate"),
    pytest.param(f"pre-push:{EPIC_BRANCH}", 1, id="land-after-merge-before-push"),
    pytest.param("make:check", 3, id="finish-merge-gate"),
    pytest.param(f"claude:{EPIC}-pr", 1, id="finish-pr-body"),
]
AFTER_A_SIDE_EFFECT = [
    pytest.param("jira:POST DEMO-2 transitions", 1, id="status-in-progress"),
    pytest.param("jira:POST DEMO-2 comment", 1, id="notes-comment"),
    pytest.param("push:feat/DEMO-2", 1, id="ticket-push"),
    pytest.param(f"push:{EPIC_BRANCH}", 1, id="epic-push"),
    pytest.param("jira:POST DEMO-2 attachments", 1, id="screenshots-attached"),
    pytest.param("jira:POST DEMO-2 transitions", 2, id="status-landed"),
    pytest.param("gh:pr create", 1, id="pr-created"),
]


@pytest.mark.parametrize(("point", "nth"), IN_A_STEP + AFTER_A_SIDE_EFFECT)
def test_a_rerun_after_a_kill_builds_each_ticket_once(world: World, point: str, nth: int) -> None:
    two_tickets(world)
    world.kill_at(point, nth)

    assert world.run(parallel=1) == -signal.SIGKILL
    assert world.run(parallel=1) == 0

    assert_built_once(world, head_runs=2 if point in BUILD_AGAIN else 1)


@pytest.mark.parametrize(
    "point",
    [
        pytest.param("claude:DEMO-3", id="build-agent"),
        pytest.param("make:check", id="land-merge-gate"),
        pytest.param(f"push:{EPIC_BRANCH}", id="epic-push"),
    ],
)
def test_a_kill_during_a_parallel_run_then_a_rerun_lands_each_ticket_once(world: World, point: str) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.jira.add("DEMO-3", "Add the second part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}], "DEMO-3": [{"write": {"b.txt": "b"}}]})
    world.kill_at(point)

    assert world.run(parallel=2) == -signal.SIGKILL
    assert world.run(parallel=2) == 0

    merges = collections.Counter(s for s in world.epic_log() if s.startswith("merge("))
    assert merges == {"merge(DEMO-2): Add the first part": 1, "merge(DEMO-3): Add the second part": 1}
    for key in ("DEMO-2", "DEMO-3"):
        assert world.jira.issues[key].statuses == ["In Progress", "In Review"], key
    assert len(world.gh("pr", "create")) == 1
    assert sh(world.origin, "git", "rev-parse", EPIC_BRANCH) == sh(
        world.repo, "git", "rev-parse", EPIC_BRANCH
    )


def test_a_kill_in_a_fix_does_not_give_its_fix_attempt_back(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a", "TICKET_FAIL": "x"}}]})
    world.kill_at("claude:DEMO-2", nth=2)

    assert world.run(parallel=1) == -signal.SIGKILL
    world.run(parallel=1)

    # The build, the fix that the kill stopped, and the one fix attempt left.
    assert len(world.calls("DEMO-2")) == 3
    assert world.jira.issues["DEMO-2"].flagged


def test_a_rerun_after_a_kill_between_the_flag_and_its_comment_comments_the_stuck_ticket(
    world: World,
) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a", "TICKET_FAIL": "x"}}]})
    world.kill_at("jira:PUT DEMO-2 flag")

    assert world.run(parallel=1) == -signal.SIGKILL
    world.run(parallel=1)

    issue = world.jira.issues["DEMO-2"]
    assert issue.flagged
    stuck = [text for text in issue.comments if text.startswith(STUCK_COMMENT)]
    assert len(stuck) == 1


def test_a_restart_after_the_ticket_gate_passed_goes_on_with_no_agent_run(world: World) -> None:
    two_tickets(world)
    world.kill_at("claude:DEMO-2-review")

    assert world.run(parallel=1) == -signal.SIGKILL
    # The kill can cut off the last line of the log.
    with (world.state / EPIC / "decisions.jsonl").open("a") as log:
        log.write('{"time": "2026-')
    assert world.run(parallel=1) == 0

    assert len(world.calls("DEMO-2")) == 1
    assert_built_once(world)


@pytest.mark.xfail(
    strict=True, reason="#60: the run does not handle SIGTERM, so it ends with no stopped line"
)
def test_sigterm_stops_the_run_with_a_stopped_line_and_the_stacks_down(world: World) -> None:
    two_tickets(world)
    # The session goes on after the signal, so the loop has to stop it.
    plan = json.loads((world.fakes / "plan.json").read_text())
    world.plan({**plan, "DEMO-2": [{"write": {"frontend/src/a.tsx": "a"}, "stall": 30}]})
    world.kill_at("claude:DEMO-2", signal="SIGTERM")

    world.run(parallel=1)

    assert any(line["result"] == "stopped" and line["ticket"] == EPIC for line in world.decisions())
    commands = world.records("commands")
    fired = next(n for n, record in enumerate(commands) if record["tool"] == "kill")
    downs = {
        record["project"]
        for record in commands[fired:]
        if record["tool"] == "docker" and record["args"][:2] == ["compose", "down"]
    }
    assert {"demo-demo-1", "demo-demo-2"} <= downs

    assert world.run(parallel=1) == 0
    assert_built_once(world, head_runs=2)
