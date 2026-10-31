---
name: setup-loop
description: Set up the deterministic loop in a repo, a script that turns each ticket of an Epic into a pull request that merges when the shared merge gate passes.
disable-model-invocation: true
---

# Setup loop

The **loop** is a script that builds one Epic unattended, one pull request per ticket. The script decides which ticket runs next, and the shared merge gate decides whether it passed. Agents only implement tickets.

[loop.md](loop.md) holds the fixed design and names the settings each repo fills in. [values.md](values.md) says how to find and choose each value, with the check that shows it is wrong. This skill fills in the settings for the current repo and plans the build.

## Process

### 1. Explore

Find the facts behind every settings section of loop.md yourself. Read the Find paragraph of each section in values.md, and look at:

- the issue tracker doc (`docs/agents/issue-tracker.md`) and the children of a real Epic, to see how blocking edges are stored
- the Makefile, package scripts, and CI workflows, for the gate
- Compose files and dev server configs, for fixed ports and the test database
- the frontend layout, for the UI paths
- the auth flow, for how a headless browser can sign in as each role
- seed scripts and the workflow doc
- `claude mcp list`, for the connectors an agent gets
- the machine README, `~/.local/share/chezmoi/README.md`, for the hosts, what each has installed, and how secrets reach them

An existing `docs/agents/loop.md` means a re-run. Start from its values.

Done when each settings section has a found value or a named decision for the user, and no hard-coded port, status name, or link type is left unread.

### 2. Settle

Invoke the `grilling` skill to settle the open decisions, with the settings sections as the design tree. Recommend the choice from the Choose paragraph of the section in values.md, with its reason, and say why when this repo differs.

Run the Check list of each section against the repo before you call its value settled. A check that fails is a setup step for step 4, or a ticket for step 5 when it needs code, not a reason to change the value.

Done when every settings section holds a value, or "not used" with the reason, and every check has a result.

### 3. Write

Draft `loop.toml` at the repo root with every key a settings section names, then `docs/agents/loop.md`: a pointer to the fixed design at `~/.claude/skills/setup-loop/loop.md`, then each settings section. A value with a `loop.toml` key lives in `loop.toml` only. The repo doc links to the fixed design, to `loop.toml`, and to the machine README, and restates none of them. Draft these edits with them:

- the issue tracker doc: the rule from the Human steps section, so `to-tickets` follows it
- the workflow doc: the loop builds an Epic, and `implement` stays for a single ticket
- the go-live checklist, if the repo has one: an item to undo each development-only setting, such as the headless sign-in of the UI review and its test users
- the `## Agent skills` block of the repo's `AGENTS.md`: one line pointing to `docs/agents/loop.md`, and one line routing a loop failure: a wrong value is fixed in this repo's `loop.toml` or `docs/agents/loop.md`; anything else is a loop bug, fixed in `~/dev/agent-workflow`, where `loop/` and `skills/setup-loop/loop.md` change in one pull request

Show the drafts, take edits, then write.

Done when the user has approved each file and it is written.

### 4. Set up

Do every setup step now, in this session, and plan none of them as a ticket: host prerequisites, tracker fields and settings, repo settings through `gh`, test accounts in development, and secrets. Use the command line or the API for each. For a step that has none, such as a click in a web console, tell the user the exact click, wait, then check the result yourself. Run the section's Check again after each step.

Done when every check of step 2 that needs no code passes.

### 5. Plan the build

List the tickets that build the loop in this repo. Each setting that needs code the repo does not have yet becomes a ticket:

- prefactors: the shared merge gate through `/setup-repo`, per-worktree ports, the same test database as production, seed data, per-role sign-in, the browser tests and their screenshot diffs
- a `make loop` target, or the repo's equivalent, that runs `loop start`
- doc tickets for anything step 3 did not cover

The loop cannot build itself, so `implement` builds these one ticket at a time. Give the user the list and the next command: `/to-spec`, then `/to-tickets`. Offer `/handoff` first when this context is long.

Done when the user has the ticket list and the next command.
