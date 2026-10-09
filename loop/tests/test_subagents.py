"""The subagent tiers and the dispatch rule that each agent run gets."""

from __future__ import annotations

import json
import re

from loop.run import AGENTS, DISPATCH

EFFORTS = {"low", "medium", "high", "xhigh", "max"}


def test_each_tier_has_a_description_a_prompt_a_model_an_effort_and_its_tools() -> None:
    tiers = json.loads(AGENTS.read_text())

    assert tiers
    for name, tier in tiers.items():
        assert tier["description"] and tier["prompt"], name
        # A full model ID, because what an alias names moves with the CLI version.
        assert tier["model"].startswith("claude-"), name
        assert tier["effort"] in EFFORTS, name
        assert tier["tools"] and all(isinstance(tool, str) for tool in tier["tools"]), name
        # Context grows each turn, and a cheap model's prompt past its short-prompt rate costs more.
        assert isinstance(tier["maxTurns"], int) and tier["maxTurns"] > 0, name
    assert not {"Edit", "Write"} & {*tiers["runner"]["tools"], *tiers["scout"]["tools"]}


def test_the_dispatch_rule_names_each_tier_and_leaves_the_models_to_the_tiers() -> None:
    rule = DISPATCH.read_text()

    for name in json.loads(AGENTS.read_text()):
        assert f"`{name}`" in rule
    assert not re.search(r"haiku|sonnet|opus|fable|claude-", rule, re.IGNORECASE)
