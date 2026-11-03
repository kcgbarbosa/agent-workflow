# Per-ticket loop

Epic: https://kcgbarbosa.atlassian.net/browse/AW-33. Key persona: the owner. ADRs: none. This file holds the design of the loop as one worker per ticket, the blast-radius and fuzz gate, bug tickets from intake, and the Chief in Slack.

## Problem Statement

The owner has one host, one Claude plan, many repos, and an inbox that every alert reaches. Work reaches the loop only when the owner starts a run for one Epic by hand, and the run reads its ticket list once, so a bug filed during the run waits for the next one. The run holds every ticket of the Epic in one process, so a crash of the process stops them all, and only one run of a repo goes at a time. Every pull request merges on green with no one asked, whatever it touches. A second model reads each diff and comments, but nothing tries to break the change. The owner reads raw alerts in email, writes every ticket, and starts every run.

## Solution

The tracker is the queue. One worker builds one ticket from build to merge, as its own process, and a small dispatcher starts a worker for each ready ticket while a slot is free. A worker never waits on a person: it hands the ticket back to the queue, and the dispatcher brings it back when the wait ends. The owner, or the Chief, puts work in the queue by creating or unflagging a ticket. Each pull request carries a blast level that decides whether it merges on green, after a hold, or only when the owner marks it ready. Adversaries try to break each change, and a proven break is a red check. Bug reports become tickets through the Chief, which reads Slack, and the loop reproduces the bug before it fixes it.

## User Stories

### The queue (Must)

US-1. As the owner, I want to start the loop of a repo once, with no Epic key, so that every ticket I make ready builds without a start from me.
US-2. As the owner, I want a ticket to start within a few minutes of becoming ready, so that a bug filed at 10:00 does not wait for tomorrow.
US-3. As the owner, I want the tickets to start in the order of their Jira priority, then their key, so that the priority I set is the schedule.
US-4. As the owner, I want a ticket to be ready only when it has the repo's component, is not Flagged, has no worker, and each of its blockers is Done or merged, so that a ticket never builds on a branch that has not merged.
US-5. As the owner, I want `parallel` tickets to build at once, each in its own worktree and stack slot, so that a bug and an Epic ticket build side by side.
US-6. As the owner, I want a ticket of another component, or with no component, to stay in the queue untouched, so that a ticket of another repo or a human step is never built or flagged.
US-7. As the owner, I want `loop stop` to end the dispatcher and every worker, and `loop stop <KEY>` to end one worker and flag its ticket, so that I can stop one ticket and nothing restarts it until I say so.
US-8. As the owner, I want to start one ticket by hand with `loop ticket <KEY>`, so that I can build a ticket the filter would not pick.
US-9. As the owner, I want a hand start and a dispatcher start to be the same unit, so that a ticket never builds twice at once.
US-10. As the owner, I want a worker that fails on a fault to flag its ticket with the reason, so that a broken ticket stops once and never loops.
US-11. As the owner, I want a crash of one worker to stop one ticket, with the others running on, so that one bad ticket never ends the day's work.
US-12. As the owner, I want an unflagged ticket that has a branch or a pull request to start again where it left off, so that a retry costs no rebuild.
US-13. As the owner, I want the dispatcher to pause when `circuit_breaker` tickets in a row are stuck, and to go on when I unflag one of them, so that a broken environment does not burn the plan.
US-14. As the owner, I want a worker that meets a usage limit to hand its ticket back with no flag, and the dispatcher to start nothing until the limit resets, so that a limit costs no retry and no new session meets it.
US-15. As the owner, I want the loop to archive an Epic's spec and set the Epic Done once every child is Done or merged, also when the last child is a step I did by hand, so that the Epic closes with no step from me.

### Bug tickets (Must)

US-16. As the owner, I want a skill that writes a Bug from a report, with the steps, the environment, the stack trace, and the correct behaviour as "What the user sees" lines, so that the loop has what it needs and no Sentry connector.
US-17. As the owner, I want a Bug the Chief writes to arrive Flagged with a comment that names the report, so that nothing builds before I unflag it.
US-18. As the owner, I want the loop to show the bug twice on the real stack before it fixes it, as the failing acceptance test of the first "What the user sees" line, so that the fix is proven against a reproduction and not a guess.
US-19. As the owner, I want a Bug's branch and pull request to carry `fix`, so that the squash commit says what it is.

