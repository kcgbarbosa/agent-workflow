# agent-workflow

Skills, the runner, and KC's global instructions. `~/.claude` links into a clone of this repo.

```
skills/<name>/   a skill (SKILL.md) or a mod (.claude-plugin/plugin.json)
bots/chief.md    the Chief's prompt, which the owner pastes into Grokbot
bots/chief-checks.md  what the owner sends the Chief to test what it can do
agents/<name>.md a subagent tier on a cheaper model
runner/          the runner command, a stateless tick that starts a T3 thread for each ready ticket. docs/agents/runner.md gives how it runs here
tasks/           the prompts of the daily T3 scheduled tasks, which runner tasks registers
switchboard/     a phone line to the Claude Code sessions on the T14, for the car. Its README is the setup
config/          the shared Claude Code files settings.json, statusline.sh, keybindings.json, notify.sh and format-markdown.ts, the hook that runs Prettier on each Markdown file an agent edits. install.sh links them into ~/.claude
docs/            project-skills.md, the registry of skills that live in project repos
config/CLAUDE.md the global instructions, linked to ~/.claude/CLAUDE.md, the name Claude Code reads
AGENTS.md        this repo's own instructions
install.sh       makes the links and installs the runner command. Safe to run again
tests/           the repo checks on Vitest, and the gate scripts' tests on pytest. make check runs them after the checks of lefthook.yml
lefthook.yml     every format, lint and policy check of this repo, run at each commit and first in make check
.github/         the shared merge gate, workflows/gate.yml, which every repo calls, and this repo's own call to it
actions/         the gate's fuzz job, a composite action that the gate runs beside the check
Makefile         make check, the gate's check for this repo
licenses/        upstream licenses. Keep
```

`install.sh` skips a real folder or file at a skill, tier or `CLAUDE.md` target and names it. It leaves other entries in `~/.claude/skills` and `~/.claude/agents` alone.

For the shared files from `config/`, a real file at the target is moved to `<name>.bak`, or to a name with a timestamp suffix when that exists, and a message goes to stderr. A link to somewhere outside this repo is left alone and reported.

## Computer

Clone to `~/dev/agent-workflow`, run `./install.sh`. On a machine that `chezmoi` manages, the order is: pull, run `./install.sh`, then `chezmoi apply`.

- Change a skill or `config/CLAUDE.md`: edit here, commit, push. Other computers `git pull`; the links make it live.
- Add or remove a skill or a tier: add or remove its folder or file, run `./install.sh` again.
- Linux needs `notify-send` (package `libnotify-bin`) for notifications. Without it, the hook does nothing.
- `config/settings.json` is public, and `~/.claude/settings.json` is a link to it. Never put a token in it. Claude Code can write to it through the link, for example when you choose "always allow", so check `git diff config/` before you commit.
- Every Claude Code account on a computer shares one set of project memories. `install.sh` links `<homePath>/projects` of each T3 Code account to `~/.claude/projects`, so transcripts are shared too. `autoMemoryDirectory` is one flat folder for every repo, and one config dir holds one login, so neither fits. A linked account below full access loads memories, but its write through the link is refused.
- Project repos use `AGENTS.md`. Never create `CLAUDE.md` or `CLAUDE.local.md` in one, because either hides `AGENTS.md`.
- Change the runner: edit `runner/`. `runner/CLAUDE.md` gives the rules, and `docs/agents/runner.md` how a merged change reaches the host.
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
