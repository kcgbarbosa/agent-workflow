# Choosing the values

[loop.md](loop.md) says what each settings section settles. This file says, for the same sections, where to find the value, what to choose when the repo has no preference and why, and the check that shows the value is wrong. Run every check of a section before you call its value settled.

The examples use an invented project, Tidepool, with tracker project `TIDE`.

## Run

**Find.** How a person starts work in this repo today: the Makefile, the package scripts, the README.

**Choose.** A person starts each run, with one command that is the same on every host. Add a make target, or the repo's equivalent, that runs `loop start`:

```make
loop:
	loop start $(epic)
```

A person can also ask a remote session on the host to run it. The run is a systemd user unit, so it outlives that session, and `loop stop <Epic key>` ends it. An agent starts a run only with `loop start` (rule 12 of loop.md).

**Check.** `make -n loop epic=TIDE-12` prints `loop start TIDE-12`.

## Tracker

**Find.** Open a finished Epic in the tracker. List its children with the query `parent = TIDE-12`. Open one child that had a blocker and read its links. Read the exact status names in the workflow, and the automation rules in the project settings.

**Choose.**

- `in_progress` and `landed` default to `In Progress` and `In Review`. The landed status must mean "built, waiting for review", never the done status. The work is on the Epic branch, not on `main`, until a person merges the Epic PR.
- `name_landed_keys_only = true` when the tracker's automation closes each issue that a merged pull request names, or a CI check fails a pull request that names a key that did not land. Without it, the Epic PR names a ticket that did not land, and a merge closes it by mistake. With no such automation, leave it `false`.
- The account that signs in is the one whose name shows on the loop's comments. It needs permission in the project to browse, comment, edit, transition, and attach files. Make its API token in the Atlassian account settings, under Security, API tokens, with the plain "Create API token" action. A token "with scopes" does not work, because the adapter uses basic auth on the site URL.

**Check.**

- The children query returns the tickets of a real Epic and none of another. A ticket that the query misses is linked to the Epic by another field, and the loop never sees it.
- A ticket with a blocker shows the link type "Blocks". A repo that uses another link name gets no edges, and the frontier starts blocked tickets at once.
- The site has a field named Flagged. If the field is missing, the loop cannot mark a stuck ticket, and a human ticket adds it.
- Move one ticket by hand to `in_progress` and to `landed`. If the workflow refuses a move, change the workflow or the name.

## Status and stuck marker

**Choose.** The loop sets the two statuses of Tracker and flags a stuck ticket. The tracker's automation sets Done, when the pull request that names the key merges into `main`. Where the Epic PR closes the Epic and its children at once, one automation rule on the Epic's Done does it. In Jira, a rule that another rule's change must start needs the setting that lets other rules trigger it. Priority, labels, and sprints stay with a person, because the loop never reads them.

**Check.** A flagged ticket stands out on the board the team uses. If it does not, add the flag to the board's card layout, because it is the only sign of a stuck ticket there.

## Human steps

**Find.** Read the backlog for steps that need a person: creating accounts or test users in a third-party service, turning on tracker automation, domain and DNS changes, production credentials, billing, roles and permissions in an identity or cloud provider, installs on a host.

**Choose.** An agent does every step it can. A ticket is flagged for a person only when an attempt failed on a blocker that needs a person, or when the step is dangerous and the owner has not consented to it. The reason is that a ticket marked human by habit sticks, and every ticket downstream of a stuck one waits (rule 7). Auto mode holds changes to sensitive admin controls until a person approves them. An unattended agent stops there, and the ticket sticks. Plan each such change as a human ticket that runs before the Epic.

Write the rule in the issue tracker doc, so `to-tickets` follows it:

> Mark a ticket as a human step only when an agent tried it and a blocker needs a person, or when the step is dangerous and the owner has not consented. An agent does every other step, including setup in development accounts. Plan a change to a sensitive admin control, such as a role in the identity provider, as a human ticket.

**Check.** Each human ticket in the Epic names its blocker or its danger. A ticket that names neither is an agent ticket.

## Branches and commits

**Find.** The issue tracker doc for the key format, the commit lint config, the CI checks on pull request titles and keys, and the merge strategy of the repo.

**Choose.** The key is the commit scope, as in `feat(TIDE-12): add the tide table`. The script names each ticket branch `feat/TIDE-12-<slug>`, or `fix/` for a Bug. Set `main_branch` to the branch the Epic PR targets when it is not `main`.

**Check.** The commit lint accepts a scope in capitals with digits and a hyphen. Many lint presets force a lowercase scope, and then every commit of the ticket agent fails its hook.

## Gates

**Find.** The Makefile, the package scripts, and the CI workflows. The gate commands are the ones CI runs.

**Choose.**

