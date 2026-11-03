"""The gate's check step masks each value of the optional CHECK_ENV secret, exports it to the check command, and runs as before without it.

Each test runs the step's own script from gate.yml under the shell GitHub uses, with fake values. The fuzz action runs the same script.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / ".github" / "workflows" / "gate.yml"
FUZZ = ROOT / "actions" / "fuzz" / "action.yml"
SHOW = 'echo "$PASSWORD|$AWS_KEY|$EMPTY|${CHECK_ENV-unset}"'


def jobs() -> dict:
    return yaml.safe_load(GATE.read_text())["jobs"]


def run_check(check_env: str, command: str = SHOW) -> subprocess.CompletedProcess[str]:
    [step] = [s for s in jobs()["check"]["steps"] if "COMMAND" in s.get("env", {})]
    env = {"PATH": os.environ["PATH"], "CHECK_ENV": check_env, "COMMAND": command}
    return subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step["run"]], env=env, capture_output=True, text=True)


def test_each_value_is_masked_before_the_command_gets_it() -> None:
    run = run_check("PASSWORD=fake%pass\n# a comment\n\nAWS_KEY='fake key'\nEMPTY=\n")

    assert run.returncode == 0, run.stderr
    assert run.stdout.splitlines() == [
        "::add-mask::fake%25pass",
        "::add-mask::fake key",
        "fake%pass|fake key||unset",
    ]


def test_a_repo_without_the_secret_runs_its_command_as_before() -> None:
    run = run_check("")

    assert run.returncode == 0, run.stderr
    assert run.stdout == "|||unset\n"


def test_a_malformed_line_fails_with_its_number_and_no_value() -> None:
    run = run_check("PASSWORD=fake-pass\nnot a pair fake-secret\n", command="echo ran")

    assert run.returncode == 1
    assert "CHECK_ENV line 2 is not NAME=value" in run.stdout
    assert "fake-secret" not in run.stdout + run.stderr
    assert "ran" not in run.stdout.splitlines()


def test_only_the_check_and_the_fuzz_jobs_get_the_secret() -> None:
    assert [name for name, job in jobs().items() if "secrets.CHECK_ENV" in yaml.safe_dump(job)] == ["check", "fuzz"]


def test_the_fuzz_action_masks_with_the_check_step_s_script() -> None:
    [check] = [s for s in jobs()["check"]["steps"] if "COMMAND" in s.get("env", {})]
    [fuzz] = [s for s in yaml.safe_load(FUZZ.read_text())["runs"]["steps"] if "COMMAND" in s.get("env", {})]
    assert fuzz["run"] == check["run"]
    assert fuzz["env"]["CHECK_ENV"] == "${{ inputs.check_env }}"
