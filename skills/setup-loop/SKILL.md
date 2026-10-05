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
- reachable hosts (`tailscale status`, `~/.ssh/config`) and what each has installed
- chezmoi, for how secrets reach each host

An existing `docs/agents/loop.md` means a re-run. Start from its values.

Done when each settings section has a found value or a named decision for the user.

### 2. Settle

Invoke the `grilling` skill to settle the open decisions, with the settings sections as the design tree. Recommend the pitchridge value from loop.md when it fits this repo, and say why when it does not.

Done when every settings section holds a value, or "not used" with the reason.

### 3. Write

Draft `docs/agents/loop.md` from loop.md: the fixed design as it stands, then each settings section with only this repo's value. Draft these edits with it:

- the issue tracker doc: the rule from the Human steps section, so `to-tickets` follows it
- the workflow doc: the loop builds an Epic, and `implement` stays for a single ticket
- the go-live checklist, if the repo has one: an item to undo each development-only setting, such as full connector access
- the `## Agent skills` block of the repo's `AGENTS.md` or `CLAUDE.md`: one line pointing to `docs/agents/loop.md`

Show the drafts, take edits, then write.

Done when the user has approved each file and it is written.

### 4. Plan the build

List the tickets that build the loop in this repo. Each setting the repo does not support yet becomes a ticket:

- prefactors: per-worktree ports, the same test database as production, seed data, per-role sign-in, the UI review skill, the browser MCP config
- the loop script, written from the fixed design in `docs/agents/loop.md`. When this skill folder has a `reference/` folder, the ticket adapts that code instead.
- human tickets: host prerequisites, tracker automation, test accounts, secrets
- doc tickets for anything step 3 did not cover

The loop cannot build itself, so `implement` builds these one ticket at a time. Give the user the list and the next command: `/to-spec`, then `/to-tickets`. Offer `/handoff` first when this context is long.

Done when the user has the ticket list and the next command.
