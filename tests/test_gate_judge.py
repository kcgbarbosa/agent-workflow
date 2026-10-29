"""The gate's UI judge asks once per changed screenshot, blocks only on the repo's list, and collects minor verdicts."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fake_github import FakeGitHub

JUDGE = Path(__file__).resolve().parents[1] / "actions" / "judge" / "judge.py"
INPUTS = {"SCREENSHOTS": "screenshot-diff", "JUDGE_MODEL": "claude-opus-5-5", "JUDGE_EFFORT": "low"}


def answer(verdict: str, sentence: str) -> str:
    return json.dumps({"type": "result", "result": json.dumps({"verdict": verdict, "sentence": sentence})})


@pytest.fixture
def pr(tmp_path: Path) -> FakeGitHub:
    fake = FakeGitHub(tmp_path)
    fake.commit({"loop.toml": '[ui]\nblocking = ["text cut off", "broken layout"]\n'})
    return fake


def changed_step(pr: FakeGitHub, name: str) -> None:
    step = pr.work / "screenshot-diff" / name
    step.mkdir(parents=True)
    for image in ("baseline.png", "new.png", "diff.png"):
        (step / image).write_bytes(b"png")
    (step / "step.json").write_text(json.dumps({"line": f"The {name} screen shows the title.", "path": f"e2e/shots/{name}.png"}))


def test_no_changed_screenshot_runs_no_model(pr: FakeGitHub) -> None:
    run = pr.run(JUDGE, **INPUTS)

    assert run.returncode == 0, run.stderr
    assert pr.claude_calls == []
    assert pr.state["calls"] == []


def test_a_blocking_verdict_fails_and_comments_the_step_the_sentence_and_both_images(pr: FakeGitHub) -> None:
    for name in ("1-home", "2-login", "3-list"):
        changed_step(pr, name)
    pr.reply(answer("blocking", "The title is cut off."), answer("minor", "The button moved."), answer("fine", "As asked."))

    run = pr.run(JUDGE, **INPUTS)

    assert run.returncode == 1
    calls = pr.claude_calls
    assert len(calls) == 3
    assert all("--tools" in c["argv"] and c["argv"][c["argv"].index("--tools") + 1] == "" for c in calls)
    assert all(c["argv"][c["argv"].index("--max-turns") + 1] == "1" for c in calls)
    message = json.loads(calls[0]["stdin"])["message"]["content"]
    assert "text cut off; broken layout" in message[0]["text"]
    assert "The 1-home screen shows the title." in message[0]["text"]
    assert [part["type"] for part in message].count("image") == 3
    blocking, minor = pr.state["comments"]
    assert "### 1-home\n\nThe title is cut off." in blocking["body"]
    assert f"kc/app/blob/{pr.env['BASE_SHA']}/e2e/shots/1-home.png?raw=true" in blocking["body"]
    assert f"kc/app/blob/{pr.env['HEAD_SHA']}/e2e/shots/1-home.png?raw=true" in blocking["body"]
    assert "- [ ] **2-login**: The button moved." in minor["body"]
    assert "3-list" not in blocking["body"] + minor["body"]


def test_minor_verdicts_stay_in_one_checklist_comment(pr: FakeGitHub) -> None:
    changed_step(pr, "1-home")
    pr.reply(answer("minor", "The button moved."))
    assert pr.run(JUDGE, **INPUTS).returncode == 0

    pr.reply(answer("minor", "The button moved left."))
    assert pr.run(JUDGE, **INPUTS).returncode == 0

    [comment] = pr.state["comments"]
    assert "The button moved left." in comment["body"]


def test_an_answer_out_of_shape_fails(pr: FakeGitHub) -> None:
    changed_step(pr, "1-home")
    pr.reply(json.dumps({"type": "result", "result": "It looks fine to me."}))

    run = pr.run(JUDGE, **INPUTS)

    assert run.returncode == 1
    assert "no verdict for 1-home" in run.stderr
