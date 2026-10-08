# The loop

A script builds one Epic unattended. It reads the ticket graph from the tracker, starts an agent for each ticket on the frontier, runs the gates itself, and lands each green ticket on the Epic branch. No model decides what runs next or whether a ticket passed. KC merges the Epic PR into `main`.

This file is the one home of the fixed design. The `loop` command, from `loop/` in the agent-workflow repo, is the script for every repo. A repo's `loop.toml` holds the values the script reads, and its `docs/agents/loop.md` links here and holds the rest of its settings.

## Fixed design

Every repo keeps these rules. Change a rule here, on purpose, and give the reason in the pull request.

1. **Frontier.** A ticket is on the frontier when it is open, not stuck, and each of its blockers is done in the tracker or landed on the Epic branch. A ticket has landed when `git log <epic-branch> --grep "(<KEY>)"` finds its merge. The tracker and git hold all state, so the script keeps no state file. A ticket that is done in the tracker but whose branch holds work on neither main nor the Epic branch is not built. The script notifies at start and marks it in the Epic PR.
2. **Worktree.** Each ticket gets a worktree and a branch off the Epic branch, its own stack, and a ticket file outside the repo. The ticket file holds the ticket text and names the gate command that checks the work, which the agent makes pass before it returns `done`: the ticket gate for a ticket, and the merge gate for the Epic review (rule 10). It also holds the comments on the ticket, without the loop's own stuck and decisions comments, which the script knows by their first line. When the comments cannot be read, the script logs it and writes the ticket file without them. When a remote branch already carries the key, the script uses that branch, and the ticket starts as a restart (rule 9). The script pushes the ticket branch after every agent run.
3. **Agent run.** For a ticket, the script runs `claude -p` with `/implement` and the ticket file as the prompt. [`EpicRun.agent`](../../loop/src/loop/run.py) holds the whole command, and every agent run, for a ticket or for the finish, gets these parts:
   - `timeout` with `--kill-after` stops the run and every process it started at the agent timeout, and kills what still runs a minute later.
   - `--permission-mode auto` and `--permission-prompts none` let the run go on with nobody there to answer a prompt.
   - `--output-format stream-json` with `--verbose` writes each event to the agent log as it happens, so a run can be followed while it lasts.
   - `--json-schema` makes the run return its status in a fixed shape.
   - `-n` names the session after the ticket key.
   - `--mcp-config` gives the run the worktree's `.mcp.json` when it has one, because nobody approved the project's MCP servers in a new worktree folder.
   - `--agents` gives the loop's subagent tiers in [`agents.json`](../../loop/src/loop/agents.json), and `--append-system-prompt` adds the rule for when to hand work to them in [`dispatch.md`](../../loop/src/loop/dispatch.md). A run of `implement` outside the loop gets neither.
   - `--resume` continues the session for a fix attempt.

   The schema returns `status` (`done` or `blocked`), `reason`, and `decisions`, the judgement calls for KC to check. The script comments the decisions on the ticket and lists them in the Epic PR. Each turn ends with a result event, and the script takes the status from the last result event that has one. A `blocked` status makes the ticket stuck.

4. **Ticket gate.** The script runs the ticket gate in the worktree. When it fails, the script resumes the session with the tail of the log, up to the fix attempt limit. Still failing, the ticket is stuck. Every gate runs under `timeout` with `--kill-after`, as the agent does, with the gate timeout as its limit, so a gate past its limit fails and its child processes stop with it.
5. **UI gate.** When the diff against the Epic branch touches a UI path, the ticket lands only with UI review screenshots in its run folder. Without them, the script resumes the session and asks for the UI review. The script attaches the screenshots to the ticket.
6. **Land.** Merges run one at a time: `git merge --no-ff` into the Epic branch, with the key in the message, then the merge gate on the Epic branch. When the gate passes, the Epic branch takes the merge and the script pushes it. A failed push is logged, and the run goes on. A conflict or a failed merge gate undoes the merge. The script then merges the Epic branch into the ticket branch and resumes the session as a fix attempt, to resolve the conflict or to fix the cause from the tail of the gate log. Out of fix attempts, the ticket is stuck.
7. **Stuck.** The script sets the stuck marker on the ticket, comments the reason and the log path, and notifies. Other frontier tickets keep running. Tickets downstream of a stuck one wait.
8. **Limits.** Parallel tickets, the agent timeout, and fix attempts per ticket cap the work. A run of stuck tickets in a row as long as the circuit breaker stops the loop. A usage limit error stops the loop and notifies.
9. **Restart.** The script keeps each in-progress ticket's branch and starts a fresh agent with "A previous run was interrupted. Check the diff against the ticket and continue." The restart counts as a fix attempt.
10. **Finish.** When the frontier is empty and nothing runs, the script runs `/code-review` on the Epic branch and one fix run through the same gates, pushes, and opens the Epic PR. Changes that the fix run leaves uncommitted count as a failing gate, and the other gates do not run, since they would check code the PR does not hold. The script leaves the changes in the Epic worktree. An agent writes the PR body with the `pr` skill. Without a body from it, the body is the ticket table. If a gate still fails, or a ticket is stuck, not built, or done in the tracker but not landed, the PR is a draft. The failing gate and the unfinished tickets go at the top, because a merge of the Epic PR can close the Epic and all of its children in the tracker. Then it notifies.
11. **Log.** One JSONL line per decision, with the ticket, step, result, commit, and session id, in the log folder outside the repo. Each agent line adds `usage`, from the run's last result event: `total_cost_usd`, `num_turns`, `duration_ms`, the subagents by type, and the usage of each model. A resumed session reports the cost and the models of the whole session so far, so the last agent line of a session holds its total.
12. **Host.** The script checks every prerequisite before it starts and refuses to run when one is missing. It holds off sleep for the run, with `systemd-inhibit` on Linux and `caffeinate` on macOS. `loop start` first fast-forwards the loop's own clean checkout of agent-workflow to origin, so every host runs the merged loop, and refuses when it cannot. When it takes new commits, it restarts on the new code before it reads `loop.toml`. It then runs the loop in its own tmux session, so the run outlives the agent or shell that starts it. An agent starts a run only with `loop start`, because the Bash tool stops a command after 10 minutes.
13. **Main.** The loop lands work only on the Epic branch. KC merges the Epic PR.

