---
name: setup-runner
description: Set up the runner in a repo, a timer that builds each ready ticket of the queue in a T3 thread, with a pull request that merges when the shared merge gate passes.
disable-model-invocation: true
---

# Setup runner

The **runner** is a stateless tick on a timer: it reads Jira, GitHub and T3, does the next action for each ticket, and exits. `docs/adr/` in agent-workflow gives the decisions. This skill fills in one repo.

Do `/setup-repo` first, so the repo is on the shared gate and has its agent docs.

## Process

1. **Register the project.** `t3 project add <path to the main checkout>`, unless T3 has it.
2. **Check the tracker has Backlog.** The repo's Jira project needs the status `Backlog`, in the To Do category, as its initial status, and as the first column of its board. Moving a ticket from Backlog to To Do is the owner's approval of its build, and without the status every new ticket builds at once. Stop until the project has it.
3. **Write `runner.toml`** at the repo root: `component`, the repo's Jira component, and `jira_url`. `runner/src/config.ts` in agent-workflow gives the other keys and their defaults. Use `first_message` for a line every thread of this repo needs.
4. **Write `docs/agents/runner.md`**, with `docs/agents/runner.md` of agent-workflow as its shape, and point `AGENTS.md` at it.
5. **Give a stack its ports**, in a repo with a stack, as ADR-0005 gives. Each port reads an env var with today's port as its default. The repo's `make` target claims a free port set from a fixed list when a stack starts, writes the env file, and stops any stack whose worktree is gone, with its database. When the product checks the origin, such as a bucket's CORS rule, the list holds only the ports it allows.
6. **Check it.** Run `runner tick --dry-run` under `bws run` from the repo, and check each line against the board.
7. **Turn it on, with the user's yes.** `runner install` from the main checkout. `runner uninstall` turns it off.

Done when a dry run prints what the user expects, and the user has seen the timer's first start of a ticket as a T3 thread.
