# The loop

The `loop` command builds one Epic unattended. Read the fixed design it follows first, at `~/.claude/skills/setup-loop/loop.md`. Both live in this repo, in `loop/` and `skills/setup-loop/loop.md`, and `loop/CLAUDE.md` gives the rules for a change to them. `loop.toml` holds the values the command reads. This file holds the other settings of this repo.

The loop runs from `~/dev/agent-workflow`, an editable install, while it builds this same repo. Its work lands on the Epic branch, so the running loop and the skills its agents read stay at `main` until KC merges the Epic PR.

## Settings

### Run

On t14, after the main checkout is clean: `cd ~/dev/agent-workflow && git pull --ff-only && loop start <Epic key>`. `loop stop <Epic key>` ends a run. From another device, ask a Remote Control session on t14 to run it.

### Tracker

Jira, project `AW`. `loop.toml` gives the site. Children are `parent = <Epic key>`. Edges are the "Blocks" link type, which `to-tickets` writes.
`name_landed_keys_only` is on. If a merged Epic PR leaves its tickets open, an agent moves them to Done through the Jira API.

### Status and stuck marker

The loop sets In Progress when a ticket starts and In Review when it lands. A stuck ticket gets the Jira Flagged field and a comment. KC sets priority and the sprint.

### Human steps

None planned. KC's `gh` login on t14 has admin on the repo, so an agent can change repo settings through `gh api`. When auto mode holds such a change, KC approves it from the phone.

### Branches and commits

`docs/agents/issue-tracker.md` gives the key format and the branch format.

### Gates

`loop.toml` gives one command for both gates. It runs `make check` when a Makefile exists, and the root, loop, and switchboard checks with shellcheck before that, as CI does. shellcheck runs through `uvx --from shellcheck-py`, so the host needs no install.

### Acceptance tests

Not used. `docs/agents/testing.md` gives the reason.

### Stack per worktree

Not used. The repo has no stack, and the tests run against fakes.

### UI review

Not used. The only screen is the `loop watch` page, and KC checks a change to it by eye.

### Demo

Not used.

### Agent

`loop.toml` gives the head agent's model and effort.

### Connectors

None. `.mcp.json` lists no server, so each agent run gets no MCP server.

### Notifications

The ntfy topic that Pitchridge uses. A message holds the key and the status only, and the `AW-` key tells the two projects apart.

### Secrets

The Jira email and API token, the ntfy topic, and the Claude token of the loop account. `loop.toml` maps each env var to its Bitwarden item, the same items as Pitchridge. Pitchridge's `docs/agents/loop.md` gives how each item was made. `loop secrets` copies them to a file on the host, as the design gives.

### Hosts

`t14` only. The machine README, `~/.local/share/chezmoi/README.md`, gives how to reach it.

### Limits

In `loop.toml`.

### Logs

`~/.local/state/agent-workflow-loop/<Epic key>/`. The `loop watch` page serves every project on t14, as the design gives.

### Setup

Run `loop secrets` once on t14 from this repo, and again after a secret changes:

```sh
BW_SESSION=$(bw unlock --raw) && export BW_SESSION && loop secrets; bw lock
```
