# agent-workflow

KC's Claude Code skills and global `CLAUDE.md`. This repo is the only copy.
`~/.claude` on each computer, and in each cloud session, links into a clone of it.

```
skills/<name>/           one folder for each skill (SKILL.md) or mod (.claude-plugin/plugin.json)
CLAUDE.md                the global instructions, linked to ~/.claude/CLAUDE.md
install.sh               makes the links. Safe to run again
licenses/                the upstream licenses
```

## On a computer

Clone the repo to `~/dev/agent-workflow`, then run `./install.sh`.

| To                            | Do                                                      |
| ----------------------------- | ------------------------------------------------------- |
| Change a skill or `CLAUDE.md` | Edit it here, then commit and push                      |
| Get the changes on a computer | `git pull`. The links point here, so the change is live |
| Add or remove a skill         | Add or remove its folder, then run `./install.sh` again |

`install.sh` does not replace a real folder or file. It names each one it skips.
It does not touch the other entries in `~/.claude/skills`.

## In a cloud session

Paste this block into the setup script of the cloud environment on claude.ai/code:

```bash
git clone --depth 1 https://github.com/kcgbarbosa/agent-workflow.git "$HOME/agent-workflow" \
  && "$HOME/agent-workflow/install.sh" \
  || echo "agent-workflow: clone failed, the session has no personal skills"
```

The block clones the repo with no token, so it works only while the repo is public.
A new session gets the last pushed version. A session that is open does not get later pushes.

## Where the skills came from

`calm` is KC's own mod. Claude Code loads it as `calm@skills-dir`, and `/calm` turns it on.
`find-skills` is from [vercel-labs/skills](https://github.com/vercel-labs/skills). `unslop` is KC's own.
Every other skill is from [mattpocock/skills](https://github.com/mattpocock/skills), under `skills/engineering/` or `skills/productivity/`.
These are now KC's own versions. To take a later upstream change, compare the upstream file with the file here and copy what you want.

`licenses/` holds the MIT license of each upstream repo.
