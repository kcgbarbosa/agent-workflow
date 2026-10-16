from __future__ import annotations

from pathlib import Path
from typing import Any

from loop.steps import next_step
from loop.watch import read_lines


def line(step: str, result: str, commit: str = "a") -> dict[str, Any]:
    return {"ticket": "DEMO-2", "step": step, "result": result, "commit": commit}


PASSED = [
    line("build", "started"),
    line("build", "pass"),
    line("ticket-gate", "started"),
    line("ticket-gate", "pass"),
    line("code-review", "started"),
    line("code-review", "pass"),
]


def test_a_new_ticket_starts_at_the_build() -> None:
    assert next_step([], "a", ui=None) == "build"


def test_each_step_passed_at_head_is_skipped() -> None:
    assert next_step(PASSED, "a", ui=None) == "land"


def test_a_new_commit_voids_the_passes_after_the_build() -> None:
    lines = [*PASSED, line("build", "started", "a"), line("build", "pass", "b")]

    assert next_step(lines, "b", ui=None) == "ticket-gate"


def test_a_step_with_a_started_line_and_no_result_runs_again() -> None:
    assert next_step(PASSED[:5], "a", ui=None) == "code-review"


def test_code_review_findings_that_the_agent_answered_with_no_commit_pass() -> None:
    lines = [*PASSED[:5], line("code-review", "findings"), line("build", "started"), line("build", "pass")]

    assert next_step(lines, "a", ui=None) == "land"


def test_code_review_findings_with_no_answer_run_the_step_again() -> None:
    lines = [*PASSED[:5], line("code-review", "findings"), line("build", "started")]

    assert next_step(lines, "a", ui=None) == "code-review"


def test_a_ui_review_passes_at_a_commit_with_the_same_ui_change() -> None:
    lines = [*PASSED, line("ui-gate", "open", "old")]

    assert next_step(lines, "a", ui=lambda commit: commit == "old") == "land"
    assert next_step(lines, "a", ui=lambda commit: False) == "ui-gate"


def test_the_reader_skips_a_cut_off_last_line(tmp_path: Path) -> None:
    log = tmp_path / "decisions.jsonl"
    log.write_text('{"step": "build", "result": "pass"}\n{"step": "ticket-gate", "res')

    assert read_lines(log) == [{"step": "build", "result": "pass"}]
