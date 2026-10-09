"""The subagent tiers and the dispatch rule that each agent run gets."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from loop import tiers
from loop.run import DISPATCH

EFFORTS = {"low", "medium", "high", "xhigh", "max"}


def test_each_tier_has_a_description_a_prompt_a_model_an_effort_and_its_tools() -> None:
    found = tiers.load()

    assert found
    for name, tier in found.items():
        assert tier["description"] and tier["prompt"], name
        # A full model ID, because what an alias names moves with the CLI version.
        assert tier["model"].startswith("claude-"), name
        assert tier["effort"] in EFFORTS, name
        assert tier["tools"] and all(isinstance(tool, str) for tool in tier["tools"]), name
        # Context grows each turn, and a cheap model's prompt past its short-prompt rate costs more.
        assert isinstance(tier["maxTurns"], int) and tier["maxTurns"] > 0, name
    read_only = {*found["runner"]["tools"], *found["scout"]["tools"], *found["reader"]["tools"]}
    assert not {"Edit", "Write"} & read_only


def test_a_trial_runs_in_its_own_worktree() -> None:
    found = tiers.load()

    assert found["trial"]["isolation"] == "worktree"
    assert all("isolation" not in tier for name, tier in found.items() if name != "trial")


def test_each_frontmatter_value_reads_the_same_as_yaml() -> None:
    """Claude Code reads the files as YAML, and the loop reads them as `key: value` lines."""
    for path in tiers.files():
        frontmatter = path.read_text().split("---")[1]
        for line in frontmatter.strip().splitlines():
            value = line.partition(": ")[2]
            assert ": " not in value and " #" not in value, f"{path.name}: {line}"
            assert value[:1] not in set("\"'[]{}>|*&!%@`"), f"{path.name}: {line}"


def test_a_tier_file_without_frontmatter_or_with_another_name_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(tiers, "FOLDER", tmp_path)
    (tmp_path / "scout.md").write_text("Find code.\n")
    with pytest.raises(tiers.TierError, match="frontmatter"):
        tiers.load()

    (tmp_path / "scout.md").write_text("---\nname: finder\ndescription: Finds code.\n---\nFind code.\n")
    with pytest.raises(tiers.TierError, match="Name it after its file"):
        tiers.load()


def test_the_dispatch_rule_names_each_tier_and_leaves_the_models_to_the_tiers() -> None:
    rule = DISPATCH.read_text()

    for name in tiers.load():
        assert f"`{name}`" in rule
    assert not re.search(r"haiku|sonnet|opus|fable|claude-", rule, re.IGNORECASE)
