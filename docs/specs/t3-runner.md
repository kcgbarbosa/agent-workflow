# T3 runner

Epic: https://kcgbarbosa.atlassian.net/browse/AW-40. Key persona: the owner. ADRs: 0001 to 0008. This file holds the requirements of the runner that replaces the loop.

## Problem Statement

The owner works in T3 Code, but the loop's agents run outside it, so following a ticket means a separate watch page, and stepping in means leaving the conversation that holds the context. The loop has grown to thousands of lines, with holds and settings that make merging slower than the gate, staging and the release tag require.

## Solution

Each ticket is built in its own T3 thread, the same kind of thread the owner starts by hand. A small script runs on a timer, reads Jira, GitHub and T3, does the next action for each ticket and exits. The agent writes the code and opens the pull request. The gate decides the merge. Production still changes only on the owner's release tag.

## User Stories

### The queue (Must)

US-1. As the owner, I want a ticket that is To Do, has the repo's component, is not Flagged, and whose blockers have all merged to start at a later tick, so that making a ticket ready is all I do.
US-2. As the owner, I want a ticket in Backlog or another status not to start, so that an idea costs no tokens.
US-3. As the owner, I want a ticket with a blocker that has not merged to wait, so that it never builds on code that is not on `main`.
US-4. As the owner, I want ready tickets to start by priority, then key, so that the priority I set is the order.
US-5. As the owner, I want a ticket of another component, or with none, left untouched, so that one repo's runner never touches another's tickets.
US-6. As the owner, I want a ticket's thread titled `<KEY>: <summary>`, so that I can find it in T3 by key.
US-7. As the owner, I want no new thread for a ticket that has a thread whose title starts with `<KEY>:`, and a side thread that only names the key left alone, so that a ticket never builds twice and a side thread never blocks a build.
US-8. As the owner, I want no new thread for a ticket that has an open or merged pull request for its key, so that a thread I started by hand under another title is not duplicated.
US-9. As the owner, I want each new thread to start in its own worktree from `main`, on the ticket's branch, with the configured provider and model, so that threads never share a checkout.

### The limit (Must)

US-10. As the owner, I want a new thread to start only while threads with an active agent turn plus stuck tickets are under the limit, so that a burst does not exhaust usage or the host.
US-11. As the owner, I want a ticket whose pull request waits on the gate not to count against the limit, so that a slow gate does not hold up new work.
US-12. As the owner, I want a proposed Bug, Flagged with no thread, not to count against the limit, so that an unapproved report takes no place.
US-13. As the owner, I want fix and retry messages sent before new starts in a tick, so that work in progress finishes first.
US-14. As the owner, I want a message that would pass the limit to wait for a later tick, so that the limit holds for every agent turn the runner starts.

### The gate and merge (Must)

US-15. As the owner, I want auto-merge on for each open pull request of a ticket that is not a draft, so that a green pull request merges with no step from me.
US-16. As the owner, I want a draft pull request left alone until I mark it ready, so that I can hold one by hand.
US-17. As the owner, I want a red required check sent to the ticket's thread with the failing check names, so that the agent that knows the change fixes it.
US-18. As the owner, I want a merge conflict with `main` sent to the ticket's thread, so that the agent resolves it.
US-19. As the owner, I want each fix message recorded as a pull request comment that names the attempt and the head SHA, so that the count survives with no local state and I can read it on GitHub.
US-20. As the owner, I want one fix message for each head SHA, so that a failure is never sent twice.
US-21. As the owner, I want no fix message while the thread has an active agent turn or checks are pending, so that the agent is not interrupted by a result it is about to change.
US-22. As the owner, I want the ticket Flagged when the attempts reach the cap and the pull request is still red or in conflict, so that a ticket that makes no progress stops spending usage.

### Stopped threads (Must)

US-23. As the owner, I want a thread that waits on a question Flagged at once, so that no retry burns a turn on something only I can answer.
US-24. As the owner, I want a thread that failed, or completed with no pull request, sent one "continue" message, so that a dropped step costs one cheap turn.
US-25. As the owner, I want that thread Flagged when it stops again with no pull request, so that a real failure reaches me.
US-26. As the owner, I want the "continue" recorded as a Jira comment, so that the count survives with no local state.
US-27. As the owner, I want a thread that shows an active turn with no update for the quiet period Flagged, so that a hung session does not hold a place silently.
US-28. As the owner, I want a ticket with an open pull request and no thread Flagged when it needs a fix, so that the runner never starts a second thread to fix it.