- The **ticket gate** is the fast part: lint, type check, and the tests that a ticket's change can break. A ticket reruns it after every fix attempt.
- The **merge gate** is what CI runs on a pull request: the ticket gate plus the slow parts, such as end-to-end tests. It runs once per landing, one landing at a time, on the Epic branch. Making it the same command as CI means a green Epic branch is a green CI.
- A gate is an argument list with no shell. Put the steps behind one make target, package script, or script per gate, so the list stays short.
- Typical commands by stack:

| Stack      | Lint and types                          | Tests           | Slow part                         |
| ---------- | --------------------------------------- | --------------- | --------------------------------- |
| Python, uv | `uv run ruff check`, `uv run mypy`      | `uv run pytest` | integration tests against a stack |
| Node       | `npm run lint`, `npm run typecheck`     | `npm test`      | `npm run build`, browser tests    |
| Go         | `go vet ./...`                          | `go test ./...` | `go build ./...`                  |
| Rust       | `cargo clippy -- -D warnings`           | `cargo test`    | `cargo build --release`           |
| Gradle     | `./gradlew check` covers lint and tests |                 | `./gradlew build`                 |
| A Makefile | `make lint`                             | `make test`     | `make check` runs all three       |

- `timeout_minutes` defaults to 60. Set it to about twice the longest run of the merge gate from a cold start, with new volumes and no cache. A limit that is too low wastes fix attempts on a slow gate. A limit that is too high hides a hung process.
- `agent_hint` is one line for what the gate command does not say, such as "`make test` starts the database of this worktree's stack". Put in it only what an agent cannot find by looking.

**Check.**

- Run both gates on a clean checkout of the main branch. A red main sticks every ticket, because each one fails its merge gate.
- Run the ticket gate twice in a row. A gate that passes once and fails once spends the fix attempts of a ticket on noise.
- After a gate, `git status` is clean. A gate that rewrites tracked files, such as a formatter, fails the next check, which refuses a tree with changes not committed.
- A gate needs no sign-in and no prompt. The script gives a gate no secret (Secrets). A test that needs a key uses a development default, except the acceptance tests, whose make target reads the stack's secrets from the secrets file through a repo script (Acceptance tests).
- The merge gate runs the acceptance suite after the fast checks, such as `make check acceptance`.

## Acceptance tests

**Find.** `docs/agents/testing.md`, which `/setup-repo` writes. It names the acceptance suite, its command for one ticket, and its list command.

**Choose.**

- `list` is the list command of `docs/agents/testing.md`, with `{key}` for the ticket, such as `["make", "acceptance-list", "ticket={key}"]`. It prints one title per line and needs no stack.
- The `to-tickets` skill heads the list "What the user sees", which is the heading the loop reads.
- A repo whose `docs/agents/testing.md` says "No acceptance suite" leaves the table out.

**Check.**

- Run the list command for a landed ticket. It prints the title of each of its tests, and nothing else.
- Each title matches a line of that ticket's "What the user sees", word for word.

## Stack per worktree

**Find.** Search the Compose files, dev server configs, test configs, env files, and CI workflow for every fixed port: `grep -rnE '[0-9]{4,5}'` over those files, then read the hits. List each service the tests or the UI review start: the database, the API, the web server, the end-to-end server.

**Choose.**

- Give each port an env var, and make every file that holds the port read it, with today's port as the default, so a person's own run changes nothing:

```yaml
services:
  db:
    ports: ["127.0.0.1:${DB_PORT:-5432}:5432"]
```

The dev server proxy target, the test runner's base URL, and the browser test config read the same vars. Publish ports on `127.0.0.1` only.

- `[stack]` `ports` maps each var to its base port. The base ports are the ones a person's own stack uses, in slot 0. Choose bases whose offsets cannot meet: the highest offset is `port_step` x (`parallel` + 1), and it must stay below the gap to the next base. Keep every port below 32768, where Linux hands out ports to outgoing connections.

```toml
[stack]
port_step = 10
ports = { DB_PORT = 15432, API_PORT = 3000, WEB_PORT = 3100 }
```

With `parallel = 2`, the highest slot is 3, so a port moves by at most 30. The bases here are 100 apart.

- The test database is the engine and major version of production, from Compose locally and as a service container in CI. A different engine, such as SQLite for tests against a Postgres production, hides the faults the migrations and queries cause in production.
- Add a seed target that loads fictional data, and make it safe to run twice. Seed data shows in screenshots that the loop attaches to tickets, so it holds no real person's data.
- A repo with a fixed-port process that it cannot parameterize leaves `[stack]` out and sets `parallel = 1`. Two tickets would fight for the port.
- A repo whose stack lives outside Docker, such as a cloud database, gives each ticket its own resource named from the key, or runs one ticket at a time.

**Check.**

