# The Chief starts the fix

Epic: https://kcgbarbosa.atlassian.net/browse/AW-49. Key persona: the owner. ADRs: 0001, 0002, 0004, 0006, 0008, 0009. This file holds the changes that make Slack the one place work reaches the owner: a Bug the Chief files builds at once, a stuck ticket reaches the Chief, the state of the day shows on the start page, and the daily tasks live in files.

## Problem Statement

The owner has the runner, the Chief in Slack, and a start page, and the three do not meet. The Chief files a Bug and nothing builds it until the owner unflags it. The runner tells the owner about a stuck ticket by ntfy, so the Chief never sees it, and the stuck routine in its prompt never runs. A thread the runner starts is told to run `/implement` and is refused, because the skill is user-only, so the method of each build is the agent's own choice. The start page shows which services are up and nothing about what waits on the owner. The daily triage is a prompt in T3's database that still reads the retired loop and reports by ntfy. Nothing runs `/correct`. The Chief's prompt still looks for Sentry alerts in Gmail, though they post to Slack. The docs of Pitchridge and machines do not mention the Chief, so an agent that trusts them makes a wrong change.

## Solution

A report in Slack becomes a Bug that builds within two minutes, and the owner can stop it with one word. A stuck ticket is posted in the repo's Slack channel, where the Chief reads it, retries a fault, asks the owner only when a decision is theirs, and otherwise says what the log says. A skill an agent is told to run can be run. The runner writes the state of each repo on each tick, and the start page shows it as one Today line: what waits on the owner. The daily triage and the daily correct are files in this repo, registered as T3 scheduled tasks, and report in the owner's Slack DM. Each doc an agent reads says what the system does today.

## User Stories

### Skills an agent is told to run (Must)

US-1. As the owner, I want a thread the runner starts to run `/implement`, so that each build follows the same steps and not the agent's own method.
US-2. As the owner, I want an agent asked to run `/to-bug` or `/correct` to run it, so that the Chief's Bug and the daily correct follow their skill.
US-3. As the owner, I want the grill, spec, PRD, tickets, handoff, teach, and setup skills to stay user-only, so that no agent starts one of them on its own.
US-4. As a maintainer, I want a test that fails when a skill named in a runner message, in the Chief's prompt, or in a scheduled task is user-only, so that the AW-48 refusal cannot come back.

### A stuck ticket reaches the Chief (Must)

US-5. As the owner, I want a stuck ticket posted in the repo's Slack channel with its key, the stuck reason, the Jira link, and the thread link, so that the Chief and I read it where everything else arrives.
US-6. As the owner, I want a stuck machines ticket posted in `#agent-workflow`, so that no third channel exists.
US-7. As the owner, I want a post that fails to be retried on the next tick, with no second comment and no second flag, so that a Slack outage loses no stuck ticket.
US-8. As the owner, I want the runner to post nothing to ntfy, so that ntfy carries machine health only.
US-9. As the owner, I want a tick to refuse to start when its Slack secret is missing, so that a stuck ticket cannot go silent.
US-10. As the owner, I want the Chief to treat the runner's post as a stuck notification and take one of its three paths, so that a fault is retried without me.

### The Chief starts a Bug, and the owner can stop it (Must)

US-11. As the owner, I want a Bug that `/to-bug` writes to be To Do and not Flagged, with its component set and the comment `Proposed by intake`, so that the runner builds it on the next tick.
US-12. As the owner, I want the Chief to DM me the key right after it creates a Bug, so that I know a build started without opening Jira.
US-13. As the owner, I want to reply `stop <KEY>` in the Chief's DM and have the ticket moved to Awaiting Approval, so that one word pulls a build back.
US-14. As the owner, I want the runner to turn auto-merge off and make the pull request a draft when its ticket is Awaiting Approval, so that a stopped build cannot merge.
US-15. As the owner, I want a turn that is already running to finish and receive no further message, as ADR-0009 gives, so that stop needs no recovery logic.
US-16. As the owner, I want a ticket moved from Awaiting Approval back to To Do to get its pull request marked ready and auto-merge on again, so that resuming is one move too.
US-17. As the owner, I want a Bug the Chief files for a repeated stuck fingerprint to stay Flagged, so that a change to the runner itself waits for me.
US-18. As the owner, I want the Chief's caps to stay, ten tickets a day and a duplicate search before each one, so that a flood of reports cannot start a flood of builds.

### The Today line (Must)

