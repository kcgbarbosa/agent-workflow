# The loop

The `loop` command turns each ticket of an Epic into a pull request, unattended. Read the fixed design it follows first, at `~/.claude/skills/setup-loop/loop.md`. Both live in this repo, in `loop/` and `skills/setup-loop/loop.md`, and `loop/CLAUDE.md` gives the rules for a change to them. `loop.toml` holds the values the command reads. This file holds the other settings of this repo.

The loop runs from `~/dev/agent-workflow`, through the `~/.local/bin/loop` link that `install.sh` makes, while it builds this same repo. Each ticket's pull request merges to `main` when the gate passes, and the next `loop start` fast-forwards the checkout, so a run builds on the loop as it was when the run started.

## Settings

### Run

On t14: `cd ~/dev/agent-workflow && loop start <Epic key>`, which fast-forwards the checkout first. `loop stop <Epic key>` ends a run. From another device, ask a Remote Control session on t14 to run it.

### Tracker

Jira, project `AW`. `loop.toml` gives the site. Children are `parent = <Epic key>`. Edges are the "Blocks" link type, which `to-tickets` writes.
`name_landed_keys_only` is on. The loop reads and checks the key and uses it for nothing, as the design's Tracker section gives. If a merged pull request leaves its ticket open, an agent moves it to Done through the Jira API.

### Status and stuck marker

The loop sets In Progress when a ticket starts and In Review when its pull request opens, and Done on the Epic when its last ticket merges. A stuck ticket gets the Jira Flagged field and a comment. KC sets priority and the sprint.

### Human steps

None planned. KC's `gh` login on t14 has admin on the repo, so an agent can change repo settings through `gh api`. When auto mode holds such a change, KC approves it from the phone.

### Branches and commits

`docs/agents/issue-tracker.md` gives the key format and the branch format.

### Gate

The shared merge gate, through `.github/workflows/pull-request.yml`. It runs `make check`, and `make check-docs` on a docs-only pull request. `loop.toml` turns the review on and gives the agent hint. shellcheck runs through `uvx --from shellcheck-py`, so the host needs no install.

### Stack per worktree

Not used. The repo has no stack, and the tests run against fakes.

### UI review

Not used. The only screen is the `loop watch` page, and KC checks a change to it by eye.

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