- Start two stacks at once with different `COMPOSE_PROJECT_NAME` and port values, and see both healthy.
- Search the tree for each base port. A hit outside the default of an env var is a port that two tickets will collide on.
- A migration runs from an empty volume to the head. The loop removes a ticket's volume at landing, so the chain must run from the start.
- The slot ports are free on the host. Slot 1 belongs to every Epic, so a dev server a person left on `base + port_step` blocks the run.

## UI review

**Find.** Where the screen source lives: the components, templates, and styles. Which roles, languages, and browsers the product supports, and the narrowest screen width it supports. The auth flow, to see how a headless browser can sign in.

**Choose.**

- `path` is the one folder prefix that holds the screens. Choose the narrowest folder that holds all of them, because backend code under the prefix starts a review for nothing. Test files never count.
- The review is a skill of the repo, at `.claude/skills/ui-review/` by default. It runs the ticket's acceptance tests on the real stack with the slot's ports: one test for each line of what the user sees, which taps through the flow as each role. The skill runs the UI review run that `docs/agents/testing.md` names, with the screenshot folder that the loop gives in its prompt, and reads every command from that file. A screenshot of a page as it loads proves nothing about a tap, a search, or a jump, so the review does not take one. It returns each fault with its screenshot. It changes no file. A missing secret, bucket, or seeded file blocks the review, and a step that shows an error screen fails it.
- Check at the narrowest supported width, because a layout that fits there usually fits wider. Add a desktop width only when the layout differs. Use Chromium, and add WebKit when users reach the product on Safari or iOS, because WebKit shows faults Chromium hides. Check each language the product ships, because a longer string breaks a layout and a missing key shows. Check as each role that the diff affects, because roles see different screens.
- The UI review run takes the screenshots and runs the checks that need no eyes, as one script. When it is given no folder and `LOOP_RUN_DIR` is set, its folder is `$LOOP_RUN_DIR/screenshots`, the one the loop attaches to the ticket, so a review that leaves out the folder still saves its screenshots there. Outside the loop, it stops and asks for the folder. The checks are horizontal overflow (`scrollWidth > clientWidth`), console errors, failed requests, and untranslated keys.
- A script costs no context on a turn. A Playwright MCP server in `.mcp.json` adds its tool list to every turn (Connectors), so add one only for a flow the script cannot cover.
- Install the browsers on each host, for example with `npx playwright install --with-deps chromium webkit`.

**Sign in without a person.** Find the app's login in the code, then choose the first option that fits:

1. A dev-only script that signs in a test user against a non-production environment of the identity provider, builds the session cookie the way the app's callback route does, and writes it as Playwright storage state, one file per role.
2. A dev-only login route that an env var turns on and production leaves off.
3. A session row that the seed script writes, with the token set in the browser.

Rules for all three:

- Test users exist only in a non-production environment, one per role, with the least permission that role has. A person creates them, as a human ticket. Their passwords are secrets (Secrets).
- The sign-in code is development only, and the go-live checklist gets an item that removes or disables it.
- Storage state files hold live sessions. Write them to a git-ignored folder in the worktree, never to the run folder, because the run folder is shown on the watch page and its screenshots go on the ticket. The review deletes them when it ends.

Tidepool's example. The app signs in through a hosted page of an identity provider. `scripts/ui-session.py` calls the provider's password sign-in API in the staging environment for the test user of each role, seals the cookie as `/auth/callback` does, and saves `.auth/<role>.json`. The review loads that file into each browser context.

**Check.**

- From a cold shell with no browser profile, the sign-in script writes a session file for each role, and a page that needs a role loads as that role.
- Run the review by hand on a branch with a small UI change. The screenshot folder holds a screenshot of each step, and the checks print their findings.
- Run the command for one ticket. It saves no screenshot.
- Search the run folder for the session files. None is there.

## Agent

**Choose.** Keep the defaults of loop.md until a run's cost says otherwise. To cut the plan usage of a run, lower `effort` before you change `model`.

**Check.** `loop report` after the first Epic. The tickets with the most turns and the largest peak context show where the cost goes.

## Connectors

**Find.** `claude mcp list`, and the `.mcp.json` in the repo.

**Choose.** Commit a `.mcp.json` that lists only the servers the Epic's tickets need, such as a browser for the UI review. A repo with no `.mcp.json` leaves each run the host's servers, and each one adds its tool names to every turn. A repo that needs none commits an empty file, `{"mcpServers": {}}`, which gives each run no server. The ticket file holds the ticket text, so a run needs no tracker connector.

**Check.** In the first run, the agent log lists the connected servers. It lists the repo's and no others.

## Notifications