## Settings

Each section names what it settles, and its `loop.toml` key when the script reads one. A repo's `docs/agents/loop.md` keeps these headings. A value with a key lives in `loop.toml` only, and the repo doc points there; the doc holds the values the script cannot read.

The machine README, `~/.local/share/chezmoi/README.md`, holds how to reach each machine and how secrets get onto it. Secrets and Hosts link to it.

### Run

Settles who starts a run, and where. The command is `loop start <Epic key>` in the main checkout.

### Tracker

Settles the tracker and how the Epic's children and blocking edges are stored. `[tracker]` gives `kind` and `url`. Jira is the only adapter. Set `name_landed_keys_only = true` when the tracker's automation closes each issue that a merged pull request names. The Epic PR then gives a ticket that did not land by its summary, not its key. The default is `false`.

### Status and stuck marker

Settles which status changes the loop makes, which the tracker's automation makes, and how a stuck ticket shows. `tracker.in_progress` and `tracker.landed` name the loop's statuses.

### Human steps

Settles what only a person can do, and how tickets carry it.

### Branches and commits

Settles where the key goes in commits. The script names each branch `feat/<KEY>-<slug>`, or `fix/` for a Bug. `main_branch` names the branch the Epic PR targets.

### Gates

Settles the ticket gate, the merge gate, and what CI runs. `[gates]` gives `ticket`, `merge`, and `timeout_minutes`. `agent_hint` adds a line to each ticket file for what the gate command does not say, such as what the tests need from the stack.

### Stack per worktree

Settles how two tickets run full stacks side by side. `[stack]` gives the base `ports` and the `port_step` per slot, and the script sets `COMPOSE_PROJECT_NAME` to `<name>-<key>`. A repo with no stack leaves it out.
Every Epic uses the same slot, so the slot ports must be free when a run starts. At start, the script stops each `<name>-<key>` project that an earlier run left, and it stops the Epic stack when the run ends. Before each gate, it stops the stack of that gate, so the gate starts on new containers. A container from a failed start can start later with no published port. The volumes stay.

### UI review

Settles the UI paths, the review skill, the browser, sign-in, and what the review checks. `[ui]` gives `path` and `skill`. A repo with no UI leaves it out, and the UI gate never fires.

### Connectors

Settles which MCP servers the agent gets.

### Notifications

Settles the channel, the events, and what a message may contain. `notify.url` is the ntfy server, and the `NTFY_TOPIC` secret is the topic.

### Secrets

Settles which secrets the loop needs and where each one lives. `[secrets]` maps each env var to its Bitwarden `item` and `field`. The script needs `JIRA_EMAIL`, `JIRA_API_TOKEN`, and `NTFY_TOPIC`, and passes every secret to each agent.
`loop secrets` copies them from Bitwarden to `~/.local/state/<name>-loop/secrets.json`, with mode 600, so a run needs no unlock. Run it once per host, and again after a secret changes. A run reads Bitwarden only when the file is missing.

### Hosts

Settles which machines can run the loop and what each needs. `tools` lists the commands the repo needs beyond the script's own.

### Limits

Settles the numbers in rule 8. `[limits]` gives `parallel`, `agent_timeout_minutes`, `fix_attempts`, and `circuit_breaker`.

### Logs

The worktrees, the run folders, and the logs go to `~/.local/state/<name>-loop/<Epic key>/`. The `name` in `loop.toml` also names the tmux session and prefixes the Compose projects.
