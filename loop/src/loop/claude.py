"""How the loop runs `claude`: the version it needs, the model of its reviews, and the settings it passes."""

from __future__ import annotations

import json
import re
import shlex
import subprocess
from pathlib import Path
from typing import Any

from . import tiers
from .config import Config

# The reviews run in their own sessions, so the head agent's context stays small. At the same cost per task,
# Opus scores as well as Sonnet or better, so the reviews run on Opus at a set effort.
REVIEW_MODEL = "claude-opus-5-5"
REVIEW_EFFORT = "medium"
# The oldest `claude` that knows each model the tiers name and prices the long prompts of Haiku 5.5.
MIN_CLAUDE = (2, 1, 295)
# The loop keeps the stack volumes for KC, so no agent run deletes one.
VOLUME_DENY = ("Bash(docker volume rm *)", "Bash(docker volume prune*)", "Bash(docker system prune*)")
# Where Claude Code makes the worktree of a `trial` subagent: in the main checkout, also for a ticket's run.
TRIALS = Path(".claude/worktrees")


def claude_version() -> str:
    """The version that `claude --version` prints, such as 2.1.295, or "" when it prints none."""
    try:
        result = subprocess.run(["claude", "--version"], capture_output=True, text=True, timeout=30)
    except OSError, subprocess.TimeoutExpired:
        return ""
    match = re.search(r"\d+\.\d+\.\d+", result.stdout)
    return match[0] if match else ""


def run_setup(config: Config) -> dict[str, Any]:
    """What the agents of a run run on. The start line keeps it, so `loop report` can tell two runs apart."""
    return {
        "claude": claude_version(),
        "agent": f"{config.agent_model} {config.agent_effort}",
        "context": config.agent_context_tokens,
        "tiers": {name: f"{tier['model']} {tier['effort']}" for name, tier in tiers.load().items()},
        "review": f"{REVIEW_MODEL} {REVIEW_EFFORT}",
    }


def agent_settings(config: Config) -> str:
    """The permission rules and the auto mode rules of every agent run, for `--settings`.

    Nobody answers a prompt in a loop run, and a denied action can make a ticket stuck. These rules let the
    routine actions of a ticket run without the classifier, and tell the classifier what the loop owns.
    """
    gates = sorted({shlex.join(gate) for gate in (config.ticket_gate, config.merge_gate)})
    allow = [rule for gate in gates for rule in (f"Bash({gate})", f"Bash({gate} *)")]
    named = " and ".join(f"`{gate}`" for gate in gates)
    environment = [
        "$defaults",
        "Host containment: an unattended build loop runs this session. Nobody is at the keyboard. The "
        f"loop owns each git worktree and run folder under {config.state_dir}.",
        f"Trial worktrees: each worktree under {config.repo / TRIALS} belongs to a `trial` subagent, "
        "which tries one approach there and removes its change when it reports.",
    ]
    classifier_allow = [
        "$defaults",
        f"Loop gates: running {named} in a loop worktree is allowed, also with the output redirected to a "
        "file. The loop runs the same commands as its gates.",
    ]
    deny: tuple[str, ...] = ()
    if config.stack:
        project = f"{config.name}-<ticket key>"
        environment.append(
            f"Loop stacks: each Docker Compose project named `{project}`, such as `{config.name}-abc-12`, "
            "and its containers are a disposable test stack of the loop. No person works in one. The "
            f"project `{config.name}` without a key is KC's own stack, and it is not one of them."
        )
        classifier_allow.append(
            f"Loop stacks: stopping, removing, or starting again a container or Compose project named "
            f"`{project}`, for example `docker stop {config.name}-abc-11-db-1` or `docker compose down`, "
            "is allowed to free a port or reset a test stack. The volumes stay."
        )
        deny = VOLUME_DENY
    settings = {
        "permissions": {"allow": allow, "deny": list(deny)},
        "autoMode": {"environment": environment, "allow": classifier_allow},
        # A `trial` branches from the ticket's last commit, not from the default branch.
        "worktree": {"baseRef": "head"},
    }
    return json.dumps(settings)