US-19. As the owner, I want each tick to write the state of its repo to a file: the Awaiting Approval count, the stuck tickets, the open draft pull requests, and the open pull requests with a red check, so that a page can show it with no credentials of its own.
US-20. As the owner, I want the start page to show one Today line built from every repo's file, so that I see what waits on me when I open it.
US-21. As the owner, I want the map at `/map` to show the same Today line, so that the map and the start page cannot disagree.
US-22. As the owner, I want a repo with no file to show as "no runner", so that a missing timer is visible.
US-23. As the owner, I want a file older than ten minutes to show its age, so that a stopped timer is visible.

### The daily tasks as files (Should)

US-24. As the owner, I want the daily triage prompt to be a file in this repo, registered as the T3 scheduled task from that file, so that a change to it is a pull request.
US-25. As the owner, I want the triage to report the Awaiting Approval count, the stuck tickets, the failures in the runner journals, the pull requests that wait on me, the tickets In Review for more than a day, and the threads that wait on me, so that one message holds my morning.
US-26. As the owner, I want the triage to post in my Slack DM and nowhere else, so that ntfy carries machine health only.
US-27. As the owner, I want the triage to read nothing of the loop and nothing of `workflow.html`, so that it reports no retired thing.
US-28. As the owner, I want one `/correct` task per repo on the runner, after the triage each day, so that a mistake made twice becomes a check.
US-29. As the owner, I want a correct run to open at most one pull request, so that it cannot flood the queue.

### The docs say what the system does (Must)

US-30. As an agent in machines, I want the README to say that `claude-rc@pitchridge` runs too, that the ntfy topic is also a bws secret, and where Slack and the Chief fit, so that I make no wrong change from it.
US-31. As an agent in Pitchridge, I want the issue tracker doc to hold the Bug row, the Bug body, and the rule that a Chief Bug starts unflagged and a stop moves it to Awaiting Approval, so that I build a Bug the same way as a Task.
US-32. As an agent in Pitchridge, I want one line that says where Sentry alerts go, so that I do not add a second path.
US-33. As an agent in this repo, I want the workflow doc to say that machines is on the gate and the runner, so that I do not merge there by hand.
US-34. As the Chief, I want my prompt to hold the machines row and no word of the loop, so that I route a machines ticket and read a stuck comment as the runner writes it.
US-39. As the Chief, I want my prompt to treat a Sentry alert as a root message in the repo's channel, with no hourly check and no Gmail, so that I read alerts where they post.

### Behind the scenes

US-35. As a maintainer, I want ADR-0009 to record that a Chief Bug starts unflagged and that stop turns auto-merge off, so that no agent proposes the old rule again.
US-36. As a maintainer, I want ADR-0008 and the runner's comments to drop the words "proposed Bug", so that the code and the decisions use one vocabulary.
US-37. As a maintainer, I want the dead `probe.html` gone from the start page's folder, so that the served folder holds only what the repo gives.
US-38. As a maintainer, I want the Jira component descriptions to name the runner and not the loop, so that a new ticket's component reads right.

## Implementation Decisions

### Skills

- The frontmatter flag that makes a skill user-only comes off `implement`, `to-bug`, and `correct`. It stays on `grill-with-docs`, `grill-me`, `to-spec`, `to-prd`, `to-tickets`, `handoff`, `teach`, `setup-repo`, `setup-runner`, and `interrogate`.
- A test in the repo checks' suite reads the runner's message texts, the Chief's prompt, and the task files for `/<skill>` names, and fails when a named skill carries the flag.

### Stuck to Slack

- The runner's one notification destination becomes a Slack incoming webhook. `runner.toml` gets a key that names the env var of the webhook, one per repo. The default is `SLACK_WEBHOOK_KC_WORKFLOW` for agent-workflow and machines, so they share one value that points at `#agent-workflow`, and `SLACK_WEBHOOK_<COMPONENT>` for any other component, so pitchridge reads `SLACK_WEBHOOK_PITCHRIDGE`.
- The secrets already live in the Bitwarden project the runner reads, under those names. The unit files do not change: `bws run` passes every secret of the project.
- The post is one Slack message: the key, the stuck reason, the Jira link, and the thread link, in that order. The thread link is the one the config already gives.
- The order of the stuck steps changes from comment, flag, notify to comment, notify, flag. A tick whose post fails stops before the flag, so the next tick sees the ticket not Flagged, with its `Stuck:` comment already written, and repeats only the post and the flag. The `Stuck:` comment is written once because the planner reads the latest `Stuck:` comment before it writes one.
- The ntfy code, its config key, its secret name, and its fake leave the runner.
- A tick with no webhook value exits non-zero before it reads, as it did for the ntfy topic.

