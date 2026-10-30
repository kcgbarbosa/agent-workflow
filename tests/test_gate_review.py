"""The gate's review posts one pull request review, fails on a blocking finding, and runs no model when it has nothing to review."""

from __future__ import annotations

from pathlib import Path

import pytest
from fake_github import FakeGitHub

REVIEW = Path(__file__).resolve().parents[1] / "actions" / "review" / "review.py"
INPUTS = {"REVIEW_MODEL": "claude-opus-5-5", "REVIEW_EFFORT": "high", "REVIEW_SKIP": "*.md docs/* *.lock"}


def result(*findings: dict, cost: float | None = 0.4237) -> dict:
    output: dict = {"type": "result", "structured_output": {"findings": list(findings)}}
    if cost is not None:
        output["total_cost_usd"] = cost
    return output


def finding(path: str, line: int, severity: str, sentence: str) -> dict:
    return {"path": path, "line": line, "severity": severity, "sentence": sentence}


@pytest.fixture
def pr(tmp_path: Path) -> FakeGitHub:
    fake = FakeGitHub(tmp_path)
    fake.commit({"a.py": "one\ntwo\nthree\n"})
    return fake


def test_a_blocking_finding_posts_one_review_at_its_line_and_fails(pr: FakeGitHub) -> None:
    pr.reply(result(finding("a.py", 2, "blocking", "Two is wrong."), finding("a.py", 40, "minor", "Far away.")))

    run = pr.run(REVIEW, **INPUTS)

    assert run.returncode == 1, run.stderr
    [review] = pr.state["reviews"]
    assert review["event"] == "REQUEST_CHANGES"
    assert review["commit_id"] == pr.env["HEAD_SHA"]
    assert review["comments"] == [{"path": "a.py", "line": 2, "side": "RIGHT", "body": "**blocking**: Two is wrong."}]
    assert "`a.py:40` **minor**: Far away." in review["body"]
    assert review["body"].splitlines()[-1] == "review api cost: $0.42"
    [call] = pr.claude_calls
    assert call["argv"][call["argv"].index("--model") + 1] == "claude-opus-5-5"
    assert "code-review skill" in call["argv"][call["argv"].index("-p") + 1]


def test_minor_findings_pass_and_an_unreported_cost_is_unknown(pr: FakeGitHub) -> None:
    pr.reply(result(finding("a.py", 3, "minor", "Name it."), cost=None))

    run = pr.run(REVIEW, **INPUTS)

    assert run.returncode == 0, run.stderr
    [review] = pr.state["reviews"]
    assert review["event"] == "COMMENT"
    assert review["body"].splitlines()[-1] == "review api cost: unknown"


def test_a_later_push_reviews_only_the_commits_since_the_last_review(pr: FakeGitHub) -> None:
    first = pr.env["HEAD_SHA"]
    pr.reply(result(finding("a.py", 2, "blocking", "Two is wrong.")))
    assert pr.run(REVIEW, **INPUTS).returncode == 1

    pr.commit({"a.py": "one\n2\nthree\n"})
    pr.reply(result())
    run = pr.run(REVIEW, **INPUTS)

    assert run.returncode == 0, run.stderr
    prompt = pr.claude_calls[1]["argv"][pr.claude_calls[1]["argv"].index("-p") + 1]
    assert f"The fixed point is {first}" in prompt
    assert "earlier-review.json" in prompt
    assert [r["state"] for r in pr.state["reviews"]] == ["DISMISSED", "COMMENTED"]


def test_a_rerun_at_the_reviewed_commit_keeps_the_verdict_with_no_model_run(pr: FakeGitHub) -> None:
    pr.reply(result(finding("a.py", 2, "blocking", "Two is wrong.")))
    assert pr.run(REVIEW, **INPUTS).returncode == 1

    run = pr.run(REVIEW, **INPUTS)

    assert run.returncode == 1
    assert len(pr.claude_calls) == 1


def test_a_pull_request_of_skip_paths_only_runs_no_model(tmp_path: Path) -> None:
    fake = FakeGitHub(tmp_path)
    fake.commit({"README.md": "# app\nMore.\n", "uv.lock": "x\n", "docs/a.txt": "a\n"})

    run = fake.run(REVIEW, **INPUTS)

    assert run.returncode == 0, run.stderr
    assert fake.claude_calls == []
    assert fake.state["reviews"] == []


def base_with(tmp_path: Path, loop_toml: str) -> FakeGitHub:
    fake = FakeGitHub(tmp_path, base={"loop.toml": loop_toml})
    fake.commit({"a.py": "one\ntwo\nthree\n"})
    return fake


