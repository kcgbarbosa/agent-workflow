"""The gate runs a repo's check as one job, or as the parallel jobs of its `checks` input, and `gate / check` passes only when each of them passes.

Each test plays the jobs of gate.yml in order: it evaluates their `if`, runs their shell steps under the shell GitHub uses, and keeps the artifacts in a folder.
Every other action is a no-op: each job's folder stands for its checkout, and the judge's own tests cover the judge.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import yaml

GATE = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "gate.yml"
WORKFLOW = yaml.safe_load(GATE.read_text())
TOKEN = re.compile(r"'[^']*'|!(?!=)|&&|\|\||\bcancelled\(\)|\btrue\b|\bfalse\b|\bfromJSON\(|[A-Za-z_][\w-]*(?:\.[\w-]+)+")


def evaluate(expression: object, context: dict) -> object:
    """The subset of GitHub expressions that gate.yml uses, as Python. A missing value is '', as GitHub's null compares."""
    if not isinstance(expression, str):
        return expression
    expression = expression.strip().removeprefix("${{").removesuffix("}}")

    def lookup(path: str) -> object:
        value: object = context
        for key in path.split("."):
            value = value.get(key, "") if isinstance(value, dict) else ""
        return value

    def translate(token: re.Match[str]) -> str:
        text = token.group()
        words = {"!": " not ", "&&": " and ", "||": " or ", "cancelled()": "False", "true": "True", "false": "False", "fromJSON(": "json.loads("}
        if text.startswith("'") or text not in words and not text[0].isalpha():
            return text
        return words.get(text, f"lookup({text!r})")

    return eval(TOKEN.sub(translate, expression), {"lookup": lookup, "json": json})


def render(text: object, context: dict) -> str:
    def value(match: re.Match[str]) -> str:
        result = evaluate(match.group(1), context)
        return str(result).lower() if isinstance(result, bool) else str(result)

    if isinstance(text, bool):
        return str(text).lower()
    return re.sub(r"\$\{\{(.*?)\}\}", value, str(text))


