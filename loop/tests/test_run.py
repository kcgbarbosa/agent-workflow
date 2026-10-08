"""Full runs of the loop. Each test checks what KC can see: git, Jira, the notifications, and the log."""

from __future__ import annotations

import json
import os
import re
import shutil
import time
from pathlib import Path

import pytest
from conftest import EPIC, World, sh

from loop.run import AGENTS, DISPATCH, RESTART_PROMPT


def test_the_frontier_runs_blockers_first_and_lands_each_ticket(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.jira.add("DEMO-3", "Add the second part", parent=EPIC, blockers=["DEMO-2"])
    world.jira.add("DEMO-9", "Outside work that is open")
    world.jira.add("DEMO-4", "Wait on outside work", parent=EPIC, blockers=["DEMO-9"])
    world.jira.add("DEMO-5", "Done before", parent=EPIC, status="Done")
    world.jira.add("DEMO-6", "Waits for KC", parent=EPIC, flagged=True)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}], "DEMO-3": [{"write": {"b.txt": "b"}}]})

    assert world.run() == 0

    assert {call["name"] for call in world.calls()} == {"DEMO-2", "DEMO-3", f"{EPIC}-review"}
    merges = [subject for subject in world.epic_log() if subject.startswith("merge(")]
    assert merges == ["merge(DEMO-3): Add the second part", "merge(DEMO-2): Add the first part"]
    steps = [(line["ticket"], line["step"], line["result"]) for line in world.decisions()]
    assert steps.index(("DEMO-2", "land", "landed")) < steps.index(("DEMO-3", "start", "new"))
    assert world.jira.issues["DEMO-2"].statuses == ["In Progress", "In Review"]
    assert world.jira.issues["DEMO-4"].statuses == []


def test_each_agent_gets_the_ticket_file_the_secrets_and_its_own_stack(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}]})

    world.run()

    call = world.calls("DEMO-2")[0]
    ticket_file = call["prompt"].removeprefix("/implement ")
    ticket = open(ticket_file).read()
    assert "Add the first part" in ticket
    assert "`make lint test`. Make it pass before you return done." in ticket
    assert call["secret"] == "secret-token"
    assert call["bw_session"] is None
    assert call["db_port"] != "55432"
    assert call["schema"]["properties"]["status"]["enum"] == ["done", "blocked"]
    gates = [(record["targets"], record["project"]) for record in world.records("make")]
    assert (["lint", "test"], "demo-demo-2") in gates
    assert (["check"], "demo-demo-1") in gates
    land = next(line for line in world.decisions() if line["step"] == "land")
    assert land["ticket"] == "DEMO-2" and land["commit"]