### Being told (Must)

US-29. As the owner, I want a Jira comment that starts `Stuck:` and gives the step and the reason each time the runner sets Flagged, so that I can read why on the ticket.
US-30. As the owner, I want one ntfy notification with the key, the reason and a link to the thread when the runner sets Flagged, so that I hear only when I must act.
US-31. As the owner, I want no notification for a start, a fix or a merge, so that a notification always means I must act.

### After I step in (Must)

US-32. As the owner, I want a Flagged ticket left alone by every action, so that the runner never works against me.
US-33. As the owner, I want an unflagged ticket to continue from what the tick sees, so that I never restart anything by hand.
US-34. As the owner, I want attempts and retries counted only since the latest `Stuck:` comment, so that unflagging gives the ticket a fresh count and it is not flagged again at once.

### Jira status (Must)

US-35. As the owner, I want In Progress on a ticket that has a thread and no pull request, In Review on one with an open pull request, and Done on one whose pull request merged, so that the board shows the truth with no one setting it.
US-36. As the owner, I want a ticket whose pull request merged with no runner thread set Done, so that a hand-built ticket closes the same way.
US-37. As the owner, I want an Epic set Done when its last child is Done, so that the board closes with no step from me.
US-38. As the owner, I want a pull request that deletes the spec when every Epic that links it is Done, and the Spec line of the Epic pointed at the head of `main`, so that the repo keeps only open specs as `docs/agents/issue-tracker.md` gives.

### Determinism (Must)

US-39. As the owner, I want the same state of Jira, GitHub and T3 always to give the same actions, so that I can predict and test what the runner does.
US-40. As the owner, I want one log line for each action and each skip with its reason, so that I can see why a ticket did or did not move.
US-41. As the owner, I want `runner tick --dry-run` to print the actions with no write, so that I can check it before I turn it on.
US-42. As the owner, I want a tick that cannot read Jira, GitHub or T3 to exit non-zero with no writes, so that a partial read never drives an action.
US-43. As the owner, I want a repeat tick after a crash to do no action twice, so that a restart needs no recovery.

### Behind the scenes (Must)

US-44. As the maintainer, I want the limit, the fix cap, the quiet period, the provider and the model in the repo's runner config with defaults, so that a value changes with no code change.
US-45. As the maintainer, I want the runner to stand alone, so that a change to it reaches no other part of the repo.
US-46. As the maintainer, I want `make check` to run the runner's checks, so that the gate covers it.
US-47. As the maintainer, I want a command that installs the timer and the service for a repo, and one that removes them, so that the switch-over is one step and easy to reverse.

## Implementation Decisions

- A new `runner` folder at the repo root, in TypeScript that Node runs as it is, in the loop's style: only syntax Node can strip. The `runner` command has `tick`, `tick --dry-run`, `install` and `uninstall`.
- The tick is three steps. `read` gathers the state, with no writes. `decide` is a pure function from that state and the config to a list of actions. `act` performs them. `--dry-run` stops before `act`.
- Reads in `read`: the tickets of the repo's component that are not Done, with their comments, blockers and parent, from Jira; each ticket's pull requests and required checks from `gh`, by the key in the branch name or a `(<KEY>):` scope in the title; threads from `t3`, as Further Notes gives.
- Actions of `decide`: start a thread, send a message, comment on a pull request, comment on a ticket, set a status, set Flagged, notify, turn on auto-merge, complete an Epic, archive a spec.

For each ticket, the first match decides:

