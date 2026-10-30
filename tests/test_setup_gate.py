"""setup-repo's gate step puts a repo on the shared gate, and a second run changes nothing.

Every run gets a fake gh, uv, and node, so no GitHub setting changes and the pinned versions are fixed.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

GATE = Path(__file__).resolve().parents[1] / "skills" / "setup-repo" / "gate.sh"
SHARED_GATE = "uses: kcgbarbosa/agent-workflow/.github/workflows/gate.yml@main"


@pytest.fixture
def env(tmp_path: Path) -> dict[str, str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "gh.log"
    fakes = {
        # Records each call and its stdin, and names main as the default branch.
        "gh": (
            "#!/bin/sh\n"
            f'echo "gh $*" >> "{log}"\n'
            f'[ "$1" = api ] && cat >> "{log}"\n'
            '[ "$1 $2" = "repo view" ] && echo main\n'
            "exit 0\n"
        ),
        "uv": "#!/bin/sh\necho 'uv 0.9.1 (x86_64-unknown-linux-gnu)'\n",
        "node": "#!/bin/sh\necho v22.4.0\n",
    }
    for name, text in fakes.items():
        (bin_dir / name).write_text(text)
        (bin_dir / name).chmod(0o755)
    config = tmp_path / "gitconfig"
    config.write_text("[user]\n\tname = Test\n\temail = test@example.com\n")
    return {
        **os.environ,
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "GIT_CONFIG_GLOBAL": str(config),
        "GIT_CONFIG_NOSYSTEM": "1",
    }


def gate(cwd: Path, env: dict[str, str], step: str) -> None:
    result = subprocess.run([str(GATE), step], cwd=cwd, env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def snapshot(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file() and ".git" not in p.parts}


@pytest.fixture
def python_repo(tmp_path: Path, env: dict[str, str]) -> Path:
    work = tmp_path / "work"
    (work / "app").mkdir(parents=True)
    (work / "app" / "pyproject.toml").write_text("[project]\nname = 'app'\n")
    (work / "package.json").write_text("{}\n")
    subprocess.run(["git", "init", "-q"], cwd=work, env=env, check=True)
    subprocess.run(["git", "add", "."], cwd=work, env=env, check=True)
    return work


def test_write_puts_a_repo_on_the_shared_gate(python_repo: Path, env: dict[str, str]) -> None:
    gate(python_repo, env, "write")

    caller = (python_repo / ".github" / "workflows" / "pull-request.yml").read_text()
    assert SHARED_GATE in caller
    assert "CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}" in caller
    assert len(caller.splitlines()) <= 18
    assert "hold" in (python_repo / ".github" / "workflows" / "hold.yml").read_text()
    assert (python_repo / "mise.toml").read_text() == '[tools]\nnode = "22.4.0"\nuv = "0.9.1"\n'
    assert "[review]\nenabled = true\n" in (python_repo / "loop.toml").read_text()


def test_write_keeps_a_mise_file_and_a_loop_toml(python_repo: Path, env: dict[str, str]) -> None:
    (python_repo / ".tool-versions").write_text("nodejs 20.0.0\n")
    (python_repo / "loop.toml").write_text('name = "app"\n')

    gate(python_repo, env, "write")

    assert not (python_repo / "mise.toml").exists()
    loop_toml = (python_repo / "loop.toml").read_text()
    assert loop_toml.startswith('name = "app"\n')
    assert "[review]\nenabled = true\n" in loop_toml


def test_write_keeps_the_review_answer_in_loop_toml(python_repo: Path, env: dict[str, str]) -> None:
    (python_repo / "loop.toml").write_text('name = "app"\n\n[review]\nenabled = false\n')

    gate(python_repo, env, "write")

    assert (python_repo / "loop.toml").read_text() == 'name = "app"\n\n[review]\nenabled = false\n'


def test_a_second_write_changes_nothing(python_repo: Path, env: dict[str, str]) -> None:
    gate(python_repo, env, "write")
    first = snapshot(python_repo)

    gate(python_repo, env, "write")

    assert snapshot(python_repo) == first


def test_write_on_agent_workflow_changes_nothing(tmp_path: Path, env: dict[str, str], repo: Path, tracked: list[Path]) -> None:
    copy = tmp_path / "agent-workflow"
    for path in tracked:
        target = copy / path.relative_to(repo)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    subprocess.run(["git", "init", "-q"], cwd=copy, env=env, check=True)
    subprocess.run(["git", "add", "."], cwd=copy, env=env, check=True)
    before = snapshot(copy)

    gate(copy, env, "write")

    assert snapshot(copy) == before
    # agent-workflow calls its own gate, so a change to the gate runs in the pull request that makes it.
    assert "uses: ./.github/workflows/gate.yml" in (copy / ".github" / "workflows" / "pull-request.yml").read_text()


def test_protect_requires_the_gate_and_allows_squash_only(python_repo: Path, env: dict[str, str], tmp_path: Path) -> None:
    gate(python_repo, env, "protect")

    log = (tmp_path / "gh.log").read_text()
    assert "gh label create hold --force" in log
    settings = log.split("gh api -X PATCH repos/{owner}/{repo} ")[1].splitlines()[0].split()
    assert settings == [
        "-F", "allow_squash_merge=true",
        "-F", "allow_merge_commit=false",
        "-F", "allow_rebase_merge=false",
        "-F", "allow_auto_merge=true",
        "-F", "delete_branch_on_merge=true",
        "-f", "squash_merge_commit_title=PR_TITLE",
        "-f", "squash_merge_commit_message=PR_BODY",
    ]  # fmt: skip
    put = log.split("gh api -X PUT repos/{owner}/{repo}/branches/main/protection --input -\n")[1]
    protection = json.loads(put)
    assert [check["context"] for check in protection["required_status_checks"]["checks"]] == [
        "gate / check",
        "gate / review",
        "gate / judge",
        "hold",
    ]
    assert protection["required_pull_request_reviews"]["required_approving_review_count"] == 0
    assert protection["allow_force_pushes"] is False
