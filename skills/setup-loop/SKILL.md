---
name: setup-loop
description: Set up the deterministic loop in a repo, a script that builds an Epic's tickets with agents and lands only what passes its gates.
disable-model-invocation: true
---

# Setup loop

The **loop** is a script that builds one Epic unattended. The script makes every decision: which ticket runs next, whether a ticket passed, what lands on the Epic branch. Agents only implement tickets.

[loop.md](loop.md) holds the fixed design and the settings each repo fills in. This skill fills in the settings for the current repo and plans the build.

## Process

### 1. Explore

Find the facts behind every settings section of loop.md yourself. Look at:

- the issue tracker doc (`docs/agents/issue-tracker.md`) and the children of a real Epic, to see how blocking edges are stored
- the Makefile, package scripts, and CI workflows, for the gate commands
- Compose files and dev server configs, for fixed ports and the test database
- the frontend layout, for the UI paths
- the auth flow, for how a headless browser can sign in as each role
- seed scripts and the workflow doc
- `claude mcp list`, for the connectors an agent gets
- the machine README, `~/.local/share/chezmoi/README.md`, for the hosts, what each has installed, and how secrets reach them

An existing `docs/agents/loop.md` means a re-run. Start from its values.

Done when each settings section has a found value or a named decision for the user.

### 2. Settle

Invoke the `grilling` skill to settle the open decisions, with the settings sections as the design tree. Recommend the value from `~/dev/pitchridge/docs/agents/loop.md`, the worked example, when it fits this repo, and say why when it does not.

Done when every settings section holds a value, or "not used" with the reason.

### 3. Write

Draft `loop.toml` at the repo root with every key a settings section names, then `docs/agents/loop.md`: a pointer to the fixed design at `~/.claude/skills/setup-loop/loop.md`, then each settings section. A value with a `loop.toml` key lives in `loop.toml` only. The repo doc links to the fixed design, to `loop.toml`, and to the machine README, and restates none of them. Draft these edits with them:

- the issue tracker doc: the rule from the Human steps section, so `to-tickets` follows it
- the workflow doc: the loop builds an Epic, and `implement` stays for a single ticket
- the go-live checklist, if the repo has one: an item to undo each development-only setting, such as full connector access
- the `## Agent skills` block of the repo's `AGENTS.md` or `CLAUDE.md`: one line pointing to `docs/agents/loop.md`, and one line routing a loop failure: a wrong value is fixed in this repo's `loop.toml` or `docs/agents/loop.md`; anything else is a loop bug, fixed in `~/dev/agent-workflow`, where `loop/` and `skills/setup-loop/loop.md` change in one pull request

Show the drafts, take edits, then write.

Done when the user has approved each file and it is written.

### 4. Plan the build

List the tickets that build the loop in this repo. Each setting the repo does not support yet becomes a ticket:

- prefactors: per-worktree ports, the same test database as production, seed data, per-role sign-in, the UI review skill, the browser MCP config
- a `make loop` target, or the repo's equivalent, that runs `loop start`
- human tickets: host prerequisites, tracker automation, test accounts, secrets
- doc tickets for anything step 3 did not cover

The loop cannot build itself, so `implement` builds these one ticket at a time. Give the user the list and the next command: `/to-spec`, then `/to-tickets`. Offer `/handoff` first when this context is long.

Done when the user has the ticket list and the next command.
