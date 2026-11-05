# The runner

The `runner` command turns each ready ticket of the queue into a T3 thread and a pull request. `runner/src/decide.ts` gives what it does for each state of a ticket, and `docs/adr/` why. `runner.toml` holds the values it reads, and `runner/src/config.ts` gives the other keys and their defaults. This file holds the other settings of this repo.

## Settings

### Run

On t14: `cd ~/dev/agent-workflow && runner install` writes a user systemd timer, `runner-agent-workflow`, that runs one tick every 2 minutes. `runner uninstall` stops and removes it. `runner tick --dry-run` prints what a tick would do, and writes only the Today file. It needs its secrets, so run it under `bws run`.

### Merged changes

`runner install` also writes `runner-update`, a user timer and oneshot service that every repo shares. On the odd minutes it runs `git pull --ff-only origin main` in the checkout that holds the runner, so a merge to `main` reaches the runner and the skills on the host within two minutes. A thread's worktree does not move with it. `runner uninstall` removes the pair with the last repo's timer.

A failed pull changes nothing and notifies no one. `journalctl --user -u runner-update` gives why: the checkout is on another branch, a local change or commit stops the fast-forward, or the fetch failed. A local change that the merge does not touch stops nothing, and it stays in the checkout.

### Starting a build

A new ticket starts as Awaiting Approval, and the owner approves its build by moving it to To Do. A ticket starts when it is To Do, has the `agent-workflow` component, is not Flagged, and its blockers are Done. To start a build by chat or by voice, ask an agent to move the ticket to To Do. A ticket moved back to Awaiting Approval stops: the runner sends its thread nothing, turns auto-merge off, and makes an open pull request a draft. Moved back to To Do, that draft is marked ready with auto-merge on. ADR-0009 gives the rule. A thread started by hand for a ticket needs a title that starts with `<KEY>:`, and the ticket out of Awaiting Approval.

### Following a build

Each ticket is a T3 thread titled `<KEY>: <summary>`. A stuck ticket is Flagged in Jira, with a `Stuck:` comment and one post in `#agent-workflow`. When Slack refuses the post, the next tick posts it again, and only then flags the ticket. To go on, answer in the thread and unflag the ticket.

### Today file

Each tick ends by writing `~/.local/state/runner/<component>/today.json`, or under `$XDG_STATE_HOME` when that is set, so a page can show what waits on the owner with no secret of its own. A dry run writes it too. A tick whose read fails writes nothing, so the file's age shows the timer's health. The runner never reads the file.

| Field              | Holds                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `at`               | The time of the tick, in ISO 8601                                                                                                               |
| `awaitingApproval` | The count of Awaiting Approval tickets, with no Epic                                                                                            |
| `stuck`            | Each Flagged ticket as `{ key, reason }`: its latest `Stuck:` comment, or `Flagged` when it has none                                            |
| `drafts`           | Each open draft pull request of the repo as `{ number, title }`                                                                                 |
| `red`              | Each open pull request of the repo with a red required check as `{ number, title, author, checks }`, the author by login and the checks by name |

### Daily tasks

`tasks/` holds the prompts of two T3 scheduled tasks, `Daily triage` at 06:00 in this repo, and `Daily correct` at 06:30 in each repo with an installed runner. The times are the host's clock, which is America/Toronto. Run `runner tasks` on t14 after a change to a file there, since T3 keeps its own copy of each prompt. It starts one thread for each task, which updates the task of the same title, prints each reply, and exits non-zero when a thread fails. Running it again is safe.

### Secrets

The Jira email and API token, and the Slack webhook of `#agent-workflow`, `SLACK_WEBHOOK_KC_WORKFLOW`. `slack_webhook_env` in `runner.toml` changes the name of the last. The daily triage reads `SLACK_WEBHOOK_DM`, the webhook of the owner's DM. Each lives in the `loop` project of Bitwarden Secrets Manager under its env var name, a name that predates the runner. The timer reads them through `~/.config/bws/token.env`. The agent's Claude account is T3's.

### Gate

The shared merge gate, through `.github/workflows/pull-request.yml`. `gate.toml` holds its settings, and `actions/fuzz/action.yml` gives the `[fuzz]` keys.

### Stack per worktree

Not used. The repo has no stack, and the tests run against fakes.

### Hosts

`t14` only. The machine README, `~/dev/machines/README.md`, gives how to reach it.
