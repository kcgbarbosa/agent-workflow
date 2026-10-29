# agent-workflow

The skills, the subagent tiers, the loop, and the switchboard that every repo of KC's uses. `README.md` gives the layout.
KC's global instructions are `config/CLAUDE.md`, which `install.sh` links to `~/.claude/CLAUDE.md`, so they reach every repo. This file holds only what applies in this repo.

- Run the repo checks with `uv run --no-project --with pytest pytest tests` at the root, and `uv run pytest` in `loop/` and in `switchboard/`.
- `skills/setup-loop/loop.md` is the design the loop follows. `loop/CLAUDE.md` gives the rules for a change to it.
- `config/settings.json` is linked as `~/.claude/settings.json`. Never put a token in it, and check `git diff config/` before a commit.

## Agent skills

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/`. Read `docs/agents/domain.md` before you read or write a glossary term, an ADR, or any other document.

### Issue tracker

Jira, project `AW`. See `docs/agents/issue-tracker.md`.

### Testing

No acceptance suite. See `docs/agents/testing.md`.

### Workflow

grill-with-docs → to-spec → to-tickets → implement, or the loop. See `docs/agents/workflow.md`.

### Loop

The loop builds an Epic of this repo. See `docs/agents/loop.md`.
When a run fails, a wrong value is fixed in `loop.toml` or `docs/agents/loop.md`. Anything else is a loop bug, fixed in `loop/` and `skills/setup-loop/loop.md` in one pull request.
