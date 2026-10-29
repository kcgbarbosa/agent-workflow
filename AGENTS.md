# agent-workflow

The skills, the subagent tiers, the loop, and the switchboard that every repo of KC's uses. `README.md` gives the layout.
KC's global instructions are `config/CLAUDE.md`, which `install.sh` links to `~/.claude/CLAUDE.md`, so they reach every repo. This file holds only what applies in this repo.

- Run the repo checks with `uv run --no-project --with pytest pytest tests` at the root, and `uv run pytest` in `loop/` and in `switchboard/`.
- `skills/setup-loop/loop.md` is the design the loop follows. `loop/CLAUDE.md` gives the rules for a change to it.
- `config/settings.json` is linked as `~/.claude/settings.json`. Never put a token in it, and check `git diff config/` before a commit.

## Issue tracker

Jira, project `AW`. The key is the commit scope, as in `feat(AW-12): add the gate`. A pull request here must not name a key of another project, such as `PITCH`, because a merge would move that ticket to Done.
