# The loop

The `loop` command turns each ready ticket of the queue into a pull request, unattended. Read the fixed design it follows first, at `~/.claude/skills/setup-loop/loop.md`. Both live in this repo, in `loop/` and `skills/setup-loop/loop.md`, and `loop/CLAUDE.md` gives the rules for a change to them. `loop.toml` holds the values the command reads. This file holds the other settings of this repo.

The loop runs from `~/dev/agent-workflow`, through the `~/.local/bin/loop` link that `install.sh` makes, while it builds this same repo. Each ticket's pull request merges to `main` when the gate passes, and the next `loop start` fast-forwards the checkout, so a run builds on the loop as it was when the run started.

## Settings

### Run

On t14: `cd ~/dev/agent-workflow && loop start`, which fast-forwards the checkout first and starts the dispatcher, which builds each ready ticket of the queue. `loop stop` ends the dispatcher, every worker, and `loop correct`. `loop ticket <KEY>` builds one ticket to merge in its own unit, and `loop stop <KEY>` ends it and flags the ticket. An Epic with tickets in machines too, such as AW-8, is built by the dispatcher of each repo, and each builds only its own tickets. From another device, run it from a T3 Code thread on t14.

### Tracker

Jira, project `AW`. `loop.toml` gives the site. Children are `parent = <Epic key>`. Edges are the "Blocks" link type, which `to-tickets` writes.
Each ticket's Jira component is the repo it changes, `agent-workflow` or `machines`. `loop.toml` sets no `component`, so the dispatcher here builds the `agent-workflow` tickets.

### Status and stuck marker

The loop sets In Progress when a ticket starts, In Review when its pull request opens, Done when it merges, and Done on the Epic when its last ticket merges. A stuck ticket gets the Jira Flagged field and a comment. KC sets priority and the sprint.

### Human steps

A step only KC can do gets no ticket. A Flagged ticket is an agent's ticket that waits on KC, and the dispatcher's next poll starts it once it is unflagged. KC's `gh` login on t14 has admin on the repo, so an agent can change repo settings through `gh api`. When auto mode holds such a change, KC approves it from the phone.

### Branches and commits

`docs/agents/issue-tracker.md` gives the key format and the branch format.

### Gate

The shared merge gate, through `.github/workflows/pull-request.yml`. It runs `make check`, and `make check-docs` on a docs-only pull request. `loop.toml` turns the fuzz job on, gives the agent hint, and runs `make loop-deps` in each new worktree. `make check` starts with every check of `lefthook.yml`, the list a commit runs.

### Blast radius

No `[blast]` globs, so the agent's `blast` value alone sets a pull request's level.

### Stack per worktree

Not used. The repo has no stack, and the tests run against fakes.

### UI review

Not used. The only screen is the `loop watch` page, and KC checks a change to it by eye. `node loop/tests/seed.ts [port]` serves the page over a seeded run, at port 8791 by default, so a review opens each panel at phone width with no real run.

### Agent

`loop.toml` gives the head agent's model and effort.

### Connectors

None. `.mcp.json` lists no server, so each agent run gets no MCP server.

### Notifications

`[notify] kind` is not set, so this is the ntfy topic that Pitchridge uses. A message holds the key and the status only, and the `AW-` key tells the two projects apart. The design file gives the Slack webhook, `[notify] kind` and `secret`.

### Secrets

The Jira email and API token, the ntfy topic, and the Claude token of the loop account. Each lives in the `loop` project of Bitwarden Secrets Manager under its env var name, shared with Pitchridge, and `loop.toml` `secrets` lists the names. The design gives how a run gets them.

### Hosts

`t14` only. The machine README, `~/dev/machines/README.md`, gives how to reach it.

### Correct

`[correct]` is not set, so the dispatcher does not start `loop correct`. `loop correct` runs it by hand.

### Limits

In `loop.toml`.

### Queue

`[queue]` `filter` and `poll_minutes` in `loop.toml`. This repo's file sets neither, so the defaults of the design apply.

### Logs

`~/.local/state/agent-workflow-loop/`: `tickets/<KEY>/` for a worker, `correct/` for `loop correct`, and the dispatcher's `decisions.jsonl` at its top. `loop report <KEY>` reads a ticket's log, and `loop report` lists the day's merges and its share of each plan window. The `loop watch` page serves every project on t14, as the design gives.

### Setup

`/setup-loop` sets up Secrets Manager and t14's token file, as its Secrets section gives. Until then, `loop start` refuses with the one that is missing.