| Order | The tick sees                                                    | Action                                                                |
| ----- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1     | A merged pull request                                            | Done, then the Epic check                                             |
| 2     | Flagged                                                          | None. With a thread it holds a place against the limit                |
| 3     | An open draft pull request                                       | In Review only                                                        |
| 4     | A thread with a pending question                                 | Stuck                                                                 |
| 5     | A thread active, quiet longer than the quiet period              | Stuck                                                                 |
| 6     | An open pull request, checks pending or thread active            | In Review, auto-merge on                                              |
| 7     | An open pull request, green                                      | In Review, auto-merge on                                              |
| 8     | An open pull request, red or in conflict, this head SHA not sent | Under the cap with a thread: comment and send. Else Stuck             |
| 9     | A thread active                                                  | In Progress                                                           |
| 10    | A thread stopped, no pull request                                | No `continue` since the latest `Stuck:`: comment and send. Else Stuck |
| 11    | No thread, no pull request, ready                                | Under the limit: start, In Progress. Else wait                        |
| 12    | Anything else                                                    | None                                                                  |

- Stuck means: the `Stuck:` Jira comment, Flagged, and the ntfy notification, in that order, once. A crash between them is safe, because a Flagged ticket takes no further action, and the owner reads the comment.
- A red pull request whose head SHA was already sent, with the thread stopped, takes no action. A new push or the owner moves it on. The agent's fix either pushes a new head SHA or the thread is stopped with the same SHA: after the quiet period measured from the attempt's comment, that counts as Stuck, so a fix turn that pushes nothing cannot wait forever.
- Fix attempts count pull request comments the runner wrote, newer than the latest `Stuck:` comment on the ticket. The cap is `fix_attempts`, default 3 (ADR-0003). The limit is `limit`, default 3. The quiet period is `quiet_minutes`, default 60. `provider` and `model` have defaults of `claudeAgent` and `claude-opus-5-5`.
- The first message of a thread names the ticket and tells the agent to run `/implement`, then `/pr`, on the branch the runner gave it, to read the ticket's comments, and which checks the gate runs so it runs only the ones that cover its change. A repo's config can add a line to it.
- The branch is `<type>/<KEY>-<slug>`: `fix` for a Bug and `feat` otherwise, as `docs/agents/issue-tracker.md` gives.
- Secrets are the Jira email and token and the ntfy topic, read the way the loop reads them, from Bitwarden Secrets Manager or the environment. The runner needs no Claude token, because T3 owns the agent's account.
- `install` writes a user systemd timer and a oneshot service, every 2 minutes, named `runner-<repo>`. A running oneshot service does not start again, so two ticks of one repo cannot overlap.
- The repo's Jira and GitHub calls live in the runner.
- Switchboard reads progress from `t3 thread list` and blocked work from Jira Flagged. It reads runner threads and does not message them. Its prompt and its README say so.
- `correct` becomes a T3 scheduled thread at the switch-over, with no code in the runner.

## Testing Decisions

A good test drives the `runner` command as a subprocess against fakes and reads what the fakes received. It asserts what the owner would see, never an internal function's shape.

The seam is the scenario test of the `runner` command, with fakes for `t3`, `gh` and the Jira API. Prior art: the loop's `tests/world.ts` and `tests/fakes/`. `decide` is pure, so a table of states may test it directly where a scenario would only repeat the same setup. No acceptance suite, as `docs/agents/testing.md` gives.

| Test                                                                                     | Stories             |
| ---------------------------------------------------------------------------------------- | ------------------- |
| A ready ticket starts a thread with the title, the worktree, the branch and the model    | US-1, US-6, US-9    |
| Backlog, other component, no component, and an unmerged blocker do not start             | US-2, US-3, US-5    |
| Three ready tickets start in priority, then key, order up to the limit                   | US-4, US-10         |
| A thread with the key, or a pull request for the key, stops a second start               | US-7, US-8          |
| A pull request waiting on the gate and a proposed Bug take no place. A stuck ticket does | US-11, US-12, US-10 |
| Fix messages go before new starts, and wait when they would pass the limit               | US-13, US-14        |
| Auto-merge turns on for an open pull request, and not for a draft                        | US-15, US-16        |
| A red check and a conflict are sent once per head SHA, with a comment                    | US-17 to US-20      |
| Nothing is sent while the thread is active or checks are pending                         | US-21               |
| The cap flags the ticket. A fix turn that pushes nothing flags after the quiet period    | US-22               |
| A question flags at once, with no retry                                                  | US-23               |
| A stopped thread gets one continue, then flags                                           | US-24, US-25, US-26 |
| A quiet active thread flags. A pull request with no thread flags when it needs a fix     | US-27, US-28        |
| Flagging writes the comment and one notification, and a merge notifies nothing           | US-29, US-30, US-31 |
| A Flagged ticket gets no action. Unflagging continues with a fresh count                 | US-32, US-33, US-34 |
| Status follows what the tick sees, including a hand-built merged pull request            | US-35, US-36        |
| The last child sets the Epic Done, and the spec is archived by pull request              | US-37, US-38        |
| The same state twice gives the same actions, and a second tick repeats none              | US-39, US-43        |
| Every action and skip logs a line, and a dry run writes nothing                          | US-40, US-41        |
| A failed read of each source exits non-zero with no writes                               | US-42               |
| Config defaults load, and each value changes behaviour                                   | US-44               |
| Install writes the timer and service with fakes, and uninstall removes them              | US-47               |