### The Chief starts a Bug

- `to-bug` step 4 becomes: create, set the component, move to To Do, comment `Proposed by intake` with the report's link. No Flagged.
- The Chief's prompt gains three lines: DM the owner the key and the summary right after a create; on `stop <KEY>` in the DM, move the ticket to Awaiting Approval and reply with what it had reached; a Bug for a repeated stuck fingerprint is created Flagged.
- The Chief's prompt loses the hourly Sentry check, the Gmail filters, and Gmail in its connectors. A Sentry alert is a root message in the repo's channel, and channel triage takes it. The Chief then posts no root message, in any case.
- The runner's rule for Awaiting Approval, in the planner, gains two steps for a ticket with an open pull request: turn auto-merge off, and make the pull request a draft. Both are reads of GitHub first, so a tick repeats nothing. A thread's running turn gets no message.
- A ticket back in To Do whose pull request is a draft that the runner made gets it marked ready and auto-merge on. The runner knows its own draft by a pull request comment it wrote when it made the draft, `Runner hold: Awaiting Approval`, so a draft the agent or the owner made stays a draft, as ADR-0004 gives.
- The limit rule does not change: a stopped ticket with a running turn holds its place until the turn ends.

### The Today line

- Each tick ends by writing one file for its repo, under the runner's state folder, with: the time of the tick, the Awaiting Approval count, the stuck tickets as key and reason, the open draft pull requests as number and title, and the open pull requests with a red required check as number and check name. The tick writes it even when it planned nothing, so the file's age is the timer's health.
- The start page's server reads every repo's file on each request and renders one line: `Waiting on you: 2 to approve, 1 stuck (AW-51), 1 draft (#244), 0 red.` A repo with no file adds `pitchridge: no runner`. A file older than ten minutes adds its age.
- The same line renders at the top of `/map`. The map's content is the static copy that AW-48 shipped until the rewritten map replaces it.
- The page needs no secret, because the runner wrote the file with the secrets it already has.

### The daily tasks

- `tasks/daily-triage.md` is the prompt. It names its steps in order and ends with the Slack DM post through `SLACK_WEBHOOK_DM`. `tasks/daily-correct.md` runs `/correct` in the repo it is scheduled for.
- A script in the runner's command, `runner tasks`, registers or updates the T3 scheduled tasks from the files, one triage task at 06:00 America/Toronto in agent-workflow and one correct task per repo at 06:30. It is run by hand once, and on each change to a task file.
- The `t3` CLI has no scheduling command, so `runner tasks` runs `t3 thread start <project> --wait` for each project, with a message that holds the file's text and tells the thread to call `schedule_task`. The thread lists the project's scheduled tasks first and updates a task with the same title, so a second run makes no second task. This route was tested on 2026-11-04.
- The triage task keeps the title `Daily triage`, so the first run replaces the task in T3's database.
- The triage deletes the loop's state folders the first time it finds them, and reports that it did.

### Docs

- Pitchridge's issue tracker doc gets a Bug row in the Documents table, the Bug body with the Reproduce section, the start rule, and a Flagged case for a stuck-fingerprint Bug only. One line in its workflow doc: Sentry alert rules post to `#pitchridge`, and the Chief turns an alert into a Bug.
- The machines README changes the three lines US-30 names. Nothing else moves.
- Pitchridge's runner doc changes its secrets row, from the ntfy topic to the Slack webhook.
- The Jira component descriptions of `agent-workflow`, `machines`, and `pitchridge` name the runner.

## Testing Decisions

A good test checks what the owner or the Chief can see: a Slack post, a Jira field, a pull request state, a rendered line, a file. It does not check which function wrote it.

### Seams

| Seam                                                                                   | Covers                                                           |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| The runner's scenario tests: `bin/runner` as a subprocess against the fakes            | Slack posts, stop and resume, the Today file, the missing secret |
| The repo checks' Vitest suite at the root                                              | Skill flags, the Chief's prompt, the task files, the ADR text    |
| The machines Vitest suite, which renders the start page's server against fixture files | The Today line, `/map`, the README lines                         |
| Pitchridge's `make check-docs`                                                         | The issue tracker and workflow doc lines                         |