def test_a_review_turned_off_in_loop_toml_runs_no_model(tmp_path: Path) -> None:
    pr = base_with(tmp_path, "[review]\nenabled = false\n")

    run = pr.run(REVIEW, **INPUTS)

    assert run.returncode == 0, run.stderr
    assert pr.claude_calls == []
    assert pr.state["calls"] == []


def test_a_pull_request_cannot_turn_off_its_own_review(pr: FakeGitHub) -> None:
    pr.commit({"loop.toml": "[review]\nenabled = false\n"})
    pr.reply(result())

    assert pr.run(REVIEW, **INPUTS).returncode == 0
    assert len(pr.claude_calls) == 1


def test_loop_toml_overrides_the_model_and_the_skip_paths(tmp_path: Path) -> None:
    pr = base_with(tmp_path, '[review]\nskip = ["*.py"]\n')
    assert pr.run(REVIEW, **INPUTS).returncode == 0
    assert pr.claude_calls == []

    pr = base_with(tmp_path / "second", '[review]\nmodel = "claude-sonnet-5-5"\n')
    pr.reply(result())
    assert pr.run(REVIEW, **INPUTS).returncode == 0
    argv = pr.claude_calls[0]["argv"]
    assert argv[argv.index("--model") + 1] == "claude-sonnet-5-5"


def update_branch(pr: FakeGitHub, files: dict[str, str]) -> None:
    """A new commit on main, merged into the pull request's branch, as GitHub's "Update branch" does."""
    pr.git("checkout", "-q", "main")
    pr.env["BASE_SHA"] = pr.commit(files)
    pr.git("checkout", "-q", "feature")
    pr.git("merge", "-q", "--no-edit", "main")


def test_a_later_push_after_a_merge_of_main_reviews_only_the_pull_requests_commits(pr: FakeGitHub) -> None:
    pr.reply(result(finding("a.py", 2, "blocking", "Two is wrong.")))
    assert pr.run(REVIEW, **INPUTS).returncode == 1
    update_branch(pr, {"b.py": "from main\n"})
    pr.commit({"a.py": "one\n2\nthree\n"})
    pr.reply(result())

    run = pr.run(REVIEW, **INPUTS)

    assert run.returncode == 0, run.stderr
    prompt = pr.claude_calls[1]["argv"][pr.claude_calls[1]["argv"].index("-p") + 1]
    since = prompt.split("The fixed point is ")[1].split(",")[0]
    assert f"`git diff {since} HEAD`, with two dots" in prompt
    assert pr.git("diff", "--name-only", since, "HEAD") == "a.py"
    assert pr.git("log", "--format=%s", "--no-merges", f"{since}..HEAD") == "change"


def test_a_merge_of_main_does_not_count_against_the_skip_paths(pr: FakeGitHub) -> None:
    pr.reply(result(finding("a.py", 2, "blocking", "Two is wrong.")))
    assert pr.run(REVIEW, **INPUTS).returncode == 1
    update_branch(pr, {"b.py": "from main\n"})
    pr.commit({"README.md": "# app\nFixed.\n"})

    run = pr.run(REVIEW, **INPUTS)

    assert run.returncode == 1
    assert len(pr.claude_calls) == 1


def test_a_model_answer_with_no_findings_list_exits_out_of_shape(pr: FakeGitHub) -> None:
    pr.reply({"type": "result", "result": "null"})

    run = pr.run(REVIEW, **INPUTS)

    assert run.returncode == 1
    assert "no list of findings" in run.stderr
    assert pr.state["reviews"] == []


def test_a_model_answer_in_prose_exits_with_the_text_and_how_the_run_ended(pr: FakeGitHub) -> None:
    pr.reply({"type": "result", "subtype": "error_max_turns", "num_turns": 40, "result": "I reviewed the change and found nothing."})

    run = pr.run(REVIEW, **INPUTS)

    assert run.returncode == 1
    assert "returned text in place of the findings" in run.stderr
    assert "subtype 'error_max_turns' after 40 turns" in run.stderr
    assert "I reviewed the change" in run.stderr
    assert pr.state["reviews"] == []


def test_the_review_runs_on_an_api_key_with_no_plan_token(pr: FakeGitHub) -> None:
    pr.reply(result(finding("a.py", 3, "minor", "Name it.")))

    run = pr.run(REVIEW, **INPUTS, CLAUDE_CODE_OAUTH_TOKEN="", ANTHROPIC_API_KEY="key")

    assert run.returncode == 0, run.stderr
    [call] = pr.claude_calls
    assert call["api_key"] == "key"