@dataclass
class Run:
    """One run of the gate: the inputs, the jobs' results and outputs, and the artifacts the jobs uploaded."""

    root: Path
    inputs: dict
    docs_only: bool = False
    check_env: str = ""
    results: dict = field(default_factory=dict)
    needs: dict = field(default_factory=dict)
    ran: list = field(default_factory=list)

    @property
    def artifacts(self) -> Path:
        return self.root / "artifacts"

    def context(self, matrix: dict | None = None) -> dict:
        inputs = {name: spec.get("default", "") for name, spec in WORKFLOW[True]["workflow_call"]["inputs"].items()} | self.inputs
        return {"inputs": inputs, "needs": self.needs, "matrix": matrix or {}, "secrets": {"CHECK_ENV": self.check_env}}

    def job(self, name: str) -> None:
        spec = WORKFLOW["jobs"][name]
        needs = spec["needs"] if isinstance(spec["needs"], list) else [spec["needs"]]
        condition = spec.get("if", "")
        passed = all(self.needs[need]["result"] == "success" for need in needs)
        if not (("cancelled()" in condition or passed) and (not condition or evaluate(condition, self.context()))):
            self.needs[name] = {"result": "skipped", "outputs": {}}
            return
        matrix = spec.get("strategy", {}).get("matrix", {}).get("include")
        runs = evaluate(matrix, self.context()) if matrix else [None]
        result, outputs = "success", {}
        for entry in runs:
            if result == "failure" and spec["strategy"].get("fail-fast", True):
                break
            job_result, outputs = self.instance(spec, entry)
            self.ran.append(render(spec.get("name", name), self.context(entry)))
            result = "failure" if job_result == "failure" else result
        self.needs[name] = {"result": result, "outputs": outputs}

    def instance(self, spec: dict, matrix: dict | None) -> tuple[str, dict]:
        work = self.root / "jobs" / str(len(self.ran))
        work.mkdir(parents=True)
        context = self.context(matrix) | {"steps": {}}
        context["env"] = {key: render(value, context) for key, value in spec.get("env", {}).items()}
        result = "success"
        for step in spec["steps"]:
            uses = step.get("uses", "")
            if uses and "-artifact@" not in uses:
                continue
            if result == "failure" or ("if" in step and not evaluate(step["if"], context)):
                continue
            with_ = {key: render(value, context) for key, value in step.get("with", {}).items()}
            if uses.startswith("actions/upload-artifact"):
                shutil.copytree(work / with_["path"], self.artifacts / with_["name"])
            elif uses.startswith("actions/download-artifact"):
                self.download(with_, work)
            elif not self.shell(step, context, work):
                result = "failure"
        outputs = {key: render(value, context) for key, value in spec.get("outputs", {}).items()}
        return result, outputs

    def shell(self, step: dict, context: dict, work: Path) -> bool:
        output = work / ".output"
        output.write_text("")
        env = {"PATH": os.environ["PATH"], "GITHUB_OUTPUT": str(output)} | context["env"] | {key: render(value, context) for key, value in step.get("env", {}).items()}
        run = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step["run"]], cwd=work, env=env, capture_output=True, text=True)
        written = dict(line.split("=", 1) for line in output.read_text().splitlines())
        context["steps"][step.get("id", "")] = {"outputs": written}
        return run.returncode == 0

    def download(self, with_: dict, work: Path) -> None:
        assert with_["merge-multiple"] == "true" and "name" not in with_
        if self.artifacts.exists():
            for artifact in sorted(self.artifacts.iterdir()):
                if fnmatch.fnmatch(artifact.name, with_["pattern"]):
                    shutil.copytree(artifact, work / with_["path"], dirs_exist_ok=True)

    def gate(self) -> None:
        self.needs["paths"] = {"result": "success", "outputs": self.paths()}
        for name in ("checks", "check", "judge"):
            self.job(name)

    def paths(self) -> dict:
        """The `paths` job with its diff as given: only its `checks` step runs."""
        context = self.context() | {"steps": {"paths": {"outputs": {"docs-only": "true" if self.docs_only else ""}}}}
        context["env"] = {}
        [step] = [s for s in WORKFLOW["jobs"]["paths"]["steps"] if s.get("id") == "checks"]
        work = self.root / "paths"
        work.mkdir()
        if evaluate(step["if"], context):
            assert self.shell(step, context, work)
        return {key: render(value, context) for key, value in WORKFLOW["jobs"]["paths"]["outputs"].items()}

    def judged(self) -> Path:
        """The folder the judge rates, from its download step."""
        [step] = [s for s in WORKFLOW["jobs"]["judge"]["steps"] if "download-artifact" in s.get("uses", "")]
        work = self.root / "judge"
        work.mkdir()
        self.download({key: render(value, {}) for key, value in step["with"].items()}, work)
        return work / step["with"]["path"]


def gate(tmp_path: Path, **inputs: object) -> Run:
    run = Run(tmp_path, inputs, docs_only=bool(inputs.pop("docs_only", False)))
    run.gate()
    return run


def shot(name: str) -> str:
    return f"mkdir -p screenshot-diff && echo png > screenshot-diff/{name}.png && echo '{{}}' > screenshot-diff/{name}.json"


def test_no_checks_runs_check_as_one_job(tmp_path: Path) -> None:
    run = gate(tmp_path, check="touch ran && test -f ran")

    assert run.ran == ["check"]
    assert run.needs["checks"]["result"] == "skipped"
    assert run.needs["check"]["result"] == "success"


def test_no_checks_fails_check_on_a_red_command(tmp_path: Path) -> None:
    run = gate(tmp_path, check="exit 3")

    assert run.needs["check"]["result"] == "failure"


def test_three_lines_run_three_jobs_and_check_waits_on_them(tmp_path: Path) -> None:
    run = gate(tmp_path, check="exit 9", checks="lint: echo lint\n\n# the unit tests\nunit: echo 'unit: \"a\"'  \r\ne2e:echo e2e\n")

    assert run.ran == ["check (lint)", "check (unit)", "check (e2e)", "check"]
    assert json.loads(run.needs["paths"]["outputs"]["checks"]) == [
        {"name": "lint", "command": "echo lint"},
        {"name": "unit", "command": "echo 'unit: \"a\"'"},
        {"name": "e2e", "command": "echo e2e"},
    ]
    assert run.needs["check"]["result"] == "success"


