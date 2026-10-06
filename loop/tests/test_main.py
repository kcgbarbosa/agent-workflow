"""The `loop` command: the config file and the prerequisite check."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest
from conftest import write_config

from loop import config
from loop.cli import Refused, main, read_secrets


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


def test_the_config_gives_each_worktree_its_own_stack(tmp_path: Path) -> None:
    write_config(tmp_path)
    settings = config.load(tmp_path)

    assert settings.stack_env(2, "DEMO-7") == {
        "DB_PORT": "55452",
        "API_PORT": "8020",
        "COMPOSE_PROJECT_NAME": "demo-demo-7",
    }
    assert settings.state_dir == Path.home() / ".local/state/demo-loop"


def test_a_repo_without_a_stack_gets_no_stack_env(tmp_path: Path) -> None:
    write_config(tmp_path)
    text = (tmp_path / config.FILE).read_text()
    start = text.index("[stack]")
    (tmp_path / config.FILE).write_text(text[:start] + text[text.index("[secrets]") :])

    assert config.load(tmp_path).stack_env(2, "DEMO-7") == {}


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
