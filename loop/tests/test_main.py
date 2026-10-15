"""The `loop` command: the config file and the prerequisite check."""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path

import pytest
from conftest import write_config

from loop import cli, config, watch
from loop.cli import SECRETS_FILE, Refused, main, read_secrets


def test_the_loop_refuses_to_run_when_a_prerequisite_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    write_config(tmp_path)
    monkeypatch.setenv("PATH", str(tmp_path))

    assert main(["run", "DEMO-33", "--repo", str(tmp_path)]) == 2

    error = capsys.readouterr().err
    assert "The loop refuses to run" in error
    # The engine's tools, the repo's tools, and Docker for the stack.
    assert all(tool in error for tool in ("claude", "bw", "make", "docker"))


def test_the_loop_needs_an_epic_key(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["run", "the-loop"]) == 2
    assert "Usage" in capsys.readouterr().err


def test_the_secrets_come_from_bitwarden_and_a_missing_one_refuses_the_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path)
    settings = config.load(tmp_path)
    fake_bw = tmp_path / "bw"
    fake_bw.write_text('#!/bin/sh\nif [ "$3" = demo-ntfy-topic ]; then exit 1; fi\necho "value-of-$2-$3"\n')
    fake_bw.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}:/usr/bin:/bin")

    with pytest.raises(Refused, match="demo-ntfy-topic"):
        read_secrets(settings)

    fake_bw.write_text('#!/bin/sh\necho "value-of-$2-$3"\n')
    secrets = read_secrets(settings)
    assert secrets["JIRA_EMAIL"] == "value-of-username-demo-jira"
    assert secrets["JIRA_API_TOKEN"] == "value-of-password-demo-jira"


def test_loop_secrets_copies_the_secrets_so_a_run_needs_no_unlock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path)
    settings = config.load(tmp_path, state_dir=tmp_path / "state")
    monkeypatch.setattr(config, "load", lambda repo: settings)
    fake_bw = tmp_path / "bw"
    fake_bw.write_text(
        '#!/bin/sh\nif [ "$1" = status ]; then echo \'{"status": "unlocked"}\'; exit 0; fi\n'
        'echo "value-of-$2-$3"\n'
    )
    fake_bw.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}:/usr/bin:/bin")

    assert main(["secrets", "--repo", str(tmp_path)]) == 0

    path = tmp_path / "state" / SECRETS_FILE
    assert path.stat().st_mode & 0o777 == 0o600
    fake_bw.unlink()
    assert read_secrets(settings)["JIRA_API_TOKEN"] == "value-of-password-demo-jira"


def test_a_secrets_file_without_a_secret_of_the_config_refuses_the_run(tmp_path: Path) -> None:
    write_config(tmp_path)
    settings = config.load(tmp_path, state_dir=tmp_path)
    (tmp_path / SECRETS_FILE).write_text(json.dumps({"JIRA_EMAIL": "kc@example.com"}))

    with pytest.raises(Refused, match="JIRA_API_TOKEN, NTFY_TOPIC.*loop secrets"):
        read_secrets(settings)


def test_loop_secrets_refuses_a_locked_vault(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    write_config(tmp_path)
    fake_bw = tmp_path / "bw"
    fake_bw.write_text('#!/bin/sh\necho \'{"status": "locked"}\'\n')
    fake_bw.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}:/usr/bin:/bin")

    assert main(["secrets", "--repo", str(tmp_path)]) == 2
    assert "Bitwarden is locked" in capsys.readouterr().err


def test_the_config_gives_each_worktree_its_own_stack(tmp_path: Path) -> None:
    write_config(tmp_path)
    settings = config.load(tmp_path)

    assert settings.stack_env(2, "DEMO-7") == {
        "DB_PORT": "55452",
        "API_PORT": "8020",
        "COMPOSE_PROJECT_NAME": "demo-demo-7",
    }
    assert settings.state_dir == Path.home() / ".local/state/demo-loop"


def test_the_head_agent_runs_on_the_agent_table_or_the_defaults(tmp_path: Path) -> None:
    write_config(tmp_path)
    settings = config.load(tmp_path)
    assert (settings.agent_model, settings.agent_effort) == ("claude-opus-5-5", "high")

    write_config(tmp_path, extra='\n[agent]\nmodel = "claude-sonnet-5-5"\neffort = "medium"\n')
    settings = config.load(tmp_path)
    assert (settings.agent_model, settings.agent_effort) == ("claude-sonnet-5-5", "medium")