### Blast radius (Must)

US-20. As the owner, I want each pull request the loop opens to carry a label `blast:green`, `blast:yellow`, or `blast:red`, so that I see at a glance what could break.
US-21. As the owner, I want the level to be at least what the repo's `[blast]` path globs give for the changed files, so that a change to auth or a release always counts as red.
US-22. As the owner, I want the agent to run the blast-radius skill before it finishes and to raise the level when it finds a wider reach, so that a small-looking change gets the level it deserves.
US-23. As the owner, I want a red pull request to open as a draft, hold no slot while it waits, and go on when I mark it ready, so that nothing I must approve merges on its own and nothing I must approve blocks the queue.
US-24. As the owner, I want a yellow pull request to merge one hour after it is first green, unless I put the `hold` label on it or mark it draft, so that I have a window to object and nothing waits on me when I do not.
US-25. As the owner, I want a green pull request to merge as soon as it is green, as today.

### The fuzz gate (Must)

US-26. As the owner, I want adversaries to try to break each pull request against the real stack, with the ticket's lines as the intent, so that a change is attacked and not only read.
US-27. As the owner, I want a finding to survive only when its reproduction, a test file that the repo's suite runs, fails on a rerun against the pull request in a way that breaks the ticket's lines, so that no finding is an opinion.
US-28. As the owner, I want the surviving findings as one review comment on the pull request, with the text of each reproduction in it, so that the agent and I read the same thing after the runner is gone.
US-29. As the owner, I want the fuzz job to fail when a new finding survives, unless the repo turns blocking off, so that a proven break is a red check and the loop's fix attempt answers it.
US-30. As the owner, I want `blocking` as an off switch that keeps the findings and stops the red check, so that a fuzz that cries wolf is turned down, not removed.
US-31. As the owner, I want the fuzz gate to replace the review, in the gate and in the required checks of each repo, so that one model job runs on each pull request and no pull request waits on a check that never reports.
US-32. As the owner, I want a docs-only pull request to skip the fuzz job, as it skips the review today.

### The Chief in Slack (Must)

US-33. As the owner, I want every alert from Sentry, GitHub, Render, the nightly run, and the loop in the Slack channel of its repo, so that my email holds none of them.
US-34. As the owner, I want the Chief to read each report in a repo's channel, find a duplicate in Jira or write a Bug with the bug skill's shape, and reply once in the thread with its verdict, so that I read tickets and not alerts.
US-35. As the owner, I want the Chief to hand any work beyond a short question to a ticket, never to write code, and never to merge, so that the loop is the only way code lands.
US-36. As the owner, I want the Chief's reply in a thread to say what changed and what waits on me, decidable from the reply alone, so that I act from Slack.
US-37. As the owner, I want the Chief's prompt in git, so that a change to it is a pull request.
US-38. As the owner, I want the loop's notifications to reach a Slack channel, so that the loop and the Chief share one place.

### Behind the scenes (Must)

US-39. As the owner, I want the watch page to show the queue of a repo: the dispatcher's state, each running ticket with its step, the tickets that wait, and the stuck ones, so that I see the day's work and not one Epic.
US-40. As the owner, I want `loop report <KEY>` to break down one ticket's cost, and `loop report` the tickets that merged today, so that the cost per ticket stays visible.
US-41. As the owner, I want each `loop.toml` of a repo to keep loading with its old keys, with a warning for each key the new loop drops, so that no repo breaks on the day the loop changes.
US-42. As the owner, I want the loop to run the `correct` skill once a day when a slot is free, and to open a pull request with no key for each mistake class it makes impossible, so that a repeated correction becomes a check without me.
US-43. As the owner, I want the design file of the loop to describe the per-ticket loop, so that an agent that reads it makes no change for the Epic run.
US-44. As the owner, I want Pitchridge's loop settings, agent docs, and required checks to match the per-ticket loop, with `parallel` at 2, so that the first repo on the new loop runs it on day one.
US-45. As the owner, I want the Chief to read each stuck ticket and to retry once a stop whose fingerprint is a loop or environment fault, so that a stop that is weather never reaches me.
US-46. As the owner, I want the Chief to put an agent's open question to me in the DM with its own suggested answer, and to comment my reply on the ticket and unflag it, so that a decision costs me one word.
US-47. As the owner, I want the Chief to tell me in plain words what the logs say for a stop it cannot classify, so that the stops that need me arrive explained.
US-48. As the owner, I want a fingerprint that sticks twice in seven days to become one AW Bug, Flagged, with the instances as evidence and no design, and never a second ticket for the same fingerprint, so that a repeated loop fault becomes a loop fix and not a pile of tickets.
US-49. As the owner, I want the Chief to create at most two tickets a day without a word from me, and never to split one report into more than one ticket, so that a bad morning never becomes a backlog.
US-50. As the owner, I want the Chief's summary of a pull request to give the diff's file count and line count beside the ticket's lines, so that an over-built fix reads wrong at a glance.
US-51. As the owner, I want every loop agent told to make the smallest change that solves the problem, and a Bug fix to touch the files the reproduction touches, so that a one-line bug gets a one-line fix.
US-52. As the owner, I want `correct` to open at most one pull request per run and to count a class only after two occurrences, so that it fixes the loudest mistake and never floods the gate.

