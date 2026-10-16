"""Scenarios of `loop run`, run as a subprocess against the fakes. Each test checks what KC can see: git,
Jira, the `gh` calls, the notifications, and the results in the log, and no prompt wording.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
from pathlib import Path

import pytest
from conftest import EPIC, World, sh

from loop import run as loop_run
from loop import tiers
from loop.claude import REVIEW_EFFORT, REVIEW_MODEL


def test_a_fresh_epic_lands_a_chain_of_blockers_in_order_and_opens_one_ready_pr(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.jira.add("DEMO-3", "Add the second part", parent=EPIC, blockers=["DEMO-2"])
    world.jira.add("DEMO-7", "Add the third part", parent=EPIC, blockers=["DEMO-3"])
    world.jira.add("DEMO-5", "Done before", parent=EPIC, status="Done")
    # Sessions that go quiet mid-turn and write their events in parts, as a real one can.
    world.plan(
        {
            "DEMO-2": [{"write": {"a.txt": "a"}, "split": True}],
            "DEMO-3": [{"write": {"b.txt": "b"}, "stall": 3}],
            "DEMO-7": [{"write": {"c.txt": "c"}, "split": True, "stall": 1}],
        }
    )

    assert world.run() == 0

    names = {call["name"] for call in world.calls()}
    assert names == {
        "DEMO-2", "DEMO-2-review", "DEMO-3", "DEMO-3-review", "DEMO-7", "DEMO-7-review", f"{EPIC}-pr",
    }  # fmt: skip
    merges = [subject for subject in world.epic_log() if subject.startswith("merge(")]
    assert merges == [
        "merge(DEMO-7): Add the third part",
        "merge(DEMO-3): Add the second part",
        "merge(DEMO-2): Add the first part",
    ]
    steps = [(line["ticket"], line["step"], line["result"]) for line in world.decisions()]
    assert steps.index(("DEMO-2", "land", "landed")) < steps.index(("DEMO-3", "start", "new"))
    assert steps.index(("DEMO-3", "land", "landed")) < steps.index(("DEMO-7", "start", "new"))
    for key in ("DEMO-2", "DEMO-3", "DEMO-7"):
        assert world.jira.issues[key].statuses == ["In Progress", "In Review"]
    assert world.jira.issues["DEMO-5"].statuses == []
    (pr,) = world.prs()
    assert not pr["draft"] and pr["head"] == f"feat/{EPIC}-the-loop" and pr["base"] == "main"


def test_each_agent_gets_the_ticket_file_the_secrets_and_its_own_stack(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}]})

    world.run()

    call = world.calls("DEMO-2")[0]
    ticket = (world.run_dir("DEMO-2") / "ticket.md").read_text()
    assert "Add the first part" in ticket
    assert "make lint test" in ticket
    assert call["secret"] == "secret-token"
    assert call["bw_session"] is None
    assert call["db_port"] != "55432"
    gates = [(record["targets"], record["project"]) for record in world.records("make")]
    assert (["lint", "test"], "demo-demo-2") in gates
    assert (["check"], "demo-demo-1") in gates
    land = next(line for line in world.decisions() if line["step"] == "land")
    assert land["ticket"] == "DEMO-2" and land["commit"]


def test_the_run_writes_the_board_that_loop_watch_shows(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.jira.add("DEMO-3", "Add the second part", parent=EPIC, blockers=["DEMO-2"])
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}], "DEMO-3": [{"write": {"b.txt": "b"}}]})

    world.run()

    board = json.loads((world.state / EPIC / "board.json").read_text())
    assert board["summary"] == "The Loop"
    tickets = {ticket["key"]: ticket for ticket in board["tickets"]}
    assert tickets["DEMO-2"]["landed"] and tickets["DEMO-3"]["landed"]
    assert tickets["DEMO-3"]["blockers"] == [{"key": "DEMO-2", "done": True}]


def test_a_run_first_stops_the_stacks_that_earlier_runs_left(world: World) -> None:
    projects = [{"Name": name} for name in ("demo-demo-0", "demo-old-35", "demo", "other-x-1")]
    (world.fakes / "compose-projects.json").write_text(json.dumps(projects))

    world.run()

    downs = [record["args"] for record in world.records("docker") if "--project-name" in record["args"]]
    assert downs == [
        ["compose", "--project-name", "demo-demo-0", "down"],
        ["compose", "--project-name", "demo-old-35", "down"],
    ]
    stopped = [line["detail"] for line in world.decisions() if line["step"] == "stop-stale-stack"]
    assert stopped == ["demo-demo-0", "demo-old-35"]


def test_each_gate_runs_on_new_containers(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}]})

    world.run()

    commands = world.records("commands")
    gates = [index for index, record in enumerate(commands) if record["tool"] == "make"]
    assert gates
    for index in gates:
        before = commands[index - 1]
        assert before["args"] == ["compose", "down"]
        assert before["project"] == commands[index]["project"]


def test_the_epic_stack_stops_when_the_run_stops(world: World) -> None:
    world.jira.add("DEMO-2", "Break the end to end tests", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"MERGE_FAIL": "x"}}]})

    assert world.run() == 1

    last = world.records("docker")[-1]
    assert last["args"] == ["compose", "down"] and last["project"] == "demo-demo-1"


def test_a_failed_ticket_gate_goes_back_to_the_session_with_the_log_tail(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a", "TICKET_FAIL": "x"}}, {"delete": ["TICKET_FAIL"]}]})

    assert world.run() == 0

    first, fix = world.calls("DEMO-2")
    assert fix["resume"] == world.first_session("DEMO-2")
    assert "FAILED tests/test_ticket.py" in fix["prompt"]
    assert "merge(DEMO-2): Add the first part" in world.epic_log()


def test_a_ticket_out_of_fix_attempts_is_flagged_with_the_reason_and_its_dependants_wait(
    world: World,
) -> None:
    world.jira.add("DEMO-2", "Needs a fix", parent=EPIC)
    world.jira.add("DEMO-3", "Builds on the fix", parent=EPIC, blockers=["DEMO-2"])
    world.jira.add("DEMO-4", "Separate work", parent=EPIC)
    world.jira.add("DEMO-9", "Outside work that is open")
    world.jira.add("DEMO-5", "Wait on outside work", parent=EPIC, blockers=["DEMO-9"])
    world.jira.add("DEMO-6", "Waits for KC", parent=EPIC, flagged=True)
    world.plan({"DEMO-2": [{"write": {"TICKET_FAIL": "x"}}], "DEMO-4": [{"write": {"d.txt": "d"}}]})

    assert world.run() == 0

    assert len(world.calls("DEMO-2")) == 3
    stuck = world.jira.issues["DEMO-2"]
    assert stuck.flagged and stuck.status == "In Progress"
    (comment,) = stuck.comments
    assert "make lint test" in comment
    assert str(world.run_dir("DEMO-2") / "ticket-gate-3.log") in comment
    assert "DEMO-2 stuck" in world.jira.notifications
    for key in ("DEMO-3", "DEMO-5", "DEMO-6"):
        assert world.calls(key) == [] and world.jira.issues[key].statuses == []
    assert "merge(DEMO-4): Separate work" in world.epic_log()
    (pr,) = world.prs()
    assert pr["draft"]
    assert "| DEMO-2 | Stuck |" in pr["body"] and "| DEMO-3 | Not built |" in pr["body"]
    assert pr["body"].startswith("**Unfinished tickets:** DEMO-2, DEMO-3, DEMO-5, DEMO-6.")
    assert f"{EPIC} pr-draft" in world.jira.notifications


# A stubborn gate ignores SIGTERM, so only the SIGKILL after the grace time ends it.
@pytest.mark.parametrize("hang", ["polite", "stubborn"])
def test_a_gate_past_its_limit_fails_and_its_child_processes_and_containers_stop(
    world: World, monkeypatch: pytest.MonkeyPatch, hang: str
) -> None:
    # A minute of the limits lasts a second, so the gate's limit of one minute ends it in a second.
    monkeypatch.setenv("FAKE_MINUTE_SECONDS", "1")
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a", "GATE_HANG": hang}}, {"delete": ["GATE_HANG"]}]})

    assert world.run(gates_extra="timeout_minutes = 1") == 0

    _, fix = world.calls("DEMO-2")
    assert fix["resume"] is not None
    assert world.results("DEMO-2", "make lint test") == ["fail", "pass"]
    assert "ran past its time limit of 1 min" in (world.run_dir("DEMO-2") / "ticket-gate-1.log").read_text()
    assert "merge(DEMO-2): Add the first part" in world.epic_log()
    commands = [(line["tool"], line.get("targets") or line["args"]) for line in world.records("commands")]
    hung = commands.index(("make", ["lint", "test"]))
    assert commands[hung + 1] == ("docker", ["compose", "down"])
    # The gate's child process would mark that it survived four seconds after it started.
    time.sleep(4)
    assert not (world.fakes / "gate-child-survived").exists()


def test_a_conflict_goes_back_to_the_agent_and_the_ticket_lands(world: World) -> None:
    world.jira.add("DEMO-2", "Write the file one way", parent=EPIC)
    world.jira.add("DEMO-3", "Write the file another way", parent=EPIC)
    resolve = {"write": {"same.txt": "both"}, "commit": "fix: resolve"}
    world.plan(
        {
            "DEMO-2": [{"write": {"same.txt": "two"}}, resolve],
            "DEMO-3": [{"write": {"same.txt": "three"}}, resolve],
        }
    )

    assert world.run() == 0

    assert not any(world.jira.issues[key].flagged for key in ("DEMO-2", "DEMO-3"))
    assert world.epic_file("same.txt").read_text() == "both"
    resumed = [call for call in world.calls() if call["resume"] and call["name"] in ("DEMO-2", "DEMO-3")]
    assert len(resumed) == 1
    assert "same.txt" in resumed[0]["prompt"]
    later = resumed[0]["name"]
    assert world.results(later, "land") == ["conflict", "landed"]
    assert world.results(later, "merge-epic") == ["conflict"]
    # The ticket branch holds the Epic branch as it was when the first ticket landed.
    first = next(line for line in world.decisions() if line["step"] == "land" and line["ticket"] != later)
    branch = sh(world.repo, "git", "for-each-ref", "--format=%(refname:short)", f"refs/heads/feat/{later}-*")
    assert sh(world.repo, "git", "merge-base", "--is-ancestor", first["commit"], branch) == ""
    assert sh(world.epic_file(""), "git", "status", "--porcelain") == ""


def test_a_conflict_the_agent_does_not_resolve_makes_the_ticket_stuck(world: World) -> None:
    world.jira.add("DEMO-2", "Write the file one way", parent=EPIC)
    world.jira.add("DEMO-3", "Write the file another way", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"same.txt": "two"}}], "DEMO-3": [{"write": {"same.txt": "three"}}]})

    world.run()

    flagged = [key for key in ("DEMO-2", "DEMO-3") if world.jira.issues[key].flagged]
    assert len(flagged) == 1
    assert sh(world.epic_file(""), "git", "status", "--porcelain") == ""
    landed = "DEMO-3" if flagged == ["DEMO-2"] else "DEMO-2"
    assert world.epic_file("same.txt").read_text() == {"DEMO-2": "two", "DEMO-3": "three"}[landed]


def test_a_failed_merge_gate_undoes_the_merge(world: World) -> None:
    world.jira.add("DEMO-2", "Break the end to end tests", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"MERGE_FAIL": "x"}}]})

    world.run()

    assert len(world.calls("DEMO-2")) == 3
    assert world.jira.issues["DEMO-2"].flagged
    assert not any(subject.startswith("merge(DEMO-2)") for subject in world.epic_log())
    assert not world.epic_file("MERGE_FAIL").exists()


def test_a_failed_merge_gate_goes_back_to_the_session_with_the_epic_branch_merged_in(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.jira.add("DEMO-3", "Break the end to end tests", parent=EPIC)
    # A branch from before DEMO-2 lands, so the Epic branch moves on after it.
    sh(world.repo, "git", "branch", "feat/DEMO-3-early-work")
    world.plan(
        {
            "DEMO-2": [{"write": {"a.txt": "a"}}],
            "DEMO-3": [{"write": {"b.txt": "b", "MERGE_FAIL": "x"}}, {"delete": ["MERGE_FAIL"]}],
        }
    )

    assert world.run(parallel=1) == 0

    _, fix = world.calls("DEMO-3")
    assert fix["resume"] is not None
    assert "FAILED e2e/home.spec.ts" in fix["prompt"]
    assert not world.jira.issues["DEMO-3"].flagged
    assert "merge(DEMO-3): Break the end to end tests" in world.epic_log()
    assert "a.txt" in sh(world.repo, "git", "ls-tree", "--name-only", "feat/DEMO-3-early-work").split()
    assert world.results("DEMO-3", "merge-epic") == ["ok"]
    assert sh(world.epic_file(""), "git", "status", "--porcelain") == ""
    # One down with volumes is the Epic merge, which drops the database, and one is the land.
    wiped = [r for r in world.records("docker") if r["project"] == "demo-demo-3" and "--volumes" in r["args"]]
    assert len(wiped) == 2


def test_each_land_pushes_the_epic_branch(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.jira.add("DEMO-3", "Add the second part", parent=EPIC, blockers=["DEMO-2"])
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}], "DEMO-3": [{"error": "usage"}]})

    assert world.run() == 1

    branch = f"feat/{EPIC}-the-loop"
    remote = sh(world.repo, "git", "ls-remote", "--heads", "origin", branch)
    assert remote.split()[0] == sh(world.repo, "git", "rev-parse", branch)
    assert world.epic_log()[0] == "merge(DEMO-2): Add the first part"


def test_a_rejected_push_of_the_epic_branch_does_not_stop_the_loop(world: World) -> None:
    hook = world.origin / "hooks" / "pre-receive"
    hook.write_text(
        "#!/bin/sh\nwhile read old new ref; do\n"
        f'  case "$ref" in refs/heads/feat/{EPIC}-*) echo "rejected"; exit 1;; esac\ndone\n'
    )
    hook.chmod(0o755)
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}]})

    assert world.run() == 0

    assert "merge(DEMO-2): Add the first part" in world.epic_log()
    assert world.jira.issues["DEMO-2"].status == "In Review"
    steps = [(line["ticket"], line["step"], line["result"]) for line in world.decisions()]
    assert ("DEMO-2", "push", "fail") in steps


def test_the_circuit_breaker_stops_the_loop(world: World) -> None:
    for key in ("DEMO-2", "DEMO-3", "DEMO-4"):
        world.jira.add(key, f"Work {key}", parent=EPIC)
    world.plan({key: [{"status": "blocked", "reason": "setup is broken"}] for key in ("DEMO-2", "DEMO-3")})

    assert world.run(parallel=1) == 1

    assert world.calls("DEMO-4") == []
    assert world.jira.notifications[-1] == f"{EPIC} stopped"
    assert world.results(EPIC, "stop") == ["circuit-breaker"]
    assert world.prs() == [] and world.gh("pr") == []


@pytest.mark.parametrize("limit", [{"error": "usage"}, {"error": "usage", "resets_in": 3 * 24 * 3600}])
def test_a_usage_limit_with_no_reset_soon_stops_the_loop_and_a_restart_continues_the_branch(
    world: World, limit: dict[str, object]
) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [limit, {"write": {"a.txt": "a"}}]})

    assert world.run() == 1
    assert world.jira.notifications == [f"{EPIC} stopped"]
    assert world.jira.issues["DEMO-2"].status == "In Progress"
    assert not world.jira.issues["DEMO-2"].flagged

    assert world.run() == 0
    restart = world.calls("DEMO-2")[1]
    assert restart["resume"] is None
    assert world.results("DEMO-2", "start") == ["new", "restart"]
    assert "merge(DEMO-2): Add the first part" in world.epic_log()
    run_dir = world.run_dir("DEMO-2")
    assert "usage limit" in (run_dir / "agent-1.jsonl").read_text()
    assert (run_dir / "agent-2.jsonl").exists()


def test_a_usage_limit_that_resets_soon_pauses_and_resumes_the_session(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"error": "usage", "resets_in": 120}, {"write": {"a.txt": "a"}}]})

    assert world.run() == 0

    limited, resumed = world.calls("DEMO-2")[:2]
    assert resumed["resume"] is not None
    started = (world.run_dir("DEMO-2") / "agent-1.jsonl").read_text()
    assert resumed["resume"] in started
    # The wait lasts to a minute past the reset.
    (pause,) = world.records("sleeps")
    assert 170 <= pause["seconds"] <= 181
    assert world.results("DEMO-2", "agent") == ["usage-limit", "usage-pause", "done"]
    assert world.jira.notifications[0] == f"{EPIC} paused"
    assert "merge(DEMO-2): Add the first part" in world.epic_log()


def test_a_remote_branch_with_the_key_is_adopted_as_a_restart(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    sh(world.repo, "git", "switch", "-q", "-c", "feat/DEMO-2-early-work")
    (world.repo / "early.txt").write_text("early")
    sh(world.repo, "git", "add", "-A")
    sh(world.repo, "git", "commit", "-q", "-m", "feat(DEMO-2): start early")
    sh(world.repo, "git", "push", "-q", "origin", "feat/DEMO-2-early-work")
    sh(world.repo, "git", "switch", "-q", "main")
    sh(world.repo, "git", "branch", "-q", "-D", "feat/DEMO-2-early-work")
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}]})

    assert world.run() == 0

    assert world.results("DEMO-2", "start") == ["restart"]
    assert world.epic_file("early.txt").exists() and world.epic_file("a.txt").exists()


def test_a_restart_uses_no_fix_attempt(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC, status="In Progress")
    sh(world.repo, "git", "branch", "feat/DEMO-2-first-part")
    world.plan({"DEMO-2": [{"write": {"TICKET_FAIL": "x"}}]})

    world.run()

    # The build, then one fix for each of the two fix attempts.
    assert len(world.calls("DEMO-2")) == 3
    assert world.jira.issues["DEMO-2"].flagged


def test_a_stuck_ticket_that_kc_comments_on_and_unflags_lands_on_the_next_run(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    blocked = {
        "status": "blocked",
        "reason": "Which endpoint?",
        "decisions": ["Kept the old client."],
        "notes": ["Read the API docs."],
    }
    world.plan({"DEMO-2": [blocked, {"write": {"a.txt": "a"}}]})
    world.run()
    stuck = world.jira.issues["DEMO-2"]
    assert stuck.flagged
    own = list(stuck.comments)
    assert len(own) == 3
    stuck.comments += ["Use the v2 endpoint.", "Keep the old client too."]
    stuck.flagged = False

    assert world.run() == 0

    assert "merge(DEMO-2): Add the first part" in world.epic_log()
    ticket = (world.run_dir("DEMO-2") / "ticket.md").read_text()
    assert ticket.index("Use the v2 endpoint.") < ticket.index("Keep the old client too.")
    for text in ("Which endpoint?", "Kept the old client.", "Read the API docs."):
        assert any(text in comment for comment in own) and text not in ticket


def test_a_ticket_whose_comments_cannot_be_read_still_lands(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC, comments=["Use the v2 endpoint."])
    world.jira.refuse_comments = True
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}]})

    assert world.run() == 0

    assert "merge(DEMO-2): Add the first part" in world.epic_log()
    assert "Use the v2 endpoint." not in (world.run_dir("DEMO-2") / "ticket.md").read_text()
    steps = [(line["ticket"], line["step"], line["result"]) for line in world.decisions()]
    assert ("DEMO-2", "tracker-comments", "fail") in steps


def test_the_code_review_runs_in_its_own_session_and_its_findings_go_back_to_the_agent(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    finding = "a.txt:1 holds the wrong letter."
    world.plan(
        {
            "DEMO-2": [{"write": {"a.txt": "a"}}, {"write": {"a.txt": "b"}}],
            "DEMO-2-review": [{"findings": [finding]}],
        }
    )

    assert world.run() == 0

    review, again = world.calls("DEMO-2-review")
    assert review["resume"] is None and again["resume"] is None
    first, fix = world.calls("DEMO-2")
    assert fix["resume"] == world.first_session("DEMO-2") and finding in fix["prompt"]
    assert world.epic_file("a.txt").read_text() == "b"
    # The fix is a new commit, so it gets a review of its own.
    assert world.results("DEMO-2", "code-review") == ["findings", "pass"]


def test_code_review_findings_after_the_first_fix_use_fix_attempts(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    finding = "a.txt:1 holds the wrong letter."
    world.plan(
        {
            "DEMO-2": [{"write": {"a.txt": str(n)}} for n in range(4)],
            "DEMO-2-review": [{"findings": [finding]}] * 4,
        }
    )

    world.run()

    # The first round of findings is free, and the fix attempts cap the rounds after it.
    assert len(world.calls("DEMO-2-review")) == 4 and len(world.calls("DEMO-2")) == 4
    assert world.jira.issues["DEMO-2"].flagged


def test_a_commit_after_a_passed_review_gets_a_new_code_review_and_keeps_the_ui_review(world: World) -> None:
    world.jira.add("DEMO-2", "Change the home screen", parent=EPIC)
    world.plan(
        {
            "DEMO-2": [
                {"write": {"frontend/src/home.tsx": "x", "MERGE_FAIL": "x"}},
                {"delete": ["MERGE_FAIL"]},
            ],
            "DEMO-2-ui": [{"screenshot": True}],
        }
    )

    assert world.run() == 0

    assert world.results("DEMO-2", "code-review") == ["pass", "pass"]
    assert len(world.calls("DEMO-2-ui")) == 1
    assert "merge(DEMO-2): Change the home screen" in world.epic_log()


def test_a_restart_skips_the_code_review_and_passes_on_the_findings_not_yet_fixed(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    finding = "a.txt:1 holds the wrong letter."
    world.plan(
        {
            "DEMO-2": [{"write": {"a.txt": "a"}}, {"error": "usage"}],
            "DEMO-2-review": [{"findings": [finding]}],
        }
    )
    # The run stops at a usage limit during the fix of the findings.
    assert world.run() == 1

    assert world.run() == 0

    restart = world.calls("DEMO-2")[2]
    assert restart["resume"] is None and finding in restart["prompt"]
    assert restart["prompt"].startswith(f"/implement {world.run_dir('DEMO-2') / 'ticket.md'}")
    assert len(world.calls("DEMO-2-review")) == 1


def test_code_review_findings_go_back_to_the_head_session_and_use_no_fix_attempt(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC, status="In Progress")
    sh(world.repo, "git", "branch", "feat/DEMO-2-first-part")
    # The gate fails twice, which takes both fix attempts, and the review still sends its findings back.
    world.plan(
        {
            "DEMO-2": [{"write": {"a.txt": "a", "TICKET_FAIL": "x"}}, {}, {"delete": ["TICKET_FAIL"]}, {}],
            "DEMO-2-review": [{"findings": ["a.txt:1 is wrong."]}],
        }
    )

    assert world.run() == 0

    assert len(world.calls("DEMO-2")) == 4
    assert not world.jira.issues["DEMO-2"].flagged
    assert "merge(DEMO-2): Add the first part" in world.epic_log()


ACCEPTANCE = '\n[acceptance]\nlist = ["make", "acceptance-list", "ticket={key}"]\n'
SEES = [
    "Goal. A reader sees how many Products there are.",
    "What the user sees.",
    "- The count shows on Home.",
    "- A tap on the count opens the list.",
    "Technical checks.",
]


def test_a_line_of_what_the_user_sees_with_no_acceptance_test_goes_back_to_the_agent(world: World) -> None:
    world.jira.add("DEMO-2", "Show the count", parent=EPIC, body=SEES)
    one = "The count shows on Home.\n"
    both = one + "A tap on the count opens the list.\n"
    world.plan(
        {
            "DEMO-2": [
                {"write": {"count.txt": "x", "acceptance-titles.txt": one}},
                {"write": {"acceptance-titles.txt": both}},
            ]
        }
    )

    assert world.run(extra=ACCEPTANCE) == 0

    first, fix = world.calls("DEMO-2")
    assert "A tap on the count opens the list." in fix["prompt"]
    assert "The count shows on Home." not in fix["prompt"]
    listed = [call for call in world.records("make") if "acceptance-list" in call["targets"]]
    assert listed[0]["targets"] == ["acceptance-list", "ticket=DEMO-2"]
    assert not world.jira.issues["DEMO-2"].flagged


def test_with_no_acceptance_table_the_loop_lists_no_tests(world: World) -> None:
    world.jira.add("DEMO-2", "Show the count", parent=EPIC, body=SEES)
    world.plan({"DEMO-2": [{"write": {"count.txt": "x"}}]})

    assert world.run() == 0

    assert not [call for call in world.records("make") if "acceptance-list" in call["targets"]]
    assert len(world.calls("DEMO-2")) == 1


def test_the_lines_of_what_the_user_sees_come_from_the_list_under_the_heading() -> None:
    text = (
        "Goal. Read a file.\n\n**What the user sees.**\n\n- A tap opens the file.\n"
        "- The note says to download\n  the original.\n\nTechnical checks.\n\n- Not a line.\n"
    )

    assert loop_run.user_sees(text, "What the user sees") == [
        "A tap opens the file.",
        "The note says to download the original.",
    ]
    assert loop_run.user_sees("Goal. Read a file.\n", "What the user sees") == []


def test_a_gate_whose_docker_compose_run_touches_the_terminal_finishes_under_a_run_with_one(
    world: World,
) -> None:
    # Under tmux, `docker compose run` in a gate sets the terminal up. From a background process group, that
    # stops the group, and the gate never ends.
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a", "GATE_TTY": "x"}}]})

    assert world.run(terminal=True) == 0

    assert "merge(DEMO-2): Add the first part" in world.epic_log()
    runs = [record for record in world.records("docker") if record["args"][:2] == ["compose", "run"]]
    assert runs and not any(record["terminal"] for record in runs)
    assert all(record["stdin_null"] for record in world.records("make"))


def test_a_ui_change_lands_only_after_a_ui_review_and_its_screenshots_reach_the_ticket(world: World) -> None:
    world.jira.add("DEMO-2", "Change the home screen", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"frontend/src/home.tsx": "x"}}], "DEMO-2-ui": [{"screenshot": True}]})

    assert world.run() == 0

    (review,) = world.calls("DEMO-2-ui")
    assert review["run_dir"] in review["prompt"]
    assert review["resume"] is None
    assert review["no_background"] == "1" and world.calls("DEMO-2")[0]["no_background"] == "1"
    assert len(world.calls("DEMO-2")) == 1
    assert world.jira.issues["DEMO-2"].attachments == ["home-360-chromium-en.png"]


def test_a_ui_fault_goes_back_to_the_agent_and_the_fixed_commit_gets_a_new_review(world: World) -> None:
    world.jira.add("DEMO-2", "Change the home screen", parent=EPIC)
    fault = "home--intermediary--webkit-es.png shows English text."
    world.plan(
        {
            "DEMO-2": [{"write": {"frontend/src/home.tsx": "x"}}, {"write": {"frontend/src/home.tsx": "y"}}],
            "DEMO-2-ui": [{"screenshot": True, "findings": [fault]}, {"screenshot": True}],
        }
    )

    assert world.run() == 0

    fix = world.calls("DEMO-2")[1]
    assert fix["resume"] is not None and fault in fix["prompt"]
    assert len(world.calls("DEMO-2-ui")) == 2
    assert world.results("DEMO-2", "ui-gate") == ["fail", "pass"]
    assert world.calls("DEMO-2-ui-finish") == []
    (pr,) = world.prs()
    assert not pr["draft"] and "UI review left open" not in pr["body"]


def test_a_ui_fault_that_is_still_there_after_one_fix_lands_and_keeps_the_epic_pr_a_draft(
    world: World,
) -> None:
    world.jira.add("DEMO-2", "Change the home screen", parent=EPIC)
    fault = "home--intermediary--webkit-es.png shows English text."
    world.plan(
        {
            "DEMO-2": [{"write": {"frontend/src/home.tsx": "x"}}, {"write": {"frontend/src/home.tsx": "y"}}],
            "DEMO-2-ui": [
                {"screenshot": True, "findings": [fault]},
                {"screenshot": True, "findings": [fault]},
            ],
            "DEMO-2-ui-finish": [{"screenshot": True, "findings": [fault]}],
        }
    )

    assert world.run() == 0

    assert len(world.calls("DEMO-2")) == 2 and len(world.calls("DEMO-2-ui")) == 2
    gates = world.results(step="ui-gate")
    assert gates == ["fail", "open", "open"]
    assert not world.jira.issues["DEMO-2"].flagged
    assert "merge(DEMO-2): Change the home screen" in world.epic_log()
    assert fault in world.jira.issues["DEMO-2"].comments[-1]
    assert len(world.calls("DEMO-2-ui-finish")) == 1
    (pr,) = world.prs()
    assert pr["draft"]
    assert "**UI review left open:** DEMO-2 (1)." in pr["body"]
    assert fault not in pr["body"]


def test_a_part_the_ui_review_could_not_check_keeps_the_epic_pr_a_draft(world: World) -> None:
    world.jira.add("DEMO-2", "Add the upload screen", parent=EPIC)
    part = "/admin/materials: the seed has one row, not three."
    world.plan(
        {
            "DEMO-2": [{"write": {"frontend/src/upload.tsx": "x"}}],
            "DEMO-2-ui": [{"screenshot": True, "unchecked": [part]}],
        }
    )

    assert world.run() == 0

    assert f"Not checked: {part}" in world.jira.issues["DEMO-2"].comments[-1]
    create = world.records("gh")[-1]
    assert "--draft" in create["args"] and "**UI review left open:** DEMO-2 (1)." in create["body"]


def test_the_finish_reviews_an_open_ui_item_again_and_clears_it_when_the_epic_covers_it(world: World) -> None:
    world.jira.add("DEMO-2", "Add the upload screen", parent=EPIC)
    part = "/admin/materials: the seed has one row, not three."
    world.plan(
        {
            "DEMO-2": [{"write": {"frontend/src/upload.tsx": "x"}}],
            "DEMO-2-ui": [{"screenshot": True, "unchecked": [part]}],
            "DEMO-2-ui-finish": [{"screenshot": True}],
        }
    )

    assert world.run() == 0

    (review,) = world.calls("DEMO-2-ui-finish")
    assert part in review["prompt"] and review["resume"] is None
    gates = world.results(step="ui-gate")
    assert gates == ["open", "pass"]
    create = world.records("gh")[-1]
    assert "--draft" not in create["args"] and "UI review left open" not in create["body"]


def test_an_open_ui_item_that_the_finish_review_still_finds_keeps_the_epic_pr_a_draft(world: World) -> None:
    world.jira.add("DEMO-2", "Add the upload screen", parent=EPIC)
    part = "/admin/materials: the seed has one row, not three."
    world.plan(
        {
            "DEMO-2": [{"write": {"frontend/src/upload.tsx": "x"}}],
            "DEMO-2-ui": [{"screenshot": True, "unchecked": [part]}],
            "DEMO-2-ui-finish": [{"screenshot": True, "unchecked": [part]}],
        }
    )

    assert world.run() == 0

    gates = world.results(step="ui-gate")
    assert gates == ["open", "open"]
    create = world.records("gh")[-1]
    assert "--draft" in create["args"] and "**UI review left open:** DEMO-2 (1)." in create["body"]


def test_a_finish_review_that_saves_no_screenshots_keeps_the_mark(world: World) -> None:
    world.jira.add("DEMO-2", "Add the upload screen", parent=EPIC)
    part = "/admin/materials: the seed has one row, not three."
    world.plan(
        {
            "DEMO-2": [{"write": {"frontend/src/upload.tsx": "x"}}],
            "DEMO-2-ui": [{"screenshot": True, "unchecked": [part]}],
        }
    )

    assert world.run() == 0

    assert not world.jira.issues["DEMO-2"].flagged
    create = world.records("gh")[-1]
    assert "--draft" in create["args"] and "**UI review left open:** DEMO-2 (1)." in create["body"]


def test_the_open_ui_items_in_the_epic_pr_come_from_the_log(world: World) -> None:
    world.jira.add("DEMO-2", "Add the upload screen", parent=EPIC)
    part = "/admin/materials: the seed has one row, not three."
    world.plan(
        {
            "DEMO-2": [{"write": {"frontend/src/upload.tsx": "x"}}],
            "DEMO-2-ui": [{"screenshot": True, "unchecked": [part]}],
            "DEMO-3": [{"write": {"b.txt": "b"}}],
        }
    )
    assert world.run() == 0
    shutil.rmtree(world.run_dir("DEMO-2"))
    world.jira.add("DEMO-3", "Add the second part", parent=EPIC)

    assert world.run() == 0

    (pr,) = world.prs()
    assert pr["draft"] and "**UI review left open:** DEMO-2 (1)." in pr["body"]


def test_a_part_that_loop_toml_accepts_as_unchecked_is_a_note_and_the_epic_pr_is_ready(world: World) -> None:
    world.jira.add("DEMO-2", "Add the upload screen", parent=EPIC)
    part = "/admin/materials: the seed has one row, not three."
    world.plan(
        {
            "DEMO-2": [{"write": {"frontend/src/upload.tsx": "x"}}],
            "DEMO-2-ui": [{"screenshot": True, "unchecked": [part]}],
        }
    )

    assert world.run(ui_extra='accepted_unchecked = ["the seed has one row"]') == 0

    assert f"Not checked, and accepted in loop.toml: {part}" in world.jira.issues["DEMO-2"].comments[-1]
    create = world.records("gh")[-1]
    assert "--draft" not in create["args"] and "UI review left open" not in create["body"]


def test_a_ui_review_that_saves_no_screenshots_makes_the_ticket_stuck(world: World) -> None:
    world.jira.add("DEMO-2", "Change the home screen", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"frontend/src/home.tsx": "x"}}]})

    world.run()

    assert world.jira.issues["DEMO-2"].flagged
    assert "saved no screenshots" in world.jira.issues["DEMO-2"].comments[0]


def test_a_restart_keeps_the_screenshots_of_the_same_commit(world: World) -> None:
    world.jira.add("DEMO-2", "Change the home screen", parent=EPIC)
    world.plan(
        {
            "DEMO-2": [{"write": {"frontend/src/home.tsx": "x"}}, {"error": "usage"}],
            "DEMO-2-ui": [{"screenshot": True}],
        }
    )
    # The merge gate fails for a reason outside the code, and the ticket run stops at a usage limit.
    (world.fakes / "merge-gate-fails").touch()
    assert world.run() == 1
    (world.fakes / "merge-gate-fails").unlink()

    assert world.run() == 0

    assert len(world.calls("DEMO-2-ui")) == 1
    assert world.jira.issues["DEMO-2"].attachments == ["home-360-chromium-en.png"]


def test_a_later_commit_that_changes_ui_code_gets_a_new_ui_review(world: World) -> None:
    world.jira.add("DEMO-2", "Change the home screen", parent=EPIC)
    world.plan(
        {
            "DEMO-2": [
                {"write": {"frontend/src/home.tsx": "x", "MERGE_FAIL": "x"}},
                {"write": {"frontend/src/home.tsx": "y"}, "delete": ["MERGE_FAIL"]},
            ],
            "DEMO-2-ui": [{"screenshot": True}, {"screenshot": True}],
        }
    )

    assert world.run() == 0

    assert len(world.calls("DEMO-2-ui")) == 2


def test_a_change_to_a_frontend_test_file_needs_no_screenshots(world: World) -> None:
    world.jira.add("DEMO-2", "Test the home screen", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"frontend/src/home.test.tsx": "x"}}]})

    assert world.run() == 0

    assert len(world.calls("DEMO-2")) == 1


def test_the_finish_runs_no_review_and_opens_the_epic_pr(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}]})

    assert world.run() == 0

    assert [call["name"] for call in world.calls()] == ["DEMO-2", "DEMO-2-review", f"{EPIC}-pr"]
    (pr,) = world.prs()
    assert not pr["draft"] and pr["title"] == f"feat({EPIC}): the Loop"
    assert "| DEMO-2 | Landed |" in pr["body"]
    assert world.jira.notifications == [f"{EPIC} pr-open"]
    remote = sh(world.repo, "git", "ls-remote", "--heads", "origin", f"feat/{EPIC}-the-loop")
    assert remote


def test_an_agent_writes_the_epic_pr_body_with_the_pr_skill(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    body = "## Summary\n\nThe first part.\n"
    world.plan(
        {
            "DEMO-2": [{"write": {"a.txt": "a"}}],
            f"{EPIC}-pr": [{"pr_body": body}],
        }
    )
    (world.fakes / "merge-gate-fails-after").write_text("1")

    assert world.run() == 0

    write = world.calls(f"{EPIC}-pr")[-1]
    assert "| DEMO-2 | Landed |" in write["prompt"]
    create = world.records("gh")[-1]
    assert create["body"].startswith("**Failing gate:** `make check`")
    assert create["body"].endswith(body)


def push_branch(world: World, branch: str, name: str) -> None:
    sh(world.repo, "git", "switch", "-q", "-c", branch)
    (world.repo / name).write_text(name)
    sh(world.repo, "git", "add", "-A")
    sh(world.repo, "git", "commit", "-q", "-m", f"feat: add {name}")
    sh(world.repo, "git", "push", "-q", "origin", branch)
    sh(world.repo, "git", "switch", "-q", "main")
    sh(world.repo, "git", "branch", "-q", "-D", branch)


def test_a_done_ticket_whose_work_never_landed_is_reported(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.jira.add("DEMO-3", "Done too early", parent=EPIC, status="Done")
    world.jira.add("DEMO-4", "Squash merged", parent=EPIC, status="Done")
    push_branch(world, "feat/DEMO-3-early", "lost.txt")
    push_branch(world, "feat/DEMO-4-squashed", "kept.txt")
    (world.repo / "kept.txt").write_text("kept.txt")
    sh(world.repo, "git", "add", "-A")
    sh(world.repo, "git", "commit", "-q", "-m", "feat(DEMO-4): squash merge")
    sh(world.repo, "git", "push", "-q", "origin", "main")
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}]})

    assert world.run() == 0

    assert "DEMO-3 done-not-landed" in world.jira.notifications
    (pr,) = world.prs()
    assert pr["draft"] and pr["body"].startswith("**Unfinished tickets:** DEMO-3.")
    assert "| DEMO-3 | Done in the tracker, not landed |" in pr["body"]
    assert "| DEMO-4 | Done before this run |" in pr["body"]


def test_the_decisions_and_notes_of_an_agent_go_to_jira_and_not_to_the_epic_pr(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    notes = ["Kept the filter in access.py."]
    step = {"write": {"a.txt": "a"}, "decisions": ["Which filter?"], "notes": notes}
    world.plan({"DEMO-2": [step]})

    assert world.run() == 0

    comments = world.jira.issues["DEMO-2"].comments
    assert any("Which filter?" in text for text in comments)
    assert any("Kept the filter in access.py." in text for text in comments)
    create = world.records("gh")[-1]
    assert "--draft" not in create["args"]
    assert "Which filter?" not in create["body"] and "Kept the filter" not in create["body"]
    assert "Decisions to check" not in create["body"]


def test_with_name_landed_keys_only_the_epic_pr_names_no_key_that_did_not_land(world: World) -> None:
    world.jira.add("DEMO-2", "Needs a decision", parent=EPIC)
    world.jira.add("DEMO-3", "Builds on the decision", parent=EPIC, blockers=["DEMO-2"])
    world.jira.add("DEMO-4", "Separate work", parent=EPIC)
    world.jira.add("DEMO-5", "Done before", parent=EPIC, status="Done")
    blocked = {"status": "blocked", "reason": "Which role?", "decisions": ["Kept the role."]}
    world.plan({"DEMO-2": [blocked], "DEMO-4": [{"write": {"d.txt": "d"}}]})

    assert world.run(landed_keys_only=True) == 0

    body = world.records("gh")[-1]["body"]
    assert "| DEMO-4 | Landed |" in body and "| Needs a decision | Stuck |" in body
    assert (
        "| Builds on the decision | Not built |" in body and "| Done before | Done before this run |" in body
    )
    assert "Kept the role." not in body
    assert not {"DEMO-2", "DEMO-3", "DEMO-5"} & set(re.findall(r"DEMO-\d+", body))


def test_the_epic_pr_is_a_draft_when_a_gate_still_fails(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan(
        {
            "DEMO-2": [{"write": {"a.txt": "a"}}],
        }
    )
    (world.fakes / "merge-gate-fails-after").write_text("1")

    assert world.run() == 0

    create = world.records("gh")[-1]
    assert "--draft" in create["args"]
    assert create["body"].startswith("**Failing gate:** `make check`")
    assert world.jira.notifications == [f"{EPIC} pr-draft"]


DEMO = '\n[demo]\ncommand = ["make", "demo", "branch={branch}"]\nurl = "https://demo.example.ts.net"\n'


def test_the_finish_points_the_demo_at_the_epic_branch_and_the_epic_pr_starts_with_its_address(
    world: World,
) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}]})

    assert world.run(extra=DEMO) == 0

    demo = [call for call in world.records("make") if call["targets"][0] == "demo"]
    assert [(call["targets"], call["cwd"]) for call in demo] == [
        (["demo", f"branch=feat/{EPIC}-the-loop"], str(world.state / EPIC / "worktrees" / EPIC))
    ]
    create = world.records("gh")[-1]
    assert "--draft" not in create["args"]
    assert create["body"].startswith("**Demo:** https://demo.example.ts.net\n\n")
    steps = [(line["step"], line["result"]) for line in world.decisions() if line["step"] == "demo"]
    assert steps == [("demo", "ok")]


def test_a_failed_demo_command_makes_the_epic_pr_a_draft_and_names_its_log(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}]})
    (world.fakes / "demo-fails").write_text("")

    assert world.run(extra=DEMO) == 0

    log = world.run_dir(EPIC) / "finish-demo.log"
    assert "the demo did not start" in log.read_text()
    create = world.records("gh")[-1]
    assert "--draft" in create["args"]
    assert create["body"].startswith(
        f"**Demo failed:** `make demo branch=feat/{EPIC}-the-loop`. The log is `{log}`.\n"
    )
    assert "**Demo:**" not in create["body"]
    assert world.jira.notifications == [f"{EPIC} pr-draft"]


def test_without_a_demo_table_the_finish_runs_no_demo(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}]})

    assert world.run() == 0

    assert not [call for call in world.records("make") if call["targets"][0] == "demo"]
    assert "Demo" not in world.records("gh")[-1]["body"]
    assert not [line for line in world.decisions() if line["step"] == "demo"]


def test_an_epic_with_nothing_landed_opens_no_pr(world: World) -> None:
    world.jira.add("DEMO-2", "Done before", parent=EPIC, status="Done")

    assert world.run() == 1

    assert world.prs() == [] and world.gh("pr") == []
    assert world.jira.notifications == [f"{EPIC} stopped"]


@pytest.mark.parametrize(("error", "code"), [("crash", 139), ("mid-turn", 1)])
def test_a_failed_agent_run_still_pushes_its_commits_and_the_comment_names_the_log(
    world: World, error: str, code: int
) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}, "error": error}]})

    world.run()

    comment = world.jira.issues["DEMO-2"].comments[0]
    assert f"code {code}" in comment and "agent-1.err" in comment
    branch = "feat/DEMO-2-add-the-first-part"
    pushed = sh(world.repo, "git", "ls-remote", "--heads", "origin", branch)
    assert pushed.split()[0] == sh(world.repo, "git", "rev-parse", branch)


def test_the_agent_logs_fill_while_the_agent_runs(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}, "peek": True}]})

    assert world.run() == 0

    seen = json.loads((world.fakes / "peek.json").read_text())
    assert '"subtype": "init"' in seen["agent-1.jsonl"]
    assert "Starting the MCP servers" in seen["agent-1.err"]


def test_a_status_before_a_later_turn_with_none_still_counts(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}, "late_turn": True}]})

    assert world.run() == 0

    assert "merge(DEMO-2): Add the first part" in world.epic_log()
    assert not world.jira.issues["DEMO-2"].flagged


def test_a_session_that_keeps_running_after_its_status_is_stopped_and_the_run_goes_on(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}, "child": True, "linger": 60}]})

    started = time.monotonic()
    assert world.run() == 0
    assert ended(world.fakes / "agent-child.pid")

    assert time.monotonic() - started < 30
    assert "merge(DEMO-2): Add the first part" in world.epic_log()
    assert not world.jira.issues["DEMO-2"].flagged
    stopped = [line for line in world.decisions() if line["step"] == "agent" and line["result"] == "stopped"]
    (line,) = stopped
    assert line["session"]


def test_an_agent_past_its_limit_stops_with_its_processes_and_its_stack(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_MINUTE_SECONDS", "1")
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}, "child": True, "stall": 60}]})

    world.run(limits_extra="agent_timeout_minutes = 1")

    assert ended(world.fakes / "agent-child.pid")
    assert world.results("DEMO-2", "agent") == ["timeout"]
    assert world.jira.issues["DEMO-2"].flagged
    downs = [r["project"] for r in world.records("docker") if r["args"][:2] == ["compose", "down"]]
    assert "demo-demo-2" in downs


def ended(pid_file: Path) -> bool:
    """Whether the process of the pid file has ended within two seconds."""
    pid = int(pid_file.read_text())
    for _ in range(20):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.1)
    return False


def test_a_merge_that_fails_its_gate_never_reaches_the_frontier(world: World) -> None:
    world.jira.add("DEMO-2", "Break the end to end tests", parent=EPIC)
    world.jira.add("DEMO-3", "Build on the broken work", parent=EPIC, blockers=["DEMO-2"])
    world.plan({"DEMO-2": [{"write": {"MERGE_FAIL": "x"}}]})

    world.run()

    assert world.calls("DEMO-3") == []


def test_an_open_epic_pr_gets_the_new_body_and_draft_state(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan(
        {
            "DEMO-2": [{"write": {"a.txt": "a"}}],
        }
    )
    (world.fakes / "merge-gate-fails-after").write_text("1")
    url = "https://github.com/kcgbarbosa/demo/pull/98"
    opened = {"url": url, "head": f"feat/{EPIC}-the-loop", "base": "main", "title": "", "body": "Old."}
    (world.fakes / "prs.json").write_text(json.dumps([{**opened, "draft": False, "state": "open"}]))

    assert world.run() == 0

    assert world.gh("pr", "create") == []
    (pr,) = world.prs()
    assert pr["url"] == url and pr["draft"] and pr["body"].startswith("**Failing gate:**")
    assert world.jira.notifications == [f"{EPIC} pr-draft"]


def test_a_rerun_of_a_finished_epic_builds_only_the_new_ticket_and_edits_the_open_pr(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}], "DEMO-3": [{"write": {"b.txt": "b"}}]})
    assert world.run() == 0
    world.jira.add("DEMO-3", "Add the second part", parent=EPIC)

    assert world.run() == 0

    assert len(world.calls("DEMO-2")) == 1 and len(world.calls("DEMO-3")) == 1
    merges = [subject for subject in world.epic_log() if subject.startswith("merge(")]
    assert merges == ["merge(DEMO-3): Add the second part", "merge(DEMO-2): Add the first part"]
    creates = world.gh("pr", "create")
    edits = world.gh("pr", "edit")
    assert len(creates) == 1 and len(edits) == 1
    (pr,) = world.prs()
    assert not pr["draft"] and "| DEMO-3 | Landed |" in pr["body"]


def test_each_agent_line_logs_the_cost_from_the_last_result(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}, "late_turn": True}]})

    assert world.run() == 0

    agent_lines = [line for line in world.decisions() if line["step"] == "agent"]
    assert agent_lines and all(line["usage"]["total_cost_usd"] for line in agent_lines)
    ticket = next(line for line in agent_lines if line["ticket"] == "DEMO-2")
    assert ticket["usage"] == {
        "peak_context": 0,
        "total_cost_usd": 0.75,
        "num_turns": 4,
        "duration_ms": 4000,
        "subagents": {"runner": 1},
        "models": {
            "claude-opus-5-5": {"inputTokens": 10, "outputTokens": 20, "costUSD": 0.74},
            "claude-sonnet-5-5": {
                "inputTokens": 30,
                "outputTokens": 40,
                "costUSD": 0.01,
                "costBasis": "list",
            },
        },
    }


def test_the_head_agent_runs_on_the_agent_table_in_every_session(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    # A remote branch with the key makes the first run a restart. The gate fails once, so a fix resumes it.
    sh(world.repo, "git", "switch", "-q", "-c", "feat/DEMO-2-add-the-first-part")
    (world.repo / "b.txt").write_text("b")
    sh(world.repo, "git", "add", "-A")
    sh(world.repo, "git", "commit", "-q", "-m", "feat(DEMO-2): start")
    sh(world.repo, "git", "push", "-q", "origin", "feat/DEMO-2-add-the-first-part")
    sh(world.repo, "git", "switch", "-q", "main")
    sh(world.repo, "git", "branch", "-q", "-D", "feat/DEMO-2-add-the-first-part")
    world.plan({"DEMO-2": [{"write": {"a.txt": "a", "TICKET_FAIL": "x"}}, {"delete": ["TICKET_FAIL"]}]})

    assert world.run(extra='\n[agent]\nmodel = "claude-sonnet-5-5"\neffort = "low"\n') == 0

    restart, fix = world.calls("DEMO-2")
    assert world.results("DEMO-2", "start") == ["restart"] and fix["resume"] is not None
    for call in (restart, fix, *world.calls(f"{EPIC}-pr")):
        assert (call["model"], call["effort"]) == ("claude-sonnet-5-5", "low")
    (review,) = world.calls("DEMO-2-review")
    assert (review["model"], review["effort"]) == (REVIEW_MODEL, REVIEW_EFFORT)
    start = next(line for line in world.decisions() if line["ticket"] == EPIC and line["step"] == "start")
    assert start["setup"]["agent"] == "claude-sonnet-5-5 low"


def test_each_agent_line_logs_the_plan_meter_and_the_peak_context(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    five, seven = 1791267000, 1791554400
    meter = [
        {"five_hour": [0.14, five], "seven_day": [0.80, seven]},
        {"five_hour": [0.30, five], "seven_day": [0.82, seven]},
        {"five_hour": [0.55, five]},
    ]
    messages = [
        {"id": "m1", "context": [2, 30_000, 8_000], "blocks": 2},
        {"id": "m2", "context": [2, 90_000, 1_000], "blocks": 3},
        # A subagent's context is not the head agent's.
        {"id": "m3", "context": [2, 400_000, 0], "parent": "t1"},
    ]
    world.plan(
        {
            "DEMO-2": [{"write": {"a.txt": "a"}, "rate_limits": meter, "messages": messages}],
            "DEMO-2-review": [{"rate_limits": [{"five_hour": [0.60, five]}]}],
        }
    )

    assert world.run() == 0

    agent_lines = [line for line in world.decisions() if line["step"] == "agent"]
    ticket = next(line for line in agent_lines if line["ticket"] == "DEMO-2")
    assert ticket["plan"] == {
        "five_hour": {"start": 0.14, "end": 0.55, "resets_at": five},
        "seven_day": {"start": 0.80, "end": 0.82, "resets_at": seven},
    }
    assert ticket["usage"]["peak_context"] == 91_002
    review = next(line for line in agent_lines if line["ticket"] == "DEMO-2-review")
    assert review["plan"] == {"five_hour": {"start": 0.60, "end": 0.60, "resets_at": five}}
    pr = next(line for line in agent_lines if line["ticket"] == f"{EPIC}-pr")
    assert pr["plan"] == {} and pr["usage"]["peak_context"] == 0


def test_a_run_stopped_at_a_usage_limit_still_logs_its_plan_meter(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    meter = [{"five_hour": [0.90, 1791267000]}, {"five_hour": [1.0, 1791267000]}]
    world.plan({"DEMO-2": [{"rate_limits": meter, "error": "usage"}]})

    assert world.run() == 1

    (limited,) = [line for line in world.decisions() if line["step"] == "agent"]
    assert limited["result"] == "usage-limit" and "usage limit" in limited["detail"]
    assert limited["plan"] == {"five_hour": {"start": 0.90, "end": 1.0, "resets_at": 1791267000}}


def test_the_start_line_keeps_what_the_agents_run_on(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}]})

    assert world.run() == 0

    start = next(line for line in world.decisions() if line["ticket"] == EPIC and line["step"] == "start")
    assert start["setup"] == {
        "claude": "2.1.301",
        "agent": "claude-opus-5-5 high",
        "context": 200_000,
        "tiers": {name: f"{tier['model']} {tier['effort']}" for name, tier in tiers.load().items()},
        "review": f"{REVIEW_MODEL} {REVIEW_EFFORT}",
    }


def test_the_loop_removes_the_trial_worktrees_that_a_ticket_run_left(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    trials = [{"name": "failed"}, {"name": "running", "locked": True}, {"name": "other", "from_main": True}]
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}, "trials": trials}]})

    assert world.run() == 0

    folder = world.repo / ".claude" / "worktrees"
    assert sorted(path.name for path in folder.iterdir()) == ["agent-other", "agent-running"]
    branches = sh(world.repo, "git", "branch", "--list", "worktree-agent-*", "--format=%(refname:short)")
    assert branches.split() == ["worktree-agent-other", "worktree-agent-running"]
    removed = next(line for line in world.decisions() if line["step"] == "trials")
    assert removed["ticket"] == "DEMO-2" and removed["detail"].endswith("agent-failed")


def test_an_epic_stacked_on_a_branch_starts_from_it_and_opens_its_pr_against_it(world: World) -> None:
    world.push_branch("feat/DEMO-0-before", {"before.txt": "before"})
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}]})

    assert world.run(base="feat/DEMO-0-before") == 0

    assert world.epic_file("before.txt").read_text() == "before"
    create = world.records("gh")[-1]
    assert create["args"][create["args"].index("--base") + 1] == "feat/DEMO-0-before"


def test_a_fix_to_the_base_branch_is_merged_into_the_stacked_epic_and_keeps_its_work(world: World) -> None:
    world.push_branch("feat/DEMO-0-before", {"before.txt": "before"})
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}]})
    world.run(base="feat/DEMO-0-before")
    world.push_branch("feat/DEMO-0-before", {"before.txt": "fixed"}, start="origin/feat/DEMO-0-before")

    assert world.run(base="feat/DEMO-0-before") == 0

    assert world.epic_file("before.txt").read_text() == "fixed"
    assert world.epic_file("a.txt").read_text() == "a"
    assert any(line["step"] == "base" and line["result"] == "merged" for line in world.decisions())


def test_a_base_branch_that_does_not_merge_stops_the_run_and_leaves_the_branch_as_it_was(
    world: World,
) -> None:
    world.push_branch("feat/DEMO-0-before", {"before.txt": "before"})
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"before.txt": "ours"}}]})
    world.run(base="feat/DEMO-0-before")
    world.push_branch("feat/DEMO-0-before", {"before.txt": "theirs"}, start="origin/feat/DEMO-0-before")

    assert world.run(base="feat/DEMO-0-before") == 1

    assert world.epic_file("before.txt").read_text() == "ours"
    assert sh(world.epic_file("."), "git", "status", "--porcelain") == ""
    assert ("base", "conflict") in [(line["step"], line["result"]) for line in world.decisions()]


def test_a_base_branch_that_is_gone_stops_the_run(world: World) -> None:
    assert world.run(base="feat/DEMO-0-gone") == 1

    assert ("base", "missing") in [(line["step"], line["result"]) for line in world.decisions()]
