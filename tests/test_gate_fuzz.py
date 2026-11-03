"""The gate's fuzz job keeps a finding whose reproduction fails again on the head, tells a new one from a pre-existing one
on the base, posts one review comment, and fails only on a new finding while `blocking` is on."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
import yaml
from fake_github import FakeGitHub

ROOT = Path(__file__).resolve().parents[1]
FUZZ = ROOT / "actions" / "fuzz" / "fuzz.py"
GATE = ROOT / ".github" / "workflows" / "gate.yml"
ACTION_STEPS = yaml.safe_load((ROOT / "actions" / "fuzz" / "action.yml").read_text())["runs"]["steps"]
INPUTS = {"FUZZ_MODEL": "claude-opus-5-5", "FUZZ_EFFORT": "high", "FUZZ_SKIP": "*.md docs/* *.lock"}

# Each reproduction reads a.py, which is "one" on the base and "one two three" on the head.
REPROS = {
    # Fails on the head only, so it is new.
    "test_new.py": 'assert "two" not in open("a.py").read(), "two is in a.py"\n',
    # Fails the same way on both, so it is pre-existing.
    "test_old.py": 'assert "four" in open("a.py").read(), "four is missing"\n',
    # Fails on both, with another output on the base, so it is new.
    "test_differs.py": 'import sys\nprint("lines:", open("a.py").read().count("\\n"))\nsys.exit(1)\n',
    # Passes on the rerun, so it is dropped.
    "test_pass.py": "pass\n",
}


def finding(name: str, title: str) -> dict:
    return {
        "title": title,
        "command": f"{sys.executable} {name}",
        "reproduction": name,
        "output": "it failed",
        "breaks": f"{title} breaks the ticket.",
    }


def result(*findings: dict) -> dict:
    return {"type": "result", "structured_output": {"findings": list(findings)}, "total_cost_usd": 1.5}


def fuzz_pr(tmp_path: Path, loop_toml: str | None = None) -> FakeGitHub:
    fake = FakeGitHub(tmp_path, base={"loop.toml": loop_toml} if loop_toml is not None else None)
    fake.commit({"a.py": "one\ntwo\nthree\n"})
    # The adversaries leave the reproduction of each verified finding in the checkout.
    for name, text in REPROS.items():
        (fake.work / name).write_text(text)
    return fake


def body(pr: FakeGitHub) -> str:
    review = json.loads((pr.root / "fuzz-review.json").read_text())
    assert review["event"] == "COMMENT"
    assert review["commit_id"] == pr.env["HEAD_SHA"]
    return review["body"]


def test_a_new_finding_fails_the_job_and_a_pre_existing_one_is_listed_apart(tmp_path: Path) -> None:
    pr = fuzz_pr(tmp_path)
    pr.reply(
        result(
            finding("test_new.py", "Two shows up"),
            finding("test_old.py", "Four is missing"),
            finding("test_pass.py", "A flake"),
            finding("test_gone.py", "A lost file"),
        )
    )

    run = pr.run(FUZZ, **INPUTS)

    assert run.returncode == 1, run.stderr
    assert "::error::gate / fuzz: 1 new findings survived a rerun" in run.stdout
    text = body(pr)
    assert text.startswith(f"<!-- gate fuzz head={pr.env['HEAD_SHA']} findings=2 -->\n**gate / fuzz** of ")
    assert ": 1 new, 1 pre-existing, 2 dropped." in text
    new, old = text.split("### New findings")[1].split("### Pre-existing findings")
    assert "#### 1. Two shows up" in new
    assert f"```sh\n{sys.executable} test_new.py\n```" in new
    assert "AssertionError: two is in a.py" in new
    assert "<details><summary>The reproduction, <code>test_new.py</code></summary>" in new
    assert REPROS["test_new.py"].strip() in new
    assert "#### 2. Four is missing" in old
    assert "fails the same way on the base, so it fails nothing" in old
    assert "Four is missing" not in new
    assert "- A flake: `" in text and "passed on the rerun." in text
    assert "- A lost file: its reproduction `test_gone.py` is not in the checkout." in text
    assert text.splitlines()[-1] == "fuzz api cost: $1.50"
    # The checkout is back at the head, with the reproductions in it.
    assert pr.git("rev-parse", "HEAD") == pr.env["HEAD_SHA"]
    assert (pr.work / "a.py").read_text() == "one\ntwo\nthree\n"
    assert (pr.work / "test_new.py").read_text() == REPROS["test_new.py"]


def test_a_finding_whose_base_run_differs_is_new(tmp_path: Path) -> None:
    pr = fuzz_pr(tmp_path)
    pr.reply(result(finding("test_differs.py", "The line count")))

    run = pr.run(FUZZ, **INPUTS)

    assert run.returncode == 1, run.stderr
    text = body(pr)
    assert "1 new, 0 pre-existing" in text
    assert "lines: 3" in text.split("### New findings")[1]


def test_pre_existing_findings_alone_pass(tmp_path: Path) -> None:
    pr = fuzz_pr(tmp_path)
    pr.reply(result(finding("test_old.py", "Four is missing")))

    run = pr.run(FUZZ, **INPUTS)

    assert run.returncode == 0, run.stderr
    text = body(pr)
    assert "findings=1 -->" in text
    assert "### New findings" not in text
    assert "### Pre-existing findings" in text


def test_no_findings_post_a_comment_and_pass(tmp_path: Path) -> None:
    pr = fuzz_pr(tmp_path)
    pr.reply(result())

    run = pr.run(FUZZ, **INPUTS)

    assert run.returncode == 0, run.stderr
    assert body(pr).startswith(f"<!-- gate fuzz head={pr.env['HEAD_SHA']} findings=0 -->")


def test_with_blocking_off_the_job_posts_the_findings_and_passes(tmp_path: Path) -> None:
    pr = fuzz_pr(tmp_path, "[fuzz]\nblocking = false\n")
    pr.reply(result(finding("test_new.py", "Two shows up")))

    run = pr.run(FUZZ, **INPUTS)

    assert run.returncode == 0, run.stderr
    text = body(pr)
    assert "#### 1. Two shows up" in text
    assert "`[fuzz] blocking` is off, so the job passes." in text


def test_setup_runs_first_and_the_adversaries_get_no_github_token(tmp_path: Path) -> None:
    setup = '["bash", "-c", "echo setup >> order.log"]'
    pr = fuzz_pr(tmp_path, f"[fuzz]\nadversaries = 5\nmodel = \"claude-sonnet-5-5\"\nsetup = {setup}\n")
    (pr.work / "test_new.py").write_text('open("order.log", "a").write("repro\\n")\nraise SystemExit(1)\n')
    pr.reply(result(finding("test_new.py", "Two shows up")))

    run = pr.run(FUZZ, **INPUTS)

    # The reproduction fails the same way on the base, so it is pre-existing and fails nothing.
    assert run.returncode == 0, run.stderr
    # The setup runs again on the base, before the base run.
    assert (pr.work / "order.log").read_text() == "setup\nrepro\nsetup\nrepro\n"
    [call] = pr.claude_calls
    argv = call["argv"]
    text = argv[argv.index("-p") + 1]
    assert text.startswith("/interrogate the change of pull request #7")
    assert "Spawn 5 adversaries." in text
    assert "the stack is up and seeded" in text
    assert str(tmp_path / "pull-request.md") in text
    assert (tmp_path / "pull-request.md").read_text() == "# AW-9: add a\n\nTicket text\n"
    assert argv[argv.index("--model") + 1] == "claude-sonnet-5-5"
    assert "Bash(gh:*)" in argv[argv.index("--disallowedTools") :]
    assert call["gh_token"] is None


def test_a_reproduction_runs_with_no_token_and_cannot_post_to_the_pull_request(tmp_path: Path) -> None:
    pr = fuzz_pr(tmp_path)
    post = 'import json, subprocess\nsubprocess.run(["gh", "api", "-X", "POST", "repos/kc/app/pulls/7/reviews", "--input", "-"], input=json.dumps({"commit_id": "x", "event": "COMMENT", "body": "by the reproduction"}), text=True)\n'
    log = 'import os\nopen(os.environ["TOKEN_LOG"], "a").write(repr([os.environ.get(k) for k in ("GH_TOKEN", "GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN")]) + "\\n")\n'
    (pr.work / "test_token.py").write_text(log + post + "raise SystemExit(1)\n")
    pr.reply(result(finding("test_token.py", "A break")))

    run = pr.run(FUZZ, TOKEN_LOG=str(tmp_path / "token.log"), **INPUTS)

    assert run.returncode == 0, run.stderr
    # Once on the head and once on the base.
    assert (tmp_path / "token.log").read_text() == "[None, None, None]\n" * 2
    assert "pre-existing" in body(pr)
    # The job holds no token, so the reproduction's post fails, and fuzz.py posts nothing itself.
    assert pr.state["reviews"] == []


def test_the_head_rerun_drops_an_adversary_edit_left_in_the_checkout(tmp_path: Path) -> None:
    pr = fuzz_pr(tmp_path)
    # One adversary edits a.py and leaves the edit, and another's reproduction trips on it.
    (pr.work / "a.py").write_text("one\ntwo\nthree\nBROKEN\n")
    (pr.work / "test_broken.py").write_text('assert "BROKEN" not in open("a.py").read(), "BROKEN is in a.py"\n')
    pr.reply(result(finding("test_broken.py", "Broken")))

    run = pr.run(FUZZ, **INPUTS)

    assert run.returncode == 0, run.stdout
    assert ": 0 new, 0 pre-existing, 1 dropped." in body(pr)
    assert (pr.work / "a.py").read_text() == "one\ntwo\nthree\n"


def test_a_pytest_finding_with_a_numbered_temp_path_matches_on_the_base(tmp_path: Path) -> None:
    pr = fuzz_pr(tmp_path)
    (pr.work / "test_four.py").write_text('def test_four(tmp_path):\n    assert (tmp_path / "four").exists(), "four is missing"\n')
    command = f"{sys.executable} -m pytest -q -p no:cacheprovider test_four.py"
    pr.reply(result({**finding("test_four.py", "Four is missing"), "command": command}))

    run = pr.run(FUZZ, PYTEST_DEBUG_TEMPROOT=str(tmp_path), **INPUTS)

    assert run.returncode == 0, run.stdout
    assert ": 0 new, 1 pre-existing, 0 dropped." in body(pr)


def test_the_base_run_meets_a_stack_that_the_setup_brought_up_from_the_base(tmp_path: Path) -> None:
    # The stack serves a.py as it was when the setup brought it up.
    pr = fuzz_pr(tmp_path, '[fuzz]\nsetup = ["bash", "-c", "cp a.py served.txt"]\n')
    (pr.work / "test_served.py").write_text('assert "two" not in open("served.txt").read(), "two is served"\n')
    pr.reply(result(finding("test_served.py", "Two is served")))

    run = pr.run(FUZZ, **INPUTS)

    assert run.returncode == 1, run.stdout
    assert ": 1 new, 0 pre-existing, 0 dropped." in body(pr)


def test_a_setup_that_fails_on_the_base_makes_each_finding_new(tmp_path: Path) -> None:
    pr = fuzz_pr(tmp_path, '[fuzz]\nsetup = ["bash", "-c", "grep -q two a.py"]\n')
    pr.reply(result(finding("test_old.py", "Four is missing")))

    run = pr.run(FUZZ, **INPUTS)

    assert run.returncode == 1, run.stdout
    assert ": 1 new, 0 pre-existing, 0 dropped." in body(pr)


def test_a_finding_whose_clock_time_and_shares_differ_on_the_base_is_pre_existing(tmp_path: Path) -> None:
    pr = fuzz_pr(tmp_path)
    # Each run prints its own clock time and, from its pid, its own shares.
    clock = (
        "import datetime, os\n"
        'print(" Start at", datetime.datetime.now().strftime("%H:%M:%S"))\n'
        'print(" Duration 3.61s (tests %d%%, import 1%%)" % (os.getpid() % 90 + 1))\n'
        'raise SystemExit("four is missing")\n'
    )
    (pr.work / "test_clock.py").write_text(clock)
    pr.reply(result(finding("test_clock.py", "Four is missing")))

    run = pr.run(FUZZ, **INPUTS)

    assert run.returncode == 0, run.stdout
    assert ": 0 new, 1 pre-existing, 0 dropped." in body(pr)


def test_the_pull_request_cannot_turn_off_its_own_fuzz(tmp_path: Path) -> None:
    pr = fuzz_pr(tmp_path)
    pr.commit({"loop.toml": "[fuzz]\nenabled = false\n"})
    pr.reply(result())

    run = pr.run(FUZZ, **INPUTS)

    assert run.returncode == 0, run.stderr
    assert len(pr.claude_calls) == 1


def test_the_base_can_turn_it_off(tmp_path: Path) -> None:
    pr = fuzz_pr(tmp_path, "[fuzz]\nenabled = false\n")

    run = pr.run(FUZZ, **INPUTS)

    assert run.returncode == 0, run.stderr
    assert "gate / fuzz: off" in run.stdout
    assert pr.claude_calls == []
    assert not (pr.root / "fuzz-review.json").exists()


def test_an_old_review_table_warns_and_is_ignored(tmp_path: Path) -> None:
    pr = fuzz_pr(tmp_path, "[review]\nenabled = false\n")
    pr.reply(result())

    run = pr.run(FUZZ, **INPUTS)

    assert run.returncode == 0, run.stderr
    assert "::warning::loop.toml [review] is no longer read" in run.stdout
    assert len(pr.claude_calls) == 1


@pytest.mark.parametrize("env", [{"CLAUDE_CODE_OAUTH_TOKEN": ""}, {}], ids=["no token", "skip paths only"])
def test_no_model_runs_with_no_token_or_only_skip_paths(tmp_path: Path, env: dict[str, str]) -> None:
    pr = FakeGitHub(tmp_path)
    pr.commit({"a.py": "one\ntwo\n"} if env else {"docs/notes.md": "notes\n"})

    run = pr.run(FUZZ, **INPUTS, **env)

    assert run.returncode == 0, run.stderr
    assert pr.claude_calls == []
    assert not (pr.root / "fuzz-review.json").exists()


def test_the_gate_runs_fuzz_beside_the_check_and_skips_it_on_a_docs_only_pull_request() -> None:
    jobs = yaml.safe_load(GATE.read_text())["jobs"]
    assert "review" not in jobs
    fuzz = jobs["fuzz"]
    assert fuzz["needs"] == "paths"
    assert "needs.paths.outputs.docs-only != 'true'" in fuzz["if"]
    # The job that runs the adversaries holds no token that can write, and no step of it reads one.
    assert fuzz["permissions"] == {"contents": "read"}
    assert "github.token" not in yaml.safe_dump(fuzz)
    assert all("TOKEN" not in name or name == "CLAUDE_CODE_OAUTH_TOKEN" for step in ACTION_STEPS for name in step.get("env", {}))
    [action] = [step for step in fuzz["steps"] if step.get("uses") == "./.gate/actions/fuzz"]
    assert action["with"]["check_env"] == "${{ secrets.CHECK_ENV }}"
    assert all(step["with"]["persist-credentials"] is False for step in fuzz["steps"] if step.get("uses", "").startswith("actions/checkout"))
    assert any(step.get("uses", "").startswith("jdx/mise-action") for step in fuzz["steps"])
    [upload] = [step for step in fuzz["steps"] if step.get("uses", "").startswith("actions/upload-artifact")]
    assert upload["if"] == "${{ !cancelled() }}"
    # The report job posts the review with the write token, and checks out and runs nothing of the pull request.
    report = jobs["fuzz-report"]
    assert report["needs"] == "fuzz"
    assert report["permissions"] == {"pull-requests": "write"}
    assert not [step for step in report["steps"] if step.get("uses", "").startswith("actions/checkout")]
    [post] = [step for step in report["steps"] if "run" in step]
    assert "pulls/$PR_NUMBER/reviews" in post["run"]