## Implementation Decisions

### The unit of work

- `loop ticket <KEY>` is a launcher, as `loop start` is today: it takes a slot, then starts the transient systemd unit `loop-<name>-<KEY>`, under `bws run`, which runs `loop run-ticket <KEY> --slot <n>`. The worker builds one ticket: worktree, setup, build, push, pull request, wait, fix attempts, merge, status, worktree removal. The fix attempts, the usage pause, the timeout, and the process group rules of the design stay, per ticket. A hand start refuses with one line a ticket that is Flagged, of another component, with no component, or with an active unit, and when no slot is free.
- The state of a ticket is `~/.local/state/<name>-loop/tickets/<KEY>/`: `ticket.md`, `pr-body.md`, `worktree/`, `agent-<n>.jsonl`, `agent-<n>.err`, and `decisions.jsonl`, one JSONL line per step as today, with the key as the run name. The dispatcher writes its own `decisions.jsonl` at the state root, and archive clones go to `repos/` there. The old `<KEY>/` run folders are not read; the owner deletes them.
- A ticket is ready when it carries the repo's component, is not Flagged, has no active unit, its pull request is not merged, and each blocker is Done or merged. Its status is To Do, In Progress, or In Review, so a ticket that left a worker comes back. A ticket whose blocker has an open pull request waits. Stacking goes: a branch always starts from the head of the main branch, and a pull request always targets it.
- A worker ends in one of three ways. Merged: the ticket is Done. Handed back: the ticket keeps its status and no flag, for a draft, a hold, or a usage limit. Stuck: the worker comments `Stuck: <step> <result>` as the first line, the fingerprint, then the reason, the pull request, and the log path, sets the Jira Flagged field, and notifies, for a failed or blocked build, exhausted fix attempts, a timeout, a closed pull request, a wait past its limit, a loop error, or `loop stop <KEY>`, whose comment is `Stopped by the owner`. An unflagged ticket starts again on the same worktree, branch, and pull request, as the restart rule gives.
- A pull request that GitHub reports as conflicting with the main branch is a fix attempt: the worker resumes the session with one message, rebase on the main branch, resolve, and run the tests that cover the change, then pushes, and the gate runs again. A semantic clash that passes alone is the nightly suite's to catch, as today.
- The branch, the commit scope, the pull request title, the body, the status transitions, and the notifications keep their shape. For a Bug, the Loop section of `ticket.md` adds one line: reproduce first, the acceptance test of the first "What the user sees" line fails twice on the stack before the fix.

### The dispatcher