def test_a_red_line_fails_check_while_the_others_finish(tmp_path: Path) -> None:
    marks = tmp_path / "marks"
    marks.mkdir()
    run = gate(tmp_path, checks=f"lint: exit 1\nunit: touch {marks}/unit\ne2e: touch {marks}/e2e\n")

    assert sorted(path.name for path in marks.iterdir()) == ["e2e", "unit"]
    assert run.needs["checks"]["result"] == "failure"
    assert run.needs["check"]["result"] == "failure"
    assert run.needs["judge"]["result"] == "skipped"


def test_each_job_gets_check_env(tmp_path: Path) -> None:
    run = Run(tmp_path, {"checks": 'a: test "$KEY" = fake\nb: test "$KEY" = fake'}, check_env="KEY=fake")
    run.gate()

    assert run.needs["checks"]["result"] == "success"


def test_screenshots_from_two_jobs_reach_the_judge_as_one_folder(tmp_path: Path) -> None:
    run = gate(tmp_path, checks=f"unit: echo unit\nhome: {shot('1-home')}\nlogin: {shot('2-login')}\n")

    assert sorted(path.name for path in run.artifacts.iterdir()) == ["screenshot-diff-home", "screenshot-diff-login"]
    assert run.needs["check"]["outputs"]["screenshots"] == "true"
    assert run.needs["judge"]["result"] == "success"
    assert sorted(path.name for path in run.judged().iterdir()) == ["1-home.json", "1-home.png", "2-login.json", "2-login.png"]


def test_no_checks_screenshots_reach_the_judge(tmp_path: Path) -> None:
    run = gate(tmp_path, check=shot("1-home"))

    assert sorted(path.name for path in run.artifacts.iterdir()) == ["screenshot-diff-check"]
    assert run.needs["judge"]["result"] == "success"
    assert sorted(path.name for path in run.judged().iterdir()) == ["1-home.json", "1-home.png"]


def test_no_screenshot_skips_the_judge(tmp_path: Path) -> None:
    run = gate(tmp_path, checks="a: echo a\nb: echo b")

    assert run.needs["check"]["result"] == "success"
    assert run.needs["judge"]["result"] == "skipped"


def test_a_docs_only_pull_request_runs_only_docs_check_in_one_job(tmp_path: Path) -> None:
    run = gate(tmp_path, checks="a: exit 1\nb: exit 1", **{"docs-check": "touch docs && test -f docs"}, docs_only=True)

    assert run.ran == ["check"]
    assert run.needs["check"]["result"] == "success"


def test_a_failed_paths_job_fails_check_when_the_repo_splits_it(tmp_path: Path) -> None:
    run = Run(tmp_path, {"checks": "a: echo a"})
    run.needs["paths"] = {"result": "failure", "outputs": {}}
    for name in ("checks", "check"):
        run.job(name)

    assert run.needs["checks"]["result"] == "skipped"
    assert run.needs["check"]["result"] == "failure"


def test_a_line_out_of_shape_fails_paths_with_its_number(tmp_path: Path) -> None:
    for checks, error in [
        ("a: echo a\nnot a line", "checks line 2 is not <name>: <command>"),
        ("a: echo a\na: echo b", "checks line 2 repeats the name a"),
        ("# only a comment\n", "checks has no <name>: <command> line"),
    ]:
        [step] = [s for s in WORKFLOW["jobs"]["paths"]["steps"] if s.get("id") == "checks"]
        env = {"PATH": os.environ["PATH"], "GITHUB_OUTPUT": str(tmp_path / "out"), "CHECKS": checks}
        result = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step["run"]], env=env, capture_output=True, text=True)

        assert result.returncode == 1
        assert f"::error::{error}" in result.stdout
