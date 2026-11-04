# agent-workflow

The skills, the subagent tiers, the runner, and the switchboard that every repo of KC's uses. `README.md` gives the layout.
KC's global instructions are `config/CLAUDE.md`, which `install.sh` links to `~/.claude/CLAUDE.md`, so they reach every repo. This file holds only what applies in this repo.

- The gate runs `make check` on each pull request, so an agent runs the tests that cover its change, not the full `make check`. `docs/agents/testing.md` gives the commands.
- `docs/specs/t3-runner.md` and `docs/adr/` are the design the runner follows. `runner/CLAUDE.md` gives the rules for a change to it.
- `config/settings.json` is linked as `~/.claude/settings.json`. Never put a token in it, and check `git diff config/` before a commit.

## Agent skills

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/`. Read `docs/agents/domain.md` before you read or write a glossary term, an ADR, or any other document.

### Issue tracker

Jira, project `AW`. See `docs/agents/issue-tracker.md`.

### Testing

No acceptance suite. See `docs/agents/testing.md`.

### Workflow

grill-with-docs → to-spec → to-tickets → the runner or a T3 Code thread → the gate. See `docs/agents/workflow.md`.

### Runner

The runner builds each ready ticket with the `agent-workflow` component. See `docs/agents/runner.md`.
When a run fails, a wrong value is fixed in `runner.toml` or `docs/agents/runner.md`. Anything else is a runner bug, fixed in `runner/`.