- `loop start`, with no argument, starts `loop dispatch` as the unit `loop-<name>-dispatch`, after the fast-forward and the secret checks the design gives. `loop start <KEY>` and `loop start --filter` go. `loop stop` stops the dispatcher and each worker unit of the repo, and flags nothing. `loop stop <KEY>` stops one worker and flags its ticket.
- Every `poll_minutes`, default 2, the dispatcher reads the tracker with `[queue] filter`, which defaults to `component = <component> AND status in ("To Do", "In Progress", "In Review") AND Flagged is EMPTY ORDER BY priority DESC, key ASC`, reads each ticket's blockers and pull request, and starts a worker for each ready ticket in order while a slot is free. A ticket of another component or with none is never a candidate, so nothing is refused. A handed-back ticket is ready again when its pull request is not a draft, carries no `hold` label, and its hold time has passed.
- The dispatcher owns the slots. A slot is a folder `<state>/slots/<n>`, made with `mkdir`, which is atomic, holding the key and the unit name. The slots are 2 to `parallel + 1`, then the spare slots. Before a start the dispatcher reads `docker ps` as the design gives and takes the first free slot whose ports no other Compose project holds. The slot frees when the unit is no longer active. A hand `loop ticket` takes a slot the same way.
- The circuit breaker counts stuck workers in a row. At the limit the dispatcher logs `circuit-breaker` `open`, notifies, and starts no worker until a ticket of the row is no longer Flagged. A worker that logs `usage-pause` with a reset time holds the dispatcher until a minute after it. A worker that ends on a limit with no reset time, or a late one, hands its ticket back, and the dispatcher holds for the design's maximum wait and notifies once.
- After each poll the dispatcher runs the Epic check for the parent of each ticket that merged since the last poll, and once an hour for every open Epic of the project with a child of the repo's component. When every child, of every component, is Done or merged, it sets the Epic Done. A spec can be linked by an Epic in each project, as this one is by AW-33 and PITCH-208: the dispatcher archives it only when every Epic whose Spec line links it is Done, and then repoints the Spec line of each. Only the dispatcher completes an Epic, so two merges never archive at once.

### Blast radius

- `[blast]` in `loop.toml` holds `red` and `yellow`, each a list of path globs, both empty by default, and `hold_minutes`, default 60. After a `done` build the worker reads the changed files of the branch, takes the highest level whose glob matches, and takes the agent's `blast` when it is higher. The agent's output schema gains `blast`, one of `green`, `yellow`, `red`, default `green`, which `implement` fills from the blast-radius skill it runs before it returns. A lower value never lowers the level.
- The worker labels the pull request `blast:<level>` when it opens it and after each push. A level that rises to red after the pull request opened converts it to a draft.
- Red: the pull request opens as a draft, and the worker hands the ticket back. When the owner marks it ready, the dispatcher starts it again and the worker goes on at the wait. Yellow: at the first green the worker writes `Hold until <time>` in the Loop section of the pull request body and hands the ticket back; after the hold, a worker turns auto-merge on, unless the `hold` label is on it or it is a draft, in which case it hands back again. A removed `hold` merges at once when the hold time has passed. Green: auto-merge on at the first green, as today.
- The gate labels nothing. A pull request the loop did not open has no level.

### The fuzz gate

- `gate / fuzz` replaces `gate / review` in the shared gate, in `setup-repo`'s protection step, and in the required checks of each repo on the gate, so no required check stays that never reports. The composite action `actions/fuzz` runs beside the check, on the same runner image, with the repo's toolchain and `CHECK_ENV`, which the review never had: the adversaries need the stack the check has. The job's token writes to pull requests only through the action's script; the adversaries get no `gh` and no token, and each `CHECK_ENV` value is masked as the check masks it.
- `[fuzz]` holds `enabled` (default true), `model` and `effort` (default the gate's inputs, as the review's), `adversaries` (default 3), `blocking` (default true), `setup`, a command list that brings up and seeds the stack (default none, so the adversaries get the checkout alone), and `skip`, the path globs the review skips today. The action reads `[fuzz]` from the base branch, as the review reads `[review]`, so a pull request cannot turn its own fuzz off. The `[review]` keys warn and are ignored. A docs-only pull request skips the job.
- The action runs Claude Code with the `interrogate` skill, carried into this repo's skills from pstack at a pinned commit with its license in `licenses/`, with the pull request's whole diff as the scope and the ticket text of the body as the intent, on each push. Each adversary is a subagent that shares the one stack, follows the repo's rules for rows, writes each reproduction as a test file the repo's suite runs, and reports the command and its output. The action reruns each reproduction on the head, as `interrogate` verifies a finding, and keeps a finding when the output shows the failure and the failure breaks the ticket's lines. It also runs each kept reproduction on the base: a finding whose base output matches its head output is pre-existing, and a finding in new code, whose base run errors or differs, is new.
- The action posts one pull request review comment with the surviving findings, each with its command, its output, and the text of its reproduction in a fold, under the marker `<!-- gate fuzz head=<sha> findings=<n> -->`. The comment lists a pre-existing finding apart, and it fails nothing. The action exits non-zero when a new finding survives or an adversary did not finish, and `blocking` is true. A run in which an adversary did not finish says so in the comment and the log, whatever `blocking` is, and the head agent gets no way to stop an adversary.
- The design line that only deterministic checks decide a merge changes: a check decides a merge, and the fuzz check fails only on a reproduction that fails on rerun, or on a run in which an adversary did not finish. The loop's respond step goes, and with it the rule that findings never make a ticket stuck: a red fuzz check is a red check, the fix-attempt message carries the fuzz findings in place of the review's, and exhausted fix attempts make the ticket stuck.

