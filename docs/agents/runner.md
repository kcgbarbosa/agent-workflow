# The runner

The `runner` command turns each ready ticket of the queue into a T3 thread and a pull request. `runner/src/decide.ts` gives what it does for each state of a ticket, and `docs/adr/` why. `runner.toml` holds the values it reads, and `runner/src/config.ts` gives the other keys and their defaults. This file holds the other settings of this repo.

## Settings

### Run

On t14: `cd ~/dev/agent-workflow && runner install` writes a user systemd timer, `runner-agent-workflow`, that runs one tick every 2 minutes. `runner uninstall` stops and removes it. `runner tick --dry-run` prints what a tick would do, and writes nothing. It needs its secrets, so run it under `bws run`.

### Starting a build

A new ticket starts as Awaiting Approval, and the owner approves its build by moving it to To Do. A ticket starts when it is To Do, has the `agent-workflow` component, is not Flagged, and its blockers are Done. To start a build by chat or by voice, ask an agent to move the ticket to To Do. A ticket moved back to Awaiting Approval stops: the runner sends its thread nothing, and turns on no auto-merge. A thread started by hand for a ticket needs a title that starts with `<KEY>:`, and the ticket out of Awaiting Approval.

### Following a build

Each ticket is a T3 thread titled `<KEY>: <summary>`. A stuck ticket is Flagged in Jira, with a `Stuck:` comment and one ntfy notification. To go on, answer in the thread and unflag the ticket.

### Secrets

The Jira email and API token and the ntfy topic. Each lives in the `loop` project of Bitwarden Secrets Manager under its env var name, a name that predates the runner. The timer reads them through `~/.config/bws/token.env`. The agent's Claude account is T3's.

### Gate

The shared merge gate, through `.github/workflows/pull-request.yml`. `gate.toml` holds its settings, and `actions/fuzz/action.yml` gives the `[fuzz]` keys.

### Stack per worktree

Not used. The repo has no stack, and the tests run against fakes.

### Hosts

`t14` only. The machine README, `~/dev/machines/README.md`, gives how to reach it.
