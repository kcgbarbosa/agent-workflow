# The loop

A script builds one Epic unattended. It reads the ticket graph from the tracker, starts an agent for each ticket on the frontier, runs the gates itself, and lands each green ticket on the Epic branch. No model decides what runs next or whether a ticket passed. KC merges the Epic PR into `main`.

## Fixed design

Every repo keeps these rules. Change one on purpose and record why.

1. **Frontier.** A ticket is on the frontier when it is open, not stuck, and each of its blockers is done in the tracker or landed on the Epic branch. A ticket has landed when `git log <epic-branch> --grep "(<KEY>)"` finds its merge. The tracker and git hold all state, so the script keeps no state file.
2. **Worktree.** Each ticket gets a worktree and a branch off the Epic branch, its own stack, and its ticket text in a file outside the repo. When a remote branch already carries the key, the script uses that branch, and the ticket starts as a restart (rule 9). The script pushes the ticket branch after every agent run.
3. **Agent run.** `timeout <limit> claude -p "/implement <ticket file>" --permission-mode auto --permission-prompts none --output-format json --json-schema <schema> -n <KEY>`. The schema returns `status` (`done` or `blocked`) and `reason`. A `blocked` status makes the ticket stuck.
4. **Ticket gate.** The script runs the ticket gate in the worktree. When it fails, the script resumes the session with the tail of the log, up to the fix attempt limit. Still failing, the ticket is stuck.
5. **UI gate.** When the diff against the Epic branch touches a UI path, the ticket lands only with UI review screenshots in its run folder. Without them, the script resumes the session and asks for the UI review. The script attaches the screenshots to the ticket.
6. **Land.** Merges run one at a time: `git merge --no-ff` into the Epic branch, with the key in the message, then the merge gate on the Epic branch. A conflict or a failed merge gate undoes the merge, and the ticket is stuck.
7. **Stuck.** The script sets the stuck marker on the ticket, comments the reason and the log path, and notifies. Other frontier tickets keep running. Tickets downstream of a stuck one wait.
8. **Limits.** Parallel tickets, the agent timeout, and fix attempts per ticket cap the work. A run of stuck tickets in a row as long as the circuit breaker stops the loop. A usage limit error stops the loop and notifies.
9. **Restart.** The script keeps each in-progress ticket's branch and starts a fresh agent with "A previous run was interrupted. Check the diff against the ticket and continue." The restart counts as a fix attempt.
10. **Finish.** When the frontier is empty and nothing runs, the script runs `/code-review` on the Epic branch and one fix run through the same gates, pushes, and opens the Epic PR. If a gate still fails, the PR is a draft with the failing gate at the top. Then it notifies.
11. **Log.** One JSONL line per decision, with the ticket, step, result, commit, and session id, in the log folder outside the repo.
12. **Host.** The script checks every prerequisite before it starts and refuses to run when one is missing. It holds off sleep for the run, with `systemd-inhibit` on Linux and `caffeinate` on macOS.
13. **Main.** The loop lands work only on the Epic branch. KC merges the Epic PR.

## Settings

Each section names what it settles, then the pitchridge value as the worked example. A repo's `docs/agents/loop.md` keeps the headings and holds only that repo's values.

### Run

Settles the command that starts a run, and where.
Pitchridge: `uv run scripts/loop/loop.py <Epic key>` in a tmux session on the default host, started by KC per Epic.

### Tracker

Settles how the script lists an Epic's children, reads the blocking edges, fetches a ticket's text, and comments.
Pitchridge: the Jira REST API with an API token. Children are `parent = <Epic key>`. Edges are the "Blocks" link type.

### Status and stuck marker

Settles which status changes the loop makes, which the tracker's automation makes, and how a stuck ticket shows.
Pitchridge: the loop sets In Progress when a ticket starts and In Review when it lands. A stuck ticket gets the Jira Flagged field and a comment. Jira Automation moves the Epic and its children to Done when the Epic PR merges. KC sets priority, phase, and sprint.

### Human steps

Settles what only a person can do, and how tickets carry it.
Pitchridge: an agent does every step it can, including host setup and tracker automation. A ticket is Flagged for KC only when an attempt failed on a blocker that needs KC, or when the step is dangerous and KC has not consented to it. Auto mode holds changes to sensitive admin controls, such as WorkOS roles, for approval, so an unattended agent stops there and the ticket is stuck.

### Branches and commits

Settles the branch names for the Epic and each ticket, and where the key goes.
Pitchridge: `<type>/PITCH-<n>-<slug>`. The key is the commit scope, as in `feat(PITCH-30): read the role from workos`.

### Gates

Settles the ticket gate, the merge gate, and what CI runs.
Pitchridge: the ticket gate is `make lint test`. The merge gate is `make check`, which runs lint, test, and test-e2e. CI runs `make check` and `make build`. Tests run on Postgres 18, from Compose locally and as a service container in CI.

### Stack per worktree

Settles how two tickets run full stacks side by side.
Pitchridge: `COMPOSE_PROJECT_NAME=pitchridge-<key>`. Postgres, API, and Vite ports come from env vars, offset per slot, with today's ports as defaults. The Vite proxy target comes from an env var. `make seed` loads fictional data.

### UI review

Settles the UI paths, the review skill, the browser, sign-in, and what the review checks.
Pitchridge: UI paths are `frontend/src/**` except test files. The skill is `.claude/skills/ui-review/` and the browser is Playwright MCP. A dev-only script calls WorkOS `authenticate_with_password` for the staging test user of each Role, seals the session the way `/auth/callback` does, and saves it as Playwright storage state. The review checks 360 px in Chromium and WebKit, in English and Spanish, as each Role the change affects.

### Connectors

Settles which MCP servers the agent gets.
Pitchridge: all of them while the app is in development. The go-live checklist removes full connector access.

### Notifications

Settles the channel, the events, and what a message may contain.
Pitchridge: an ntfy topic, kept secret. The events are a stuck ticket, the Epic PR opening, and the loop stopping early. A message holds the key and the status only.

### Secrets

Settles which secrets the loop needs and how they reach each host.
Pitchridge: the Jira email and API token, the WorkOS staging keys, the test user passwords, and the ntfy topic. They live in Bitwarden only. The script reads them with the `bw` CLI when KC starts a run and unlocks the vault.

### Hosts

Settles which machines can run the loop and what each needs.
Pitchridge: `t14` is the default host, always on, with Docker Engine. `macbook-pro` runs Docker Desktop. One run at a time.

### Limits

Settles the numbers in rule 8.
Pitchridge: 2 parallel tickets, a 90 minute agent timeout, 2 fix attempts per ticket, and a circuit breaker of 2.

### Code and logs

Settles where the script lives and where it logs.
Pitchridge: `scripts/loop/`, Python run with `uv run`. Logs go to `~/.local/state/pitchridge-loop/`.
