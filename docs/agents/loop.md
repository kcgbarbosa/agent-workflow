# The loop

The `loop` command turns each ticket of an Epic into a pull request, unattended. Read the fixed design it follows first, at `~/.claude/skills/setup-loop/loop.md`. Both live in this repo, in `loop/` and `skills/setup-loop/loop.md`, and `loop/CLAUDE.md` gives the rules for a change to them. `loop.toml` holds the values the command reads. This file holds the other settings of this repo.

The loop runs from `~/dev/agent-workflow`, through the `~/.local/bin/loop` link that `install.sh` makes, while it builds this same repo. Each ticket's pull request merges to `main` when the gate passes, and the next `loop start` fast-forwards the checkout, so a run builds on the loop as it was when the run started.

## Settings

### Run

On t14: `cd ~/dev/agent-workflow && loop start <Epic key>`, which fast-forwards the checkout first. `loop stop <Epic key>` ends a run. An Epic with tickets in machines too, such as AW-8, takes one `loop start <Epic key>` in each repo, and each builds only its own tickets. From another device, run it from a T3 Code thread on t14.

### Tracker

Jira, project `AW`. `loop.toml` gives the site. Children are `parent = <Epic key>`. Edges are the "Blocks" link type, which `to-tickets` writes.
Each ticket's Jira component is the repo it changes, `agent-workflow` or `machines`, or `manual` for a step only KC can do. `loop.toml` sets no `component`, so a run here builds the `agent-workflow` tickets.

### Status and stuck marker

The loop sets In Progress when a ticket starts, In Review when its pull request opens, Done when it merges, and Done on the Epic when its last ticket merges. A stuck ticket gets the Jira Flagged field and a comment. KC sets priority and the sprint.

### Human steps

A step only KC can do is a ticket with the component `manual`, which no loop builds. KC sets it Done, and the next run starts the tickets that wait on it. KC's `gh` login on t14 has admin on the repo, so an agent can change repo settings through `gh api`. When auto mode holds such a change, KC approves it from the phone.

### Branches and commits

`docs/agents/issue-tracker.md` gives the key format and the branch format.

### Gate

The shared merge gate, through `.github/workflows/pull-request.yml`. It runs `make check`, and `make check-docs` on a docs-only pull request. `loop.toml` turns the review on, gives the agent hint, and runs `make loop-deps` in each new worktree. `make check` starts with every check of `lefthook.yml`, the list a commit runs.

### Stack per worktree

Not used. The repo has no stack, and the tests run against fakes.

### UI review

Not used. The only screen is the `loop watch` page, and KC checks a change to it by eye. `node loop/tests/seed.ts [port]` serves the page over a seeded run, at port 8791 by default, so a review opens each panel at phone width with no real run.

### Agent

`loop.toml` gives the head agent's model and effort.

### Connectors

None. `.mcp.json` lists no server, so each agent run gets no MCP server.

### Notifications

The ntfy topic that Pitchridge uses. A message holds the key and the status only, and the `AW-` key tells the two projects apart.

### Secrets

The Jira email and API token, the ntfy topic, and the Claude token of the loop account. Each lives in the `loop` project of Bitwarden Secrets Manager under its env var name, shared with Pitchridge, and `loop.toml` `secrets` lists the names. The design gives how a run gets them.

### Hosts

`t14` only. The machine README, `~/dev/machines/README.md`, gives how to reach it.

### Limits

In `loop.toml`.

### Logs

`~/.local/state/agent-workflow-loop/<Epic key>/`. The `loop watch` page serves every project on t14, as the design gives.

### Setup

`/setup-loop` sets up Secrets Manager and t14's token file, as its Secrets section gives. Until then, `loop start` refuses with the one that is missing.
