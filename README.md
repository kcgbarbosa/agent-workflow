# agent-workflow

Skills, the loop, and KC's global instructions. `~/.claude` links into a clone of this repo.

```
skills/<name>/   a skill (SKILL.md) or a mod (.claude-plugin/plugin.json)
agents/<name>.md a subagent tier on a cheaper model. The loop gives its agents the same files
loop/            the loop command, which builds an Epic unattended. Its design is skills/setup-loop/loop.md
switchboard/     a phone line to the Claude Code sessions on the T14, for the car. Its README is the setup
config/          the shared Claude Code files settings.json, statusline.sh, keybindings.json and notify.sh. install.sh links them into ~/.claude
docs/            project-skills.md, the registry of skills that live in project repos
config/CLAUDE.md the global instructions, linked to ~/.claude/CLAUDE.md, the name Claude Code reads
AGENTS.md        this repo's own instructions
install.sh       makes the links and installs the loop command. Safe to run again
tests/           the repo-level checks. make check runs them with the loop, switchboard and shellcheck checks
.github/         the shared merge gate, workflows/gate.yml, which every repo calls, and this repo's own call to it
Makefile         make check, the gate's check for this repo
licenses/        upstream licenses. Keep
```

`install.sh` skips a real folder or file at a skill, tier or `CLAUDE.md` target and names it. It leaves other entries in `~/.claude/skills` and `~/.claude/agents` alone.

For the four files from `config/`, a real file at the target is moved to `<name>.bak`, or to a name with a timestamp suffix when that exists, and a message goes to stderr. A link to somewhere outside this repo is left alone and reported.

## Computer

Clone to `~/dev/agent-workflow`, run `./install.sh`. On a machine that `chezmoi` manages, the order is: pull, run `./install.sh`, then `chezmoi apply`.

- Change a skill or `config/CLAUDE.md`: edit here, commit, push. Other computers `git pull`; the links make it live.
- Add or remove a skill or a tier: add or remove its folder or file, run `./install.sh` again.
- Linux needs `notify-send` (package `libnotify-bin`) for notifications. Without it, the hook does nothing.
- `config/settings.json` is public, and `~/.claude/settings.json` is a link to it. Never put a token in it. Claude Code can write to it through the link, for example when you choose "always allow", so check `git diff config/` before you commit.
- Project repos use `AGENTS.md`. Never create `CLAUDE.md` or `CLAUDE.local.md` in one, because either hides `AGENTS.md`.
- Change the loop: edit `loop/`. `loop/CLAUDE.md` gives the rules. `loop start` fast-forwards each computer's clone, so a merged change reaches every host on its next run.
- After a rename or move of a linked file, run `./install.sh` again on every computer.

## Cloud environment setup script

```bash
git clone --depth 1 https://github.com/kcgbarbosa/agent-workflow.git "$HOME/agent-workflow" \
  && "$HOME/agent-workflow/install.sh" \
  || echo "agent-workflow: clone failed, the session has no personal skills"

curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
  | tar -xz -C /usr/local/bin gitleaks
apt-get update && apt-get install -y fd-find tree jq && ln -sf "$(command -v fdfind)" /usr/local/bin/fd
```

- Clones with no token, so the repo must stay public.
- A session gets the version pushed before it started, not later pushes.
- The environment's allowed domains must include the hosts the downloads use: `github.com`, `release-assets.githubusercontent.com`, `mcp.workos.com` and the Ubuntu package mirror.
- Verified: the `gitleaks` download and unpack (reports 8.30.1), and the `fd-find` and `tree` install with the `fd` link, on Ubuntu 24.04 as root. Unverified: the `apt-get update` and the `jq` install, the clone and `install.sh` lines in the cloud, and whether the script runs as root there. Without root, put `sudo` before `apt-get` and use a writable folder on `PATH` for the other two commands.
