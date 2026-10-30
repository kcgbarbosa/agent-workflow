"""install.sh links the repo into a fresh home and is safe to run again.

Every run gets a temp HOME, a fake uv, a fake npm, and a fake claude, so nothing is installed for real and the checkout is never touched.
The real claude would write through the settings.json link into config/ in the checkout.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

BASE_REF_WARNING = "baseRef"
SHARED_FILES = ("settings.json", "statusline.sh", "keybindings.json", "notify.sh")


@pytest.fixture
def home(tmp_path: Path) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    return home


@pytest.fixture
def run(tmp_path: Path, home: Path, repo: Path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    uv = bin_dir / "uv"
    uv.write_text(f'#!/bin/sh\necho "$@" >> "{tmp_path / "uv.log"}"\n')
    uv.chmod(0o755)
    npm = bin_dir / "npm"
    # Records its arguments, so the test can see the loop's packages would be installed.
    npm.write_text(f'#!/bin/sh\necho "$@" >> "{tmp_path / "npm.log"}"\n')
    npm.chmod(0o755)
    claude = bin_dir / "claude"
    # Records its arguments. `mcp get` finds only a server that an earlier `mcp add` added.
    claude.write_text(
        "#!/bin/sh\n"
        f'log="{tmp_path / "claude.log"}"\n'
        '[ "$1 $2" = "mcp get" ] && exec grep -q "^mcp add .* $3 " "$log"\n'
        'echo "$@" >> "$log"\n'
    )
    claude.chmod(0o755)
    env = {**os.environ, "HOME": str(home), "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"}

    def run() -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [str(repo / "install.sh")], env=env, capture_output=True, text=True, cwd=tmp_path
        )
        assert result.returncode == 0, result.stderr
        return result

    return run


def skills(repo: Path) -> list[Path]:
    return sorted(p for p in (repo / "skills").iterdir() if p.is_dir() and not p.name.startswith("."))


def tiers(repo: Path) -> list[Path]:
    return sorted((repo / "agents").glob("*.md"))


def snapshot(root: Path) -> dict[str, str]:
    """Each entry under root, with its link target or kind, to compare two runs."""
    entries = {}
    for path in sorted(root.rglob("*")):
        key = str(path.relative_to(root))
        if path.is_symlink():
            entries[key] = "-> " + os.readlink(path)
        else:
            entries[key] = "dir" if path.is_dir() else "file"
    return entries


def test_links_every_skill_tier_and_agents_md(run, home: Path, repo: Path, tmp_path: Path) -> None:
    run()
    claude = home / ".claude"
    for skill in skills(repo):
        link = claude / "skills" / skill.name
        assert link.is_symlink() and link.resolve() == skill.resolve(), skill.name
    for tier in tiers(repo):
        link = claude / "agents" / tier.name
        assert link.is_symlink() and link.resolve() == tier.resolve(), tier.name
    assert (claude / "CLAUDE.md").is_symlink()
    assert (claude / "CLAUDE.md").resolve() == (repo / "config" / "CLAUDE.md").resolve()
    assert f"ci --prefix {repo}/loop" in (tmp_path / "npm.log").read_text()
    loop = home / ".local" / "bin" / "loop"
    assert loop.is_symlink() and loop.resolve() == (repo / "loop" / "bin" / "loop").resolve()


def test_adds_each_mcp_server_once(run, tmp_path: Path) -> None:
    run()
    run()
    added = (tmp_path / "claude.log").read_text().splitlines()
    assert [line.split()[-2] for line in added] == ["workos", "aws-mcp"]


def test_removes_stale_repo_links_and_keeps_others(run, home: Path, repo: Path, tmp_path: Path) -> None:
    claude = home / ".claude"
    (claude / "skills").mkdir(parents=True)
    (claude / "agents").mkdir()
    # Paths under the repo that do not exist, as after a skill or tier is removed.
    (claude / "skills" / "gone").symlink_to(repo / "skills" / "no-such-skill")
    (claude / "agents" / "gone.md").symlink_to(repo / "agents" / "no-such-tier.md")
    # Links to elsewhere belong to someone else, even when they dangle.
    elsewhere = tmp_path / "elsewhere"
    (claude / "skills" / "mine").symlink_to(elsewhere / "skill")
    (claude / "agents" / "mine.md").symlink_to(elsewhere / "tier.md")

    run()

    assert not (claude / "skills" / "gone").is_symlink()
    assert not (claude / "agents" / "gone.md").is_symlink()
    assert os.readlink(claude / "skills" / "mine") == str(elsewhere / "skill")
    assert os.readlink(claude / "agents" / "mine.md") == str(elsewhere / "tier.md")


def test_skips_real_files_and_names_them(run, home: Path, repo: Path) -> None:
    claude = home / ".claude"
    skill = skills(repo)[0].name
    tier = tiers(repo)[0].name
    (claude / "skills" / skill).mkdir(parents=True)
    (claude / "skills" / skill / "keep.txt").write_text("mine")
    (claude / "agents").mkdir()
    (claude / "agents" / tier).write_text("my tier")
    (claude / "CLAUDE.md").write_text("my rules")

    stderr = run().stderr

    assert not (claude / "skills" / skill).is_symlink()
    assert (claude / "skills" / skill / "keep.txt").read_text() == "mine"
    assert not (claude / "agents" / tier).is_symlink()
    assert (claude / "agents" / tier).read_text() == "my tier"
    assert not (claude / "CLAUDE.md").is_symlink()
    assert (claude / "CLAUDE.md").read_text() == "my rules"
    for name in (f"skipped {skill}", f"skipped the {tier} tier", "skipped CLAUDE.md"):
        assert name in stderr


def test_links_the_shared_files_into_the_repo(run, home: Path, repo: Path) -> None:
    run()
    for name in SHARED_FILES:
        link = home / ".claude" / name
        assert link.is_symlink() and link.resolve() == (repo / "config" / name).resolve(), name


def test_backs_up_a_real_file_and_links(run, home: Path, repo: Path) -> None:
    claude = home / ".claude"
    claude.mkdir()
    for name in SHARED_FILES:
        (claude / name).write_text(f"my {name}")

    stderr = run().stderr

    for name in SHARED_FILES:
        assert (claude / name).is_symlink()
        assert (claude / name).resolve() == (repo / "config" / name).resolve()
        assert (claude / f"{name}.bak").read_text() == f"my {name}"
        assert f"moved {claude / name} to {claude / name}.bak" in stderr


def test_keeps_an_old_backup_and_uses_a_timestamp(run, home: Path) -> None:
    claude = home / ".claude"
    claude.mkdir()
    (claude / "settings.json.bak").write_text("first")
    (claude / "settings.json").write_text("second")

    run()

    assert (claude / "settings.json.bak").read_text() == "first"
    stamped = [p for p in claude.glob("settings.json.bak.*")]
    assert len(stamped) == 1 and stamped[0].read_text() == "second"
    assert (claude / "settings.json").is_symlink()


def test_leaves_a_link_to_somewhere_else(run, home: Path, tmp_path: Path) -> None:
    claude = home / ".claude"
    claude.mkdir()
    (claude / "settings.json").symlink_to(tmp_path / "elsewhere.json")

    stderr = run().stderr

    assert os.readlink(claude / "settings.json") == str(tmp_path / "elsewhere.json")
    assert "skipped settings.json" in stderr
    assert not list(claude.glob("settings.json.bak*"))


def test_replaces_a_repo_link_without_a_backup(run, home: Path, repo: Path) -> None:
    claude = home / ".claude"
    claude.mkdir()
    (claude / "notify.sh").symlink_to(repo / "config" / "gone.sh")

    stderr = run().stderr

    assert (claude / "notify.sh").resolve() == (repo / "config" / "notify.sh").resolve()
    assert not list(claude.glob("notify.sh.bak*"))
    assert "notify.sh" not in stderr


def test_does_not_warn_about_base_ref(run) -> None:
    assert BASE_REF_WARNING not in run().stderr


def test_shared_settings_set_base_ref_to_head(repo: Path) -> None:
    settings = json.loads((repo / "config" / "settings.json").read_text())
    assert settings["worktree"]["baseRef"] == "head"


def test_shared_scripts_are_executable(repo: Path) -> None:
    for name in ("statusline.sh", "notify.sh"):
        assert os.access(repo / "config" / name, os.X_OK), name


def test_second_run_changes_nothing(run, home: Path) -> None:
    first = run()
    before = snapshot(home)
    second = run()
    assert snapshot(home) == before
    assert second.stderr == first.stderr
    assert not list((home / ".claude").glob("*.bak*"))


def test_second_run_after_a_backup_changes_nothing(run, home: Path) -> None:
    (home / ".claude").mkdir()
    (home / ".claude" / "settings.json").write_text("mine")
    run()
    before = snapshot(home)
    second = run()
    assert snapshot(home) == before
    assert "moved" not in second.stderr