**Choose.** The events are fixed: a stuck ticket, the Epic PR opening, and the run stopping early. Use ntfy.sh unless the user runs a server, and then set `notify.url`. The topic is a long random name, for example from `openssl rand -hex 16`, kept in the vault as a secret. Subscribe to it in the ntfy app on the user's phone.

**Check.** Post a test message to the topic with `curl -d test https://ntfy.sh/<topic>` and see it on the phone.

## Secrets

**Find.** List every credential the loop and its agents use. The script needs `JIRA_EMAIL`, `JIRA_API_TOKEN`, and `NTFY_TOPIC`. The agents add what the app, the tests, and the UI review need: keys of a non-production identity provider, the test users' passwords, keys of a development cloud account, and the Claude token below.

**Choose.**

- Every secret is a development or staging credential with the least scope that works, such as a cloud key for the development bucket only. No production credential is on a loop host.
- One vault item per credential, named `<name>-<what>`. A login item holds two secrets, the username and the password, and `[secrets]` maps each env var to one `field` of it.
- `CLAUDE_CODE_OAUTH_TOKEN` comes from `claude setup-token`, run as the account that should pay for the loop. Each agent run then uses that account, whichever account is signed in on the host. Leave it out when the host's own account is the one.
- A secret never goes in the repo, the ticket file, a commit, or a log. The watch page masks the values it finds in the secrets file.

**Check.** `loop secrets` fails at once with the name of any item that the vault lacks. Run `loop secrets` and then `loop start` on each host before the first Epic.

## Hosts

**Find.** Which machines can run a loop for hours: an always-on machine suits it best. For each one, read the machine README for how to reach it, what it has installed, and how secrets get there.

**Choose.** List in `tools` each command the gates and the agent call that the script does not check itself, such as `make`, `uv`, or `npm`. The script already checks `git`, `claude`, `gh`, `systemd-inhibit`, and `docker` when `[stack]` is set. Each host runs Linux with systemd, and also needs the `loop` command from agent-workflow's `install.sh`, linger on for the user, `bw` for `loop secrets`, `gh` signed in, `claude` at or past the minimum version, Docker Engine running, and the browsers of the UI review.

**Check.** `loginctl show-user $USER -p Linger` prints `Linger=yes`. Run `loop start` on each host. A missing prerequisite ends the run at once, and `journalctl --user -u loop-<name>-<Epic key>` names every one.

## Limits

**Choose.** Keep `parallel` at 1 for the first Epic, because each parallel ticket runs a full stack, adds to the plan meter, and adds merge conflicts. Raise it when the first-pass rate is high and the host has memory for the stacks. The other defaults suit most repos. `agent_timeout_minutes` should exceed the longest legitimate ticket. `fix_attempts` caps the rework of one ticket. `circuit_breaker` stops a run when tickets stick in a row, because that pattern means a shared cause, such as a red main or a broken gate, and more attempts only spend the plan.

**Check.** After the first Epic, `loop report` shows the tickets that hit a limit. Raise a limit only for a cause you understand.

## Logs

**Choose.** Nothing. The watch page opens at `http://127.0.0.1:8790` on the host. From a phone or another machine, open the host's tailnet address on the same port. Free port 8790 when another process holds it.

**Check.** After `loop start`, `systemctl --user is-active loop-watch-8790` prints `active`, and the page answers on the port.

## Host setup

Each host gets the `loop` command from `install.sh`, linger with `loginctl enable-linger`, and one run of `loop secrets` from the repo. Run `loop secrets` again after a secret changes:

```sh
BW_SESSION=$(bw unlock --raw) && export BW_SESSION && loop secrets; bw lock
```

## When a value is wrong

| Symptom                                                   | Value to fix                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| The run's journal names missing commands                  | `tools`, or the host                                           |
| The config refuses the file with an unknown key           | A typo in `loop.toml`                                          |
| The frontier starts a ticket before its blocker           | The link type of the edges, or the Epic children query         |
| A ticket cannot move to a status                          | `tracker.in_progress`, `tracker.landed`, or the workflow       |
| The Epic PR names a ticket that did not land              | `name_landed_keys_only`                                        |
| A gate fails with "address already in use"                | `ports`, `port_step`, or a process left on a slot port         |
| A gate passes by hand and times out in the loop           | `timeout_minutes`, or a cold start that the gate needs         |
| A gate passes once and fails once                         | The gate itself. It is flaky, and a fix attempt cannot cure it |
| A ticket sticks on "changes not committed" after the gate | A gate step that rewrites tracked files                        |
| A test fails for a missing key in the loop only           | A secret a gate needs. Use a development default               |
| The UI review is blocked, or saves no screenshots         | The sign-in, the skill, or `LOOP_RUN_DIR`                      |
| The watch page shows red tool calls                       | An action that auto mode denies. Plan it as a human step       |
| The run costs more than the plan allows                   | `effort`, then `parallel`                                      |