def test_a_failed_ticket_gate_goes_back_to_the_session_with_the_log_tail(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a", "TICKET_FAIL": "x"}}, {"delete": ["TICKET_FAIL"]}]})

    assert world.run() == 0

    first, fix = world.calls("DEMO-2")
    assert fix["resume"] is not None
    assert "FAILED tests/test_ticket.py" in fix["prompt"]
    assert "merge(DEMO-2): Add the first part" in world.epic_log()


def test_a_gate_that_still_fails_after_the_fix_attempts_makes_the_ticket_stuck(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.jira.add("DEMO-3", "Add the second part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"TICKET_FAIL": "x"}}], "DEMO-3": [{"write": {"b.txt": "b"}}]})

    world.run()

    assert len(world.calls("DEMO-2")) == 3
    assert world.jira.issues["DEMO-2"].flagged
    assert "ticket gate `make lint test` failed" in world.jira.issues["DEMO-2"].comments[0]


def test_a_gate_past_its_limit_fails_and_its_child_processes_stop(
    world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The gates get one second in place of the minutes in loop.toml.
    real = shutil.which("timeout")
    assert real
    shim = tmp_path / "shim"
    shim.mkdir()
    (shim / "timeout").write_text(
        f'#!/bin/sh\nkill_after=$1 limit=$2\nshift 2\n[ "$1" = make ] && limit=1s\n'
        f'exec {real} "$kill_after" "$limit" "$@"\n'
    )
    (shim / "timeout").chmod(0o755)
    monkeypatch.setenv("PATH", f"{shim}:{os.environ['PATH']}")
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a", "GATE_HANG": "x"}}, {"delete": ["GATE_HANG"]}]})

    assert world.run() == 0

    _, fix = world.calls("DEMO-2")
    assert "The gate ran past 60 minutes." in fix["prompt"]
    assert "merge(DEMO-2): Add the first part" in world.epic_log()
    # The gate's child process would mark that it survived two seconds after it started.
    time.sleep(2)
    assert not (world.fakes / "gate-child-survived").exists()


def test_a_stuck_ticket_is_flagged_and_the_tickets_downstream_wait(world: World) -> None:
    world.jira.add("DEMO-2", "Needs a decision", parent=EPIC)
    world.jira.add("DEMO-3", "Builds on the decision", parent=EPIC, blockers=["DEMO-2"])
    world.jira.add("DEMO-4", "Separate work", parent=EPIC)
    world.plan(
        {
            "DEMO-2": [{"status": "blocked", "reason": "The WorkOS role change needs KC."}],
            "DEMO-4": [{"write": {"d.txt": "d"}}],
        }
    )

    assert world.run() == 0

    stuck = world.jira.issues["DEMO-2"]
    assert stuck.flagged
    assert "The WorkOS role change needs KC." in stuck.comments[0]
    assert str(world.state / EPIC / "runs" / "DEMO-2") in stuck.comments[0]
    assert "DEMO-2 stuck" in world.jira.notifications
    assert world.calls("DEMO-3") == []
    assert "merge(DEMO-4): Separate work" in world.epic_log()
    body = world.records("gh")[-1]["body"]
    assert "| DEMO-2 | Stuck |" in body and "| DEMO-3 | Not built |" in body


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
    assert world.records("gh") == []


def test_a_usage_limit_stops_the_loop_and_a_restart_continues_the_branch(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"error": "usage"}, {"write": {"a.txt": "a"}}]})

    assert world.run() == 1
    assert world.jira.notifications == [f"{EPIC} stopped"]
    assert world.jira.issues["DEMO-2"].status == "In Progress"
    assert not world.jira.issues["DEMO-2"].flagged

    assert world.run() == 0
    restart = world.calls("DEMO-2")[1]
    assert restart["resume"] is None
    assert restart["prompt"].endswith(RESTART_PROMPT)
    assert "merge(DEMO-2): Add the first part" in world.epic_log()
    run_dir = world.state / EPIC / "runs" / "DEMO-2"
    assert "usage limit" in (run_dir / "agent-1.jsonl").read_text()
    assert (run_dir / "agent-2.jsonl").exists()


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

    assert world.calls("DEMO-2")[0]["prompt"].endswith(RESTART_PROMPT)
    assert world.epic_file("early.txt").exists() and world.epic_file("a.txt").exists()


def test_a_restart_counts_as_a_fix_attempt(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC, status="In Progress")
    sh(world.repo, "git", "branch", "feat/DEMO-2-first-part")
    world.plan({"DEMO-2": [{"write": {"TICKET_FAIL": "x"}}]})

    world.run()

    assert len(world.calls("DEMO-2")) == 2
    assert world.jira.issues["DEMO-2"].flagged


def test_the_comments_on_a_stuck_ticket_reach_the_restarted_agent(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    blocked = {"status": "blocked", "reason": "Which endpoint?", "decisions": ["Kept the old client."]}
    world.plan({"DEMO-2": [blocked, {"write": {"a.txt": "a"}}]})
    world.run()
    stuck = world.jira.issues["DEMO-2"]
    stuck.comments += ["Use the v2 endpoint.", "Keep the old client too."]
    stuck.flagged = False

    assert world.run() == 0

    ticket = (world.state / EPIC / "runs" / "DEMO-2" / "ticket.md").read_text()
    comments = ticket.split("## Comments\n")[1].split("## Loop\n")[0]
    assert comments.index("Use the v2 endpoint.") < comments.index("Keep the old client too.")
    assert "The loop stopped" not in comments and "decisions for KC" not in comments


def test_a_ticket_whose_comments_cannot_be_read_still_lands(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC, comments=["Use the v2 endpoint."])
    world.jira.refuse_comments = True
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}]})

    assert world.run() == 0

    assert "merge(DEMO-2): Add the first part" in world.epic_log()
    assert "## Comments" not in (world.state / EPIC / "runs" / "DEMO-2" / "ticket.md").read_text()
    steps = [(line["ticket"], line["step"], line["result"]) for line in world.decisions()]
    assert ("DEMO-2", "tracker-comments", "fail") in steps