### Bug tickets

- The `to-bug` skill writes a Jira Bug from a report: a Sentry issue, a Slack message, or a red nightly run. A Bug has no parent Epic. Its body is the ticket body of the issue tracker file, with a **Reproduce** section before "What the user sees": the steps, the environment, the role, and the stack trace and breadcrumbs pasted in as text. Each "What the user sees" line states the correct behaviour. The skill sets the component, sets the ticket Flagged, and comments `Proposed by intake` with the link of the report. Priority stays at the default.
- The issue tracker docs of this repo and of Pitchridge change in two lines: a ticket is a Task under an Epic or a Bug with no parent, and Flagged means the ticket waits on the owner, whether it is stuck, proposed, or dangerous.
- `implement` gains one paragraph for a Bug, the same as the Loop section line. In a repo with no acceptance suite, the reproduction is a test at the seam the repo's testing doc names.

### The Chief

- `bots/chief.md` in this repo holds the Chief's prompt. It gives: the rule that work beyond a short question becomes a ticket, through `to-bug` for a report, and that the Chief never writes code and never merges; the triage rules of a repo's channel, from the benny automation of pstack: read the thread, find a duplicate in Jira first, write a Bug only for a net-new one, reply once in the thread with the verdict and the ticket link, never post a root message; the reply style of `ketchup`: what changed, what waits on the owner, decidable from the reply; the owner's asks come in the DM, and the alerts and the loop's messages in the repo's channel.
- The Chief's prompt also gives the stuck-ticket rule. On a stuck notification it reads the stuck comment, the ticket, and the failed job's log on GitHub, and takes one of three paths. A fingerprint in the loop-fault list, a timeout, a setup failure, no free slot, a usage limit, a runner or Docker failure in the gate's log, or a `FLAKY` line: it unflags once with the comment `Retried by the Chief: <fingerprint>`. An agent question, from the `decisions` on the ticket's comment: it posts the question in the DM with its own suggested answer, comments the owner's reply on the ticket, and unflags. Anything else: it tells the owner in the DM what the log says, in plain words, and touches nothing.
- The Chief's prompt gives the guards. A fingerprint that sticks twice in seven days, on any ticket, becomes one AW Bug: the Chief searches AW for an open ticket with the fingerprint in its title first, and comments the new instance on it when one exists. The Bug it creates is evidence only: a Reproduce section with each instance linked, one "What the user sees" line, that the loop does not stop on the fingerprint, and no Technical checks and no proposed fix. The Chief creates at most two tickets a day without a word from the owner, and posts in the DM instead once the cap is reached. It never splits one report into more than one ticket, and it has no `to-tickets`. Its summary of a pull request gives the diff's file count and line count beside the ticket's lines.
- The Chief runs in Grokbot, with the Slack, email, and Jira connectors. The owner pastes the prompt and sets the connectors by hand. The Chief reads the loop's state from Jira and GitHub, where the loop writes every status, flag, comment, label, and pull request. It reaches no host and no tailnet page.
- `[notify]` gains `kind`, `ntfy` or `slack`, default `ntfy`. With `slack`, the loop posts `{"text": ...}` to the webhook in the secret that `[notify] secret` names, default `SLACK_WEBHOOK_URL`, with the same events and the same message shape. Each repo names its own secret, so its messages reach its own channel.
- Slack: one workspace, a DM with the Chief, and one channel per repo, `#pitchridge` first, that the Sentry, GitHub, and Render apps and the loop's webhook post to. A Gmail filter skips the inbox for each sender that posts to Slack.

### The rest