Prior art: `runner/tests/tick.test.ts` for a flag that writes the comment and sends one notification, `tests/intake.test.ts` for the Chief's prompt and `to-bug`, `tests/skills.test.ts` for frontmatter, and machines' `tests/start-page.test.ts` for a rendered page.

The fakes gain a Slack webhook that records each post and can refuse one. The ntfy fake leaves.

### Test table

| Test                                                                                                     | Stories                           |
| -------------------------------------------------------------------------------------------------------- | --------------------------------- |
| No skill named in a runner message, the Chief's prompt, or a task file is user-only                      | US-1, US-2, US-4                  |
| The grill, spec, PRD, tickets, handoff, teach, and setup skills are user-only                            | US-3                              |
| A flag writes the Stuck comment, posts to Slack with the four parts, then flags, once                    | US-5, US-10                       |
| The machines config resolves to the agent-workflow webhook by default                                    | US-6                              |
| A refused post fails the tick before the flag, and the next tick posts and flags with no second comment  | US-7                              |
| No tick reaches an ntfy address, and the config has no ntfy key                                          | US-8                              |
| A tick with no webhook value exits non-zero before it reads                                              | US-9                              |
| `to-bug` creates a To Do Bug that is not Flagged, with component and the intake comment                  | US-11                             |
| The Chief's prompt holds the DM line, the stop line, the fingerprint line, the cap, and the machines row | US-12, US-13, US-17, US-18, US-34 |
| An Awaiting Approval ticket with an open pull request gets auto-merge off and a draft, once              | US-14                             |
| An Awaiting Approval ticket with a running turn gets no message and holds its place                      | US-15                             |
| A To Do ticket whose draft carries the runner's hold comment gets ready and auto-merge on                | US-16                             |
| A To Do ticket whose draft carries no hold comment stays a draft                                         | US-16, ADR-0004                   |
| Every tick writes the Today file with the five fields, including a tick that planned nothing             | US-19                             |
| The start page and `/map` render the Today line from three fixture files                                 | US-20, US-21                      |
| A repo with no file renders "no runner", and a file older than ten minutes renders its age               | US-22, US-23                      |
| The triage file names its steps and no loop path, and the task script registers it from the file         | US-24, US-25, US-27               |
| The triage file ends with the Slack DM post and names no ntfy                                            | US-26                             |
| The task script starts one correct thread per runner repo, against a fake `t3`                           | US-28                             |
| The correct skill text holds the one pull request rule                                                   | US-29                             |
| The machines README holds the three lines, and the served folder's test lists no `probe.html`            | US-30, US-37                      |
| Pitchridge `make check-docs` passes with the Bug row, the start rule, and the Sentry line                | US-31, US-32                      |
| The workflow doc names machines on the gate and the runner                                               | US-33                             |
| The Chief's prompt holds no hourly check and names no Gmail                                              | US-39                             |
| ADR-0009 holds the amendment, and no ADR or runner comment says "proposed Bug"                           | US-35, US-36                      |
| The three Jira components describe the runner                                                            | US-38                             |

## Out of Scope

- Blast level and hold on pull requests. Technical. Dropped with the loop: every green pull request merges, and a draft is the owner's hold. None planned.
- A Slack post from the gate or from Pitchridge's own code. Technical. GitHub's and Sentry's Slack apps already post. None planned.
- Grokbot voice. User-visible. Untested, stays in the map's reference. None planned.
- The runner on recibo, media-lab, portfolio, and galleria. Technical. Not on Jira. None planned.
- The gate on the repos the map said need repair. Technical. machines needs none, and the others have no Jira. None planned.
- Pasting the Chief's prompt into Grokbot, the Slack DM webhook into Bitwarden, and running `runner tasks`. Technical. The owner's checklist in Further Notes.
- The content of the rewritten map. User-visible. The owner's thread writes it as one pull request to machines once this Epic's tickets are Done.

## Further Notes

- The owner's checklist: put `SLACK_WEBHOOK_DM` in Bitwarden before running `runner tasks`. After AW-53 merges, paste `bots/chief.md` into Grokbot and remove its Gmail connector. Check that the GitHub Slack app posts nightly failures in `#pitchridge`. After AW-54 merges, run `runner tasks` once.
- As of 2026-11-04: the runner is live on agent-workflow, machines, and pitchridge, AW-48 shipped the static map at `/map`, and two Sentry rules post to `#pitchridge`.