US-45 and US-46 are shown by the gate running the new target with the loop gone.

## Out of Scope

- A status page or a usage view. Technical and user-visible. Reason: the T3 sidebar and Switchboard replace them. None planned.
- Blast levels, labels, holds and path globs. User-visible. Reason: ADR-0004. None planned.
- A stack's port sets and cleanup. Technical. Reason: ADR-0005 makes them the repo's, and agent-workflow has no stack. Picked up when Pitchridge moves to the runner, no ticket yet.
- Moving Pitchridge. Technical. Reason: it needs its port sets first (ADR-0005), and it builds in T3 threads by hand until then. No ticket yet.
- A limit shared across repos. Technical. Reason: one repo uses the runner at first. Decide at the Pitchridge move.
- A separate Claude account for runner threads. Technical. Reason: the owner has one. None planned.
- Setting effort from the runner. Technical. Reason: the `t3` CLI has no flag for it. None planned.

## Further Notes

Measured on 2026-11-04 on t14, `t3` v0.1.5, with scratch threads on a scratch project, since removed, and T3's source at e68e19d6:

- `t3 thread start --wait` exits 0 with `status: completed` and 2 with `status: waiting`. The runner does not use `--wait`, because a tick must exit.
- `t3` prints log lines on stdout, so JSON parses only with `--log-level error` before the subcommand.
- `t3 thread list --json` shows a thread waiting on a question as `running`. Only `t3 thread show --json` gives `pendingRequestCount` and `activeRunId`, so the tick reads `show` for each ticket's thread.
- A thread failure is `status: failed`. T3 marks a usage limit as `failed` with an error class the CLI does not print (ADR-0007). A real limit and a real failed run were not produced, so a failed thread's output is taken from T3's source.
- `updatedAt` does not move during a long foreground tool call: a 100-second command showed no change until it ended. A test run longer than `quiet_minutes` flags a healthy thread, which costs an unflag.
- The project's default model was ignored for a CLI-started thread, so the runner always passes `--provider` and `--model`. Effort was not measured.
- Project scripts with `runOnWorktreeCreate` did not fire for a CLI-started thread (ADR-0005).
- A `--title` held through one short turn of a scratch thread. Runner-started threads were not observed.
- `--project` and the positional project match only a path inside the main checkout, not a T3 worktree, so the runner passes the main checkout.
- The links `t3` prints use `127.0.0.1`. The link in a notification needs the tailnet address, which is a config value.
- With `storageCleanup.worktreeOnMerge` on, T3's source removes a worktree whose pull request merged, on its own schedule. Not observed on a real merge.

To check on the first real run, since no scratch thread could show them: that a merged ticket's worktree goes away, and that `pullRequests` on a thread is not needed, because the tick finds pull requests with `gh`.

The owner retired the loop on 2026-11-04, before the runner's first real run, with no rollback kept beyond `git revert`. The gate's settings moved from `loop.toml` to `gate.toml`. A repo pinned to an older gate commit, such as Pitchridge, keeps reading `loop.toml` until it moves its pin.

Pitchridge's branch protection requires `gate / check` and `gate / review`, not `gate / fuzz`. A Pitchridge move should decide this.