- `loop correct`: the launcher takes a slot and starts the unit `loop-<name>-correct`, which runs the `correct` skill, carried in from pstack with the same pinning, in a worktree of the main branch, on the commits since the newest merged pull request with the label `correct`, reads also the fix attempts in the loop logs and the fuzz findings, counts a class once it has happened twice, and opens one `chore:` pull request per run, for the most frequent class, with no key, the `correct` label, and auto-merge on; its blast level comes from the globs like any pull request. `[correct]` holds `enabled` (default false) and `hour` (default 6, the host's local time). The dispatcher starts it once a day at that hour when a slot is free, and `loop stop` ends it.
- `correct` replaces `retro`: the `retro` skill goes, with each pointer to it.
- `dispatch.md` gains four lines, one each for the principles encode lessons in structure, prove it works, never block on the human, and the laziness protocol: the smallest change that solves the problem, and a Bug fix touches the files the reproduction touches.
- `loop report <KEY>` reads one ticket's log and gives its list price by model and subagent, its turns, and its peak context. `loop report` gives the tickets that merged today, and the day's share of each plan window, since parallel workers move one meter and a per-ticket share would count a window twice.
- The watch page: the project card gives the dispatcher's state, running, paused, or idle, each running ticket with its step and time, the tickets handed back and why, the tickets that wait on a blocker, and the stuck ones. The ticket picker replaces the Epic picker, by day. The Usage view and the forecast read the tickets' logs. The `gh` fake of the tests gains labels and drafts.
- The design file, `skills/setup-loop/loop.md`, and `docs/agents/loop.md` of this repo describe the per-ticket loop. `setup-loop` writes the new `docs/agents/loop.md` for a repo. `setup-repo`'s protection step requires `gate / check` and `gate / fuzz` alone. Run again on a repo already on the gate, `setup-repo` replaces its required checks, and `setup-loop` brings its `loop.toml` to the new keys, so the owner moves the other repos later with the two skills.
- Pitchridge: `loop.toml` gets `parallel = 2`, `[blast]` with the red globs for auth, the WorkOS role code, the release workflow, the retention job, the presign code, and the Alembic migrations, `[fuzz]` with a `setup` that brings up and seeds the stack, and `[queue]`. `docs/agents/loop.md`, `docs/agents/workflow.md`, and `docs/agents/issue-tracker.md` describe the per-ticket loop and the Bug. `make loop` takes no Epic. The gate pin in its pull-request workflow moves to the commit with the fuzz job, and the branch protection requires `gate / fuzz` in place of `gate / review`, in the same pull request.

## Testing Decisions

A good test drives `bin/loop` as a subprocess against the fakes in `tests/fakes/` and reads the log and the fakes' state. It asserts what the owner can observe: a unit started, a label set, a pull request draft, a status moved, a flag set. It never reads a private function.

Seams: the scenario tests of `loop/tests/`, with `tests/world.ts` building the world, for the dispatcher and the worker; pytest in `tests/` at the root for the fuzz script, beside the review's tests; `tests/docs.test.ts` for the keys of `loop.toml` against the design file; the Pitchridge docs check for its rewritten docs.

| Test                                                                                                                                                                                                                                                                           | Stories                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `loop start` with no key starts the dispatcher unit, and a ticket that becomes ready on the second poll starts a worker                                                                                                                                                        | US-1, US-2                        |
| Two ready tickets start in priority then key order, and the third waits for a slot with `parallel = 2`                                                                                                                                                                         | US-3, US-5                        |
| A Flagged ticket, a ticket of another component, a ticket with no component, and a ticket whose blocker has an open pull request never start                                                                                                                                   | US-4, US-6                        |
| `loop stop` ends the dispatcher and both workers and flags nothing; `loop stop <KEY>` ends one and flags it                                                                                                                                                                    | US-7                              |
| `loop ticket <KEY>` by hand holds the unit name and a slot, the dispatcher does not start it again, and a second hand start refuses                                                                                                                                            | US-8, US-9                        |
| A failed build flags the ticket with the reason, and it does not start again until unflagged                                                                                                                                                                                   | US-10                             |
| A worker that throws logs `stop` `loop-error` and flags, and the other worker merges                                                                                                                                                                                           | US-11                             |
| An unflagged ticket with an open pull request starts again at the wait, with no build                                                                                                                                                                                          | US-12                             |
| Two stuck workers in a row open the circuit breaker; an unflag closes it and the ticket starts                                                                                                                                                                                 | US-13                             |
| A worker's `usage-pause` holds the next start until the reset; a limit with no reset hands the ticket back with no flag                                                                                                                                                        | US-14                             |
| The dispatcher sets the Epic Done after the last merge, and after a `manual` child is set Done by hand; it archives a spec that two Epics link only once both are Done, and repoints both                                                                                      | US-15                             |
| A Bug's `ticket.md` carries the reproduce line and its branch is `fix/`                                                                                                                                                                                                        | US-18, US-19                      |
| A changed file under a red glob opens a draft with `blast:red`, the worker hands back and frees the slot, and a ready-for-review brings it back to merge                                                                                                                       | US-20, US-21, US-23               |
| An agent `blast` of `yellow` on a green floor labels yellow; the worker writes the hold and hands back; after the hold, auto-merge turns on; the `hold` label stops it                                                                                                         | US-22, US-24                      |
| A green pull request turns auto-merge on at the first green                                                                                                                                                                                                                    | US-25                             |
| The fuzz script starts `adversaries` subagents, keeps a finding whose head rerun fails, marks one whose base output matches as pre-existing, posts one comment with the reproduction text, and exits non-zero only on a new finding or an unfinished adversary with `blocking` | US-26, US-27, US-28, US-29, US-30 |
| The gate workflow has a `fuzz` job and no `review` job, skips it on a docs-only pull request, and `setup-repo`'s protection names `gate / fuzz`                                                                                                                                | US-31, US-32                      |
| A red fuzz check resumes the session with the findings in the fix message                                                                                                                                                                                                      | US-29                             |
| With `[notify] kind = "slack"`, a stuck ticket posts `{"text": ...}` to the webhook                                                                                                                                                                                            | US-38                             |
| An old `loop.toml` with `[review]` loads with a warning                                                                                                                                                                                                                        | US-41                             |
| The dispatcher starts `loop correct` at the hour, once, and its pull request has no key and the `correct` label                                                                                                                                                                | US-42                             |
| A stuck comment's first line is `Stuck: <step> <result>`                                                                                                                                                                                                                       | US-48                             |
| `dispatch.md` names the four principles                                                                                                                                                                                                                                        | US-51                             |
| `loop correct` with two classes opens one pull request                                                                                                                                                                                                                         | US-52                             |
| The watch page's card shows the dispatcher state, a running ticket, and a handed-back ticket over a seeded state                                                                                                                                                               | US-39                             |
| `loop report <KEY>` reads one ticket's log; `loop report` lists the tickets merged today                                                                                                                                                                                       | US-40                             |
| The design file names each `loop.toml` key                                                                                                                                                                                                                                     | US-43                             |
| The Pitchridge docs check passes on the rewritten docs                                                                                                                                                                                                                         | US-44                             |

The Chief stories, US-16, US-17, US-33 to US-37, US-45 to US-47, US-49, and US-50, are prompt and setup work. The `to-bug` skill is checked by hand on one Sentry issue, the blast-radius skill run of US-22 on one ticket, and the Chief on one Slack report.

## Out of Scope

- A second host or a cloud sandbox for workers. Technical. The worker is one unit, so a host is where it runs; none planned until `parallel` wants 3 or the host is off when a ticket is ready.
- Stacked pull requests. Technical. A ticket waits for its blocker to merge; dropped on purpose.
- RICE or any score on a ticket but the blast level. User-visible. The owner sets priority; none planned.
- The Chief's connectors in git. Technical. Grokbot holds them; none planned.
- A blast level on a pull request the loop did not open. Technical. None planned.
- The Switchboard. User-visible. A later spec.
- Jira Automation. Technical. The Free plan stops its rules; the dispatcher polls instead.
- A per-ticket share of the plan meter. Technical. Parallel workers share one meter; the day's share is the figure.

## Further Notes

The first `loop start` on the new loop runs with no ticket in flight from the old one. The Pitchridge tickets live under a Pitchridge Epic that links this spec, because a pull request of one repo names no key of the other. The Chief's Slack workspace, the apps, the Grokbot connectors, and the Gmail filters are a `manual` ticket.
