# The loop

A script builds one Epic unattended. It reads the ticket graph from the tracker, starts an agent for each ticket on the frontier, runs the gates itself, and lands each green ticket on the Epic branch. No model decides what runs next or whether a ticket passed. KC merges the Epic PR into `main`.

This file is the one home of the fixed design. A repo's `docs/agents/loop.md` links here and holds only that repo's settings.

## Fixed design

Every repo keeps these rules. Change a rule here, on purpose, and give the reason in the pull request.

1. **Frontier.** A ticket is on the frontier when it is open, not stuck, and each of its blockers is done in the tracker or landed on the Epic branch. A ticket has landed when `git log <epic-branch> --grep "(<KEY>)"` finds its merge. The tracker and git hold all state, so the script keeps no state file. A ticket that is done in the tracker but whose branch holds work on neither main nor the Epic branch is not built. The script notifies at start and marks it in the Epic PR.
2. **Worktree.** Each ticket gets a worktree and a branch off the Epic branch, its own stack, and its ticket text in a file outside the repo. When a remote branch already carries the key, the script uses that branch, and the ticket starts as a restart (rule 9). The script pushes the ticket branch after every agent run.
3. **Agent run.** `timeout <limit> claude -p "/implement <ticket file>" --permission-mode auto --permission-prompts none --output-format stream-json --verbose --json-schema <schema> -n <KEY>`. The schema returns `status` (`done` or `blocked`), `reason`, and `decisions`, the judgement calls for KC to check. The script comments the decisions on the ticket and lists them in the Epic PR. Each turn ends with a result event, and the script takes the status from the last result event that has one. A `blocked` status makes the ticket stuck.
4. **Ticket gate.** The script runs the ticket gate in the worktree. When it fails, the script resumes the session with the tail of the log, up to the fix attempt limit. Still failing, the ticket is stuck.
5. **UI gate.** When the diff against the Epic branch touches a UI path, the ticket lands only with UI review screenshots in its run folder. Without them, the script resumes the session and asks for the UI review. The script attaches the screenshots to the ticket.
6. **Land.** Merges run one at a time: `git merge --no-ff` into the Epic branch, with the key in the message, then the merge gate on the Epic branch. A conflict undoes the merge. The script then merges the Epic branch into the ticket branch and resumes the session to resolve the conflict, as a fix attempt. A failed merge gate undoes the merge, and the ticket is stuck.
7. **Stuck.** The script sets the stuck marker on the ticket, comments the reason and the log path, and notifies. Other frontier tickets keep running. Tickets downstream of a stuck one wait.
8. **Limits.** Parallel tickets, the agent timeout, and fix attempts per ticket cap the work. A run of stuck tickets in a row as long as the circuit breaker stops the loop. A usage limit error stops the loop and notifies.
9. **Restart.** The script keeps each in-progress ticket's branch and starts a fresh agent with "A previous run was interrupted. Check the diff against the ticket and continue." The restart counts as a fix attempt.
10. **Finish.** When the frontier is empty and nothing runs, the script runs `/code-review` on the Epic branch and one fix run through the same gates, pushes, and opens the Epic PR. An agent writes the PR body with the `pr` skill. Without a body from it, the body is the ticket table. If a gate still fails, the PR is a draft with the failing gate at the top. Then it notifies.
11. **Log.** One JSONL line per decision, with the ticket, step, result, commit, and session id, in the log folder outside the repo.
12. **Host.** The script checks every prerequisite before it starts and refuses to run when one is missing. It holds off sleep for the run, with `systemd-inhibit` on Linux and `caffeinate` on macOS. A run starts in its own tmux session, so it outlives the agent or shell that starts it. An agent starts a run only through that tmux command, because the Bash tool stops a command after 10 minutes.
13. **Main.** The loop lands work only on the Epic branch. KC merges the Epic PR.

## Settings

Each section names what it settles. A repo's `docs/agents/loop.md` keeps these headings and holds only that repo's values.

The machine README, `~/.local/share/chezmoi/README.md`, holds how to reach each machine and how secrets get onto it. Secrets and Hosts link to it.

### Run

Settles the command that starts a run, and where.

### Tracker

Settles how the script lists an Epic's children, reads the blocking edges, fetches a ticket's text, and comments.

### Status and stuck marker

Settles which status changes the loop makes, which the tracker's automation makes, and how a stuck ticket shows.

### Human steps

Settles what only a person can do, and how tickets carry it.

### Branches and commits

Settles the branch names for the Epic and each ticket, and where the key goes.

### Gates

Settles the ticket gate, the merge gate, and what CI runs.

### Stack per worktree

Settles how two tickets run full stacks side by side.

### UI review

Settles the UI paths, the review skill, the browser, sign-in, and what the review checks.

### Connectors

Settles which MCP servers the agent gets.

### Notifications

Settles the channel, the events, and what a message may contain.

### Secrets

Settles which secrets the loop needs and where each one lives.

### Hosts

Settles which machines can run the loop and what each needs.

### Limits

Settles the numbers in rule 8.

### Code and logs

Settles where the script lives and where it logs.
