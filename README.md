# agent-workflow

Skills and global `CLAUDE.md`. `~/.claude` links into a clone of this repo.

```
skills/<name>/   a skill (SKILL.md) or a mod (.claude-plugin/plugin.json)
CLAUDE.md        linked to ~/.claude/CLAUDE.md
install.sh       makes the links. Safe to run again
licenses/        upstream licenses. Keep
```

`install.sh` skips a real folder or file at a link target and names it. It leaves other entries in `~/.claude/skills` alone.

## Computer

Clone to `~/dev/agent-workflow`, run `./install.sh`.

- Change a skill or `CLAUDE.md`: edit here, commit, push. Other computers `git pull`; the links make it live.
- Add or remove a skill: add or remove its folder, run `./install.sh` again.

## Cloud environment setup script

```bash
git clone --depth 1 https://github.com/kcgbarbosa/agent-workflow.git "$HOME/agent-workflow" \
  && "$HOME/agent-workflow/install.sh" \
  || echo "agent-workflow: clone failed, the session has no personal skills"
```

- Clones with no token, so the repo must stay public.
- A session gets the version pushed before it started, not later pushes.