def test_the_context_window_defaults_to_200k_and_the_agent_table_sets_it(tmp_path: Path) -> None:
    write_config(tmp_path)
    assert config.load(tmp_path).agent_context_tokens == 200_000

    write_config(tmp_path, extra="\n[agent]\ncontext_tokens = 150000\n")
    assert config.load(tmp_path).agent_context_tokens == 150_000


def test_a_repo_without_a_stack_gets_no_stack_env(tmp_path: Path) -> None:
    write_config(tmp_path)
    text = (tmp_path / config.FILE).read_text()
    start = text.index("[stack]")
    (tmp_path / config.FILE).write_text(text[:start] + text[text.index("[secrets]") :])

    assert config.load(tmp_path).stack_env(2, "DEMO-7") == {}


def test_the_demo_table_is_optional_and_needs_a_command_and_an_address(tmp_path: Path) -> None:
    write_config(tmp_path)
    assert config.load(tmp_path).demo is None

    write_config(
        tmp_path, extra='\n[demo]\ncommand = ["make", "demo", "branch={branch}"]\nurl = "https://d"\n'
    )
    assert config.load(tmp_path).demo == config.Demo(("make", "demo", "branch={branch}"), "https://d")


@pytest.mark.parametrize(
    ("demo", "message"),
    [
        ("", "demo.command is missing"),
        ('command = ["make", "demo"]', "demo.url is missing"),
        ('url = "https://d"', "demo.command is missing"),
        ('command = []\nurl = "https://d"', "demo.command must not be empty"),
        ('command = "make demo"\nurl = "https://d"', "demo.command has the wrong type"),
        ('command = ["make", 1]\nurl = "https://d"', "demo.command must be a list of strings"),
        ('command = ["make"]\nurl = "https://d"\nport = 1', "unknown key demo.port"),
    ],
)
def test_a_demo_table_mistake_refuses_the_file(tmp_path: Path, demo: str, message: str) -> None:
    write_config(tmp_path, extra=f"\n[demo]\n{demo}\n")

    with pytest.raises(config.ConfigError, match=message):
        config.load(tmp_path)


@pytest.mark.parametrize(
    ("edit", "message"),
    [
        (lambda text: text.replace("[limits]", "[limits]\nparalel = 3"), "unknown key limits.paralel"),
        (
            lambda text: text.replace('NTFY_TOPIC = { item = "demo-ntfy-topic", field = "password" }', ""),
            "NTFY_TOPIC",
        ),
        (lambda text: text.replace('kind = "jira"', 'kind = "linear"'), "Jira adapter only"),
        (lambda text: text.replace("parallel = 2", 'parallel = "2"'), "limits.parallel has the wrong type"),
    ],
)
def test_a_config_mistake_refuses_the_file(tmp_path: Path, edit: Callable[[str], str], message: str) -> None:
    write_config(tmp_path)
    path = tmp_path / config.FILE
    path.write_text(edit(path.read_text()))

    with pytest.raises(config.ConfigError, match=message):
        config.load(tmp_path)


def test_a_missing_config_names_the_skill_that_writes_it(tmp_path: Path) -> None:
    with pytest.raises(config.ConfigError, match="setup-loop"):
        config.load(tmp_path)


def test_loop_start_names_the_tailnet_address_of_the_watch_page(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_config(tmp_path)
    settings = config.load(tmp_path)
    monkeypatch.setattr(cli, "watch_answers", lambda port: True)
    monkeypatch.setenv("DISPLAY", "")
    monkeypatch.setenv("WAYLAND_DISPLAY", "")

    monkeypatch.setattr(watch, "addresses", lambda: ["127.0.0.1", "100.64.0.7"])
    assert cli.open_watch(settings, "DEMO-33") == "http://100.64.0.7:8790/#/demo/DEMO-33"

    monkeypatch.setattr(watch, "addresses", lambda: ["127.0.0.1"])
    assert cli.open_watch(settings, "DEMO-33") == "http://127.0.0.1:8790/#/demo/DEMO-33"


def test_loop_watch_restarts_once_its_new_code_holds_still() -> None:
    stamps = iter(["old", "old", "pulling", "new", "new", "newer"])
    checks: list[float] = []

    cli.wait_for_new_code(lambda: next(stamps), checks.append)

    # It waits out the pull that is still writing, and restarts on the code the pull left.
    assert len(checks) == 4


def test_the_code_stamp_changes_when_a_file_of_the_loop_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "cli.py").write_text("")
    (tmp_path / "watch.py").write_text("")
    monkeypatch.setattr(cli, "__file__", str(tmp_path / "cli.py"))
    before = cli.code_stamp()

    os.utime(tmp_path / "watch.py", ns=(1, 1))

    assert [name for name, _ in before] == ["cli.py", "watch.py"]
    assert cli.code_stamp() != before
