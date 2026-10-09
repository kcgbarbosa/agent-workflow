# agent-workflow

Skills and global `AGENTS.md`. `~/.claude` links into a clone of this repo.

```
skills/<name>/   a skill (SKILL.md) or a mod (.claude-plugin/plugin.json)
agents/<name>.md a subagent tier on a cheaper model. The loop gives its agents the same files
loop/            the loop command, which builds an Epic unattended. Its design is skills/setup-loop/loop.md
AGENTS.md        linked to ~/.claude/CLAUDE.md, the name Claude Code reads
install.sh       makes the links and installs the loop command. Safe to run again
tests/           the repo-level checks that .github/workflows/repo.yml runs. Run them with uv run --no-project --with pytest pytest tests
licenses/        upstream licenses. Keep
```

`install.sh` skips a real folder or file at a link target and names it. It leaves other entries in `~/.claude/skills` and `~/.claude/agents` alone.

## Computer

Clone to `~/dev/agent-workflow`, run `./install.sh`.

- Change a skill or `AGENTS.md`: edit here, commit, push. Other computers `git pull`; the links make it live.
- Add or remove a skill or a tier: add or remove its folder or file, run `./install.sh` again.
- The `trial` tier needs `"worktree": {"baseRef": "head"}` in `~/.claude/settings.json`, so its worktree starts from your last commit. `install.sh` says so when the setting is missing. The setting also makes `claude --worktree` start from your current commit.
- Change the loop: edit `loop/`. `loop/CLAUDE.md` gives the rules. `loop start` fast-forwards each computer's clone, so a merged change reaches every host on its next run.
- After a rename or move of a linked file, run `./install.sh` again on every computer.

## Cloud environment setup script

```bash
git clone --depth 1 https://github.com/kcgbarbosa/agent-workflow.git "$HOME/agent-workflow" \
  && "$HOME/agent-workflow/install.sh" \
  || echo "agent-workflow: clone failed, the session has no personal skills"
```

- Clones with no token, so the repo must stay public.
- A session gets the version pushed before it started, not later pushes.