def test_a_ui_change_lands_only_with_screenshots_and_they_reach_the_ticket(world: World) -> None:
    world.jira.add("DEMO-2", "Change the home screen", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"frontend/src/home.tsx": "x"}}, {"screenshot": True}]})

    assert world.run() == 0

    review = world.calls("DEMO-2")[1]
    assert "ui-review" in review["prompt"] and review["run_dir"] in review["prompt"]
    assert world.jira.issues["DEMO-2"].attachments == ["home-360-chromium-en.png"]


def test_a_change_to_a_frontend_test_file_needs_no_screenshots(world: World) -> None:
    world.jira.add("DEMO-2", "Test the home screen", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"frontend/src/home.test.tsx": "x"}}]})

    assert world.run() == 0

    assert len(world.calls("DEMO-2")) == 1


def test_the_finish_reviews_the_epic_and_opens_the_epic_pr(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}], f"{EPIC}-review": [{}, {"write": {"fix.txt": "fix"}}]})

    assert world.run() == 0

    review, fix, _ = world.calls(f"{EPIC}-review")
    assert review["prompt"].startswith("/code-review ")
    epic_ticket = world.state / EPIC / "runs" / EPIC / "ticket.md"
    assert str(epic_ticket) in review["prompt"]
    assert "`make check`. Make it pass before you return done." in epic_ticket.read_text()
    assert fix["resume"] is not None
    create = world.records("gh")[-1]
    assert create["args"][:2] == ["pr", "create"] and "--draft" not in create["args"]
    assert f"feat({EPIC}): the Loop" in create["args"]
    assert "| DEMO-2 | Landed |" in create["body"]
    assert world.jira.notifications == [f"{EPIC} pr-open"]
    remote = sh(world.repo, "git", "ls-remote", "--heads", "origin", f"feat/{EPIC}-the-loop")
    assert remote
    assert world.epic_file("fix.txt").exists()


def test_an_agent_writes_the_epic_pr_body_with_the_pr_skill(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    body = "## Summary\n\nThe first part.\n"
    world.plan(
        {
            "DEMO-2": [{"write": {"a.txt": "a"}}],
            f"{EPIC}-review": [{}, {"write": {"MERGE_FAIL": "x"}}, {"pr_body": body}],
        }
    )

    assert world.run() == 0

    write = world.calls(f"{EPIC}-review")[-1]
    assert write["prompt"].startswith("/pr ") and "| DEMO-2 | Landed |" in write["prompt"]
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
    body = world.records("gh")[-1]["body"]
    assert "| DEMO-3 | Done in the tracker, not landed |" in body
    assert "| DEMO-4 | Done before this run |" in body


def test_the_decisions_of_an_agent_go_to_jira_and_the_epic_pr(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}, "decisions": ["Kept the filter in access.py."]}]})

    assert world.run() == 0

    assert "Kept the filter in access.py." in world.jira.issues["DEMO-2"].comments[-1]
    assert "DEMO-2: Kept the filter in access.py." in world.records("gh")[-1]["body"]


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
    assert "- Needs a decision: Kept the role." in body
    assert not {"DEMO-2", "DEMO-3", "DEMO-5"} & set(re.findall(r"DEMO-\d+", body))
    assert "Name no ticket key" in world.calls(f"{EPIC}-review")[-1]["prompt"]


