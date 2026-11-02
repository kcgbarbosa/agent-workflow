"""The gate's UI judge asks once per changed screenshot and once per batch of rated ones, blocks only on the repo's list, and collects minor verdicts."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fake_github import FakeGitHub

JUDGE = Path(__file__).resolve().parents[1] / "actions" / "judge" / "judge.py"
INPUTS = {"SCREENSHOTS": "screenshot-diff", "JUDGE_MODEL": "claude-opus-5-5", "JUDGE_EFFORT": "low"}


def answer(verdict: str, sentence: str, fault: str | None = None) -> str:
    reply = {"verdict": verdict, "sentence": sentence} | ({"fault": fault} if fault else {})
    return json.dumps({"type": "result", "result": json.dumps(reply)})


def batch(*verdicts: tuple[str, ...]) -> str:
    """One answer for a batch of rated steps: (step, verdict, sentence) or (step, verdict, sentence, fault)."""
    reply = {step: {"verdict": verdict, "sentence": sentence} | ({"fault": rest[0]} if rest else {}) for step, verdict, sentence, *rest in verdicts}
    return json.dumps({"type": "result", "result": json.dumps(reply)})


def content(call: dict) -> list[dict]:
    return json.loads(call["stdin"])["message"]["content"]


def call_for(pr: FakeGitHub, text: str) -> list[dict]:
    """The calls run at once, so a test finds its call by what the prompt holds."""
    [found] = [content(c) for c in pr.claude_calls if text in c["stdin"]]
    return found


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
    pr.reply_to({"The 1-home screen": answer("blocking", "The title is cut off.", "Text cut off"), "The 2-login screen": answer("minor", "The button moved."), "The 3-list screen": answer("fine", "As asked.")})

    run = pr.run(JUDGE, **INPUTS)

    assert run.returncode == 1
    calls = pr.claude_calls
    assert len(calls) == 3
    assert all("--tools" in c["argv"] and c["argv"][c["argv"].index("--tools") + 1] == "" for c in calls)
    assert all(c["argv"][c["argv"].index("--max-turns") + 1] == "1" for c in calls)
    message = call_for(pr, "The 1-home screen")
    assert "text cut off; broken layout" in message[0]["text"]
    assert "The 1-home screen shows the title." in message[0]["text"]
    assert [part["type"] for part in message].count("image") == 3
    blocking, minor = pr.state["comments"]
    assert "### 1-home\n\nThe title is cut off." in blocking["body"]
    assert f"kc/app/blob/{pr.env['BASE_SHA']}/e2e/shots/1-home.png?raw=true" in blocking["body"]
    assert f"kc/app/blob/{pr.env['HEAD_SHA']}/e2e/shots/1-home.png?raw=true" in blocking["body"]
    assert "- [ ] **2-login**: The button moved." in minor["body"]
    assert "3-list" not in blocking["body"] + minor["body"]


def test_each_verdict_keeps_one_comment_and_a_cleared_one_says_so(pr: FakeGitHub) -> None:
    changed_step(pr, "1-home")
    changed_step(pr, "2-login")
    pr.reply_to({"The 1-home screen": answer("blocking", "The title is cut off.", "text cut off"), "The 2-login screen": answer("minor", "The button moved.")})
    assert pr.run(JUDGE, **INPUTS).returncode == 1

    pr.reply_to({"The 1-home screen": answer("blocking", "The title is still cut off.", "text cut off"), "The 2-login screen": answer("minor", "The button moved left.")})
    assert pr.run(JUDGE, **INPUTS).returncode == 1
    blocking, minor = pr.state["comments"]
    assert "The title is still cut off." in blocking["body"]
    assert "The button moved left." in minor["body"]

    pr.reply(answer("fine", "As asked."), answer("fine", "As asked."))
    assert pr.run(JUDGE, **INPUTS).returncode == 0
    blocking, minor = pr.state["comments"]
    assert "nothing blocks at" in blocking["body"]
    assert "no minor changes at" in minor["body"]


def test_a_fault_off_the_blocking_list_is_minor(pr: FakeGitHub) -> None:
    changed_step(pr, "1-home")
    changed_step(pr, "2-login")
    pr.reply_to({"The 1-home screen": answer("blocking", "The colour changed.", "wrong colour"), "The 2-login screen": answer("blocking", "No fault named.")})

    run = pr.run(JUDGE, **INPUTS)

    assert run.returncode == 0, run.stderr
    [minor] = pr.state["comments"]
    assert "- [ ] **1-home**: The colour changed. (Not on the blocking list.)" in minor["body"]
    assert "- [ ] **2-login**: No fault named." in minor["body"]


def test_an_answer_out_of_shape_fails(pr: FakeGitHub) -> None:
    changed_step(pr, "1-home")
    pr.reply(json.dumps({"type": "result", "result": "It looks fine to me."}))

    run = pr.run(JUDGE, **INPUTS)

    assert run.returncode == 1
    assert "no verdict for 1-home" in run.stderr


def rated_step(pr: FakeGitHub, name: str) -> None:
    step = pr.work / "screenshot-diff" / name
    step.mkdir(parents=True)
    (step / "new.png").write_bytes(b"png")
    (step / "step.json").write_text(json.dumps({"line": f"The {name} screen shows the title.", "path": f"e2e/shots/{name}.png"}))


def test_a_step_with_no_baseline_is_rated_on_its_one_image_and_can_block(pr: FakeGitHub) -> None:
    rated_step(pr, "1-home")
    changed_step(pr, "2-login")
    pr.reply_to({"Step 1-home.": batch(("1-home", "blocking", "The title is cut off.", "text cut off")), "The 2-login screen": answer("minor", "The button moved.")})

    run = pr.run(JUDGE, **INPUTS)

    assert run.returncode == 1, run.stderr
    rated, changed = call_for(pr, "Step 1-home."), call_for(pr, "The 2-login screen")
    assert [part["type"] for part in rated].count("image") == 1
    assert "no baseline" in rated[0]["text"]
    assert "shows one of these faults: text cut off; broken layout" in rated[0]["text"]
    assert "Step 1-home. Its ticket line: The 1-home screen shows the title." in rated[1]["text"]
    assert all("change" not in part.get("text", "") for part in rated)
    assert [part["type"] for part in changed].count("image") == 3
    blocking, minor = pr.state["comments"]
    assert "### 1-home\n\nThe title is cut off." in blocking["body"]
    assert f"kc/app/blob/{pr.env['BASE_SHA']}/" not in blocking["body"]
    assert blocking["body"].count(f"kc/app/blob/{pr.env['HEAD_SHA']}/e2e/shots/1-home.png?raw=true") == 1
    assert "- [ ] **2-login**: The button moved." in minor["body"]


def flat_pair(pr: FakeGitHub, name: str, path: str | None = None) -> None:
    folder = pr.work / "screenshot-diff"
    folder.mkdir(exist_ok=True)
    (folder / f"{name}.png").write_bytes(b"png")
    (folder / f"{name}.json").write_text(json.dumps({"line": f"The {name} screen shows the title."} | ({"path": path} if path else {})))


def test_a_flat_pair_is_rated_on_its_one_image_and_can_block(pr: FakeGitHub) -> None:
    flat_pair(pr, "1-home", "e2e/shots/1-home.png")
    flat_pair(pr, "2-login")
    changed_step(pr, "3-list")
    pr.reply_to(
        {
            "Step 1-home.": batch(("1-home", "blocking", "The title is cut off.", "text cut off"), ("2-login", "blocking", "The form overlaps.", "broken layout")),
            "The 3-list screen": answer("fine", "As asked."),
        }
    )

    run = pr.run(JUDGE, **INPUTS)

    assert run.returncode == 1, run.stderr
    assert len(pr.claude_calls) == 2
    rated = call_for(pr, "Step 1-home.")
    assert [part["type"] for part in rated].count("image") == 2
    assert "Step 2-login. Its ticket line: The 2-login screen shows the title." in [part.get("text") for part in rated]
    assert [part["type"] for part in call_for(pr, "The 3-list screen")].count("image") == 3
    [blocking] = pr.state["comments"]
    assert "### 1-home\n\nThe title is cut off." in blocking["body"]
    assert blocking["body"].count(f"kc/app/blob/{pr.env['HEAD_SHA']}/e2e/shots/1-home.png?raw=true") == 1
    assert "### 2-login\n\nThe form overlaps." in blocking["body"]
    assert "2-login.png" not in blocking["body"]


def test_a_png_with_no_json_is_not_a_step_and_the_judge_logs_it(pr: FakeGitHub) -> None:
    flat_pair(pr, "1-home")
    (pr.work / "screenshot-diff" / "stray.png").write_bytes(b"png")
    pr.reply(batch(("1-home", "fine", "As asked.")))

    run = pr.run(JUDGE, **INPUTS)

    assert run.returncode == 0, run.stderr
    assert len(pr.claude_calls) == 1
    assert "stray.png" in run.stdout


def test_rated_steps_share_a_call_of_up_to_ten_images(pr: FakeGitHub) -> None:
    names = [f"{n:02}-screen" for n in range(1, 26)]
    for name in names:
        flat_pair(pr, name)
    pr.reply_to({f"Step {names[start]}.": batch(*((name, "fine", "As asked.") for name in names[start : start + 10])) for start in (0, 10, 20)})

    run = pr.run(JUDGE, **INPUTS)

    assert run.returncode == 0, run.stderr
    assert sorted([part["type"] for part in content(c)].count("image") for c in pr.claude_calls) == [5, 10, 10]
    first = call_for(pr, "Step 01-screen.")
    assert [part.get("text") for part in first if part["type"] == "text"][1:3] == [
        "Step 01-screen. Its ticket line: The 01-screen screen shows the title.",
        "Step 02-screen. Its ticket line: The 02-screen screen shows the title.",
    ]
    assert pr.state["comments"] == []


def test_the_batch_size_is_an_input(pr: FakeGitHub) -> None:
    for name in ("1-home", "2-login", "3-list"):
        flat_pair(pr, name)
    pr.reply_to({"Step 1-home.": batch(("1-home", "fine", "As asked."), ("2-login", "fine", "As asked.")), "Step 3-list.": batch(("3-list", "fine", "As asked."))})

    run = pr.run(JUDGE, **INPUTS, JUDGE_BATCH_SIZE="2")

    assert run.returncode == 0, run.stderr
    assert len(pr.claude_calls) == 2


def test_a_blocking_verdict_in_a_batch_blocks_only_its_step(pr: FakeGitHub) -> None:
    for name in ("1-home", "2-login", "3-list"):
        flat_pair(pr, name, f"e2e/shots/{name}.png")
    pr.reply(batch(("1-home", "fine", "As asked."), ("2-login", "blocking", "The title is cut off.", "text cut off"), ("3-list", "minor", "The list is tight.")))

    run = pr.run(JUDGE, **INPUTS)

    assert run.returncode == 1, run.stderr
    assert len(pr.claude_calls) == 1
    blocking, minor = pr.state["comments"]
    assert "### 2-login\n\nThe title is cut off." in blocking["body"]
    assert blocking["body"].count(f"kc/app/blob/{pr.env['HEAD_SHA']}/e2e/shots/2-login.png?raw=true") == 1
    assert "1-home" not in blocking["body"] + minor["body"]
    assert "- [ ] **3-list**: The list is tight." in minor["body"]


def test_a_step_the_batch_answer_leaves_out_is_minor_with_a_note(pr: FakeGitHub) -> None:
    flat_pair(pr, "1-home")
    flat_pair(pr, "2-login")
    pr.reply(batch(("1-home", "fine", "As asked.")))

    run = pr.run(JUDGE, **INPUTS)

    assert run.returncode == 0, run.stderr
    [minor] = pr.state["comments"]
    assert "- [ ] **2-login**: The judge gave no verdict for this step." in minor["body"]
    assert "1-home" not in minor["body"]


def test_a_changed_step_keeps_a_call_of_its_own_beside_a_batch(pr: FakeGitHub) -> None:
    flat_pair(pr, "1-home")
    flat_pair(pr, "2-login")
    changed_step(pr, "3-list")
    pr.reply_to({"Step 1-home.": batch(("1-home", "fine", "As asked."), ("2-login", "fine", "As asked.")), "The 3-list screen": answer("minor", "The list moved.")})

    run = pr.run(JUDGE, **INPUTS)

    assert run.returncode == 0, run.stderr
    assert len(pr.claude_calls) == 2
    changed = call_for(pr, "The 3-list screen")
    assert [part["type"] for part in changed].count("image") == 3
    assert "Step 1-home." not in json.dumps(changed)
    [minor] = pr.state["comments"]
    assert "- [ ] **3-list**: The list moved." in minor["body"]