def test_the_epic_pr_is_a_draft_when_a_gate_still_fails(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan(
        {"DEMO-2": [{"write": {"a.txt": "a"}}], f"{EPIC}-review": [{}, {"write": {"MERGE_FAIL": "x"}}]}
    )

    assert world.run() == 0

    create = world.records("gh")[-1]
    assert "--draft" in create["args"]
    assert create["body"].startswith("**Failing gate:** `make check`")
    assert world.jira.notifications == [f"{EPIC} pr-draft"]


def test_changes_the_review_fix_leaves_uncommitted_make_the_epic_pr_a_draft(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan(
        {"DEMO-2": [{"write": {"a.txt": "a"}}], f"{EPIC}-review": [{}, {"uncommitted": {"fix.txt": "fix"}}]}
    )

    assert world.run() == 0

    create = world.records("gh")[-1]
    assert "--draft" in create["args"]
    assert create["body"].startswith("**Failing gate:** `git status --porcelain`")
    assert world.jira.notifications == [f"{EPIC} pr-draft"]
    assert world.epic_file("fix.txt").read_text() == "fix"


def test_an_epic_with_nothing_landed_opens_no_pr(world: World) -> None:
    world.jira.add("DEMO-2", "Done before", parent=EPIC, status="Done")

    assert world.run() == 1

    assert world.records("gh") == []
    assert world.jira.notifications == [f"{EPIC} stopped"]


def test_a_failed_agent_run_still_pushes_its_commits_and_the_comment_names_the_log(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}, "error": "crash"}]})

    world.run()

    comment = world.jira.issues["DEMO-2"].comments[0]
    assert "exited with code 139" in comment and "agent-1.err" in comment
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


def test_a_merge_that_fails_its_gate_never_reaches_the_frontier(world: World) -> None:
    world.jira.add("DEMO-2", "Break the end to end tests", parent=EPIC)
    world.jira.add("DEMO-3", "Build on the broken work", parent=EPIC, blockers=["DEMO-2"])
    world.plan({"DEMO-2": [{"write": {"MERGE_FAIL": "x"}}]})

    world.run()

    assert world.calls("DEMO-3") == []


def test_an_open_epic_pr_gets_the_new_body_and_draft_state(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan(
        {"DEMO-2": [{"write": {"a.txt": "a"}}], f"{EPIC}-review": [{}, {"write": {"MERGE_FAIL": "x"}}]}
    )
    (world.fakes / "pr-exists").touch()

    assert world.run() == 0

    calls = [record["args"] for record in world.records("gh")]
    assert not any(args[:2] == ["pr", "create"] for args in calls)
    assert any(args[:3] == ["pr", "edit", "https://github.com/kcgbarbosa/demo/pull/98"] for args in calls)
    assert next(args for args in calls if args[:2] == ["pr", "ready"])[-1] == "--undo"
    assert world.jira.notifications == [f"{EPIC} pr-draft"]


def test_each_agent_gets_the_project_mcp_servers(world: World) -> None:
    (world.repo / ".mcp.json").write_text('{"mcpServers": {}}\n')
    sh(world.repo, "git", "add", "-A")
    sh(world.repo, "git", "commit", "-q", "-m", "chore: add the MCP servers")
    sh(world.repo, "git", "push", "-q", "origin", "main")
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}}]})

    world.run()

    call = world.calls("DEMO-2")[0]
    assert call["mcp_config"] == f"{call['cwd']}/.mcp.json"


def test_every_agent_run_gets_the_subagent_tiers_and_the_dispatch_rule(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a", "TICKET_FAIL": "x"}}, {"delete": ["TICKET_FAIL"]}]})

    assert world.run() == 0

    calls = world.calls()
    # The ticket run, its fix run, and the review, fix, and PR body runs of the finish.
    assert [call["name"] for call in calls] == ["DEMO-2", "DEMO-2", *[f"{EPIC}-review"] * 3]
    assert {call["agents"] for call in calls} == {str(AGENTS)}
    assert {call["system_prompt"] for call in calls} == {DISPATCH.read_text()}


def test_each_agent_line_logs_the_cost_from_the_last_result(world: World) -> None:
    world.jira.add("DEMO-2", "Add the first part", parent=EPIC)
    world.plan({"DEMO-2": [{"write": {"a.txt": "a"}, "late_turn": True}]})

    assert world.run() == 0

    agent_lines = [line for line in world.decisions() if line["step"] == "agent"]
    assert agent_lines and all(line["usage"]["total_cost_usd"] for line in agent_lines)
    ticket = next(line for line in agent_lines if line["ticket"] == "DEMO-2")
    assert ticket["usage"] == {
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
