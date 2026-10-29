# The rest of KC's tooling in TypeScript

Epic: none yet. Key persona: KC, the maintainer of every repo. ADRs: none in this repo. This file holds the requirements for the switchboard, the start page, and machine-status in TypeScript, one toolchain pin on both computers, one hooks file per repo, and one secrets injector. It builds on `docs/specs/shared-merge-gate.md` and does not repeat it.

## Problem Statement

KC reads TypeScript and cannot read Python. After the shared merge gate moves the loop to TypeScript, the tooling that KC runs every day is still Python or shell with Python inside: the switchboard that answers the phone in the car, the start page that KC opens on every device, machine-status that syncs the dotfiles and sends the alerts, and the tests of all three. KC cannot audit any of it.

The Mac and the T14 install their tools in different ways and at different versions, so a command that works on one can fail on the other. The rules that every repo must obey, such as Prettier on Markdown, are wired by hand in each repo or written as a line that asks the agent to remember. A secret takes four hops that KC wrote: Bitwarden, a JSON file that `loop secrets` copies, a Python wrapper, Make, then the agent. A changed secret needs a manual copy on each host.

The machines repo is not on the start page, so KC cannot open a session in it from the phone, and the loop cannot run there.

## Solution

The switchboard moves to TypeScript beside the loop in agent-workflow, with the same behaviour that PR #94 gave it, so ElevenLabs sees no change. The start page and machine-status move to TypeScript in machines, each one file that Node runs directly.

One `mise.toml` in machines pins the tools on both computers, and chezmoi applies it as the global mise config. Each repo keeps its own mise file for its own code, as the gate spec writes it.

Each repo gets one lefthook file that lists its format, lint, and policy checks. Git runs it at each commit, and `make check` runs it on all files, so the gate runs the same list. A Claude Code hook runs Prettier on each Markdown file that an agent edits.

Bitwarden Secrets Manager holds each secret once. Each computer and GitHub Actions hold one machine token. `bws run` starts the loop's units with the secrets in their environment, and the secrets file and the Python wrapper go away.

The chezmoi source moves to `~/dev/machines`, so machines is a repo like the others: a start page row, a Remote Control server, the gate, and the loop.

## User Stories

### The switchboard in TypeScript (Must)

US-1. As KC on a call, I want to hear "One moment..." after 1 second of silence and "Still working on it..." every 10 seconds after that, so that ElevenLabs never gives up on the request.
US-2. As KC on a call, I want a request with the same words within 30 seconds of the first to join the ask that runs, so that a retry from ElevenLabs never starts a second turn.
US-3. As KC on a call, I want each request for an ask to hear its answer from the start, so that a retry that joins late still gets the whole answer.
US-4. As KC on a call, I want to hear after 45 seconds that the rest comes when I ask, and to hear the rest at my next turn, so that a long turn never holds the call.
US-5. As KC on a call, I want the answer streamed as OpenAI chat completion chunks with no Markdown marks, so that the voice reads only words.
US-6. As KC on a call, I want a reply that another session sent between my turns read out first at my next turn, so that I hear it.
US-7. As KC, I want the session to resume its conversation after a restart from the saved session ID, so that a restart loses no context.
US-8. As KC, I want a request without the token refused with 401, and `/health` to answer with no token and say nothing more, so that the public Funnel address shows nothing.
US-9. As KC, I want `/api/status` with the token to give whether the session runs, when I last talked, and how many replies wait, so that the start page tile keeps working.
US-10. As KC, I want a request that ElevenLabs hung up on to end with no error in the journal, so that the journal shows only real faults.
US-11. As KC, I want the TypeScript switchboard on the same port, unit name, Funnel address, token, model ID, and session name, so that nothing changes in ElevenLabs, Twilio, or the other sessions that message it.

### The start page and machine-status in TypeScript (Must)

US-12. As KC, I want the start page to serve the same page, and `/api/status`, `/api/pages`, `/api/sessions`, and the session actions to give the same answers, so that `index.html` and my habits do not change.
US-13. As KC, I want each Sessions row to show the server state, the open chats, the older version with its restart button, and needs trust as today, so that I manage Remote Control servers from the phone as today.
US-14. As KC, I want `machine-status`, `--refresh`, `--full`, `--ping`, and `--restore-done` to print and report what they do today, with UNKNOWN and the reason where a probe cannot decide, so that the summary and the healthchecks alerts keep working on both computers.
US-15. As KC, I want the hourly job to sync the dotfiles as today: push when ahead, fast-forward and apply when behind, alert on an unfiled edit or on two-sided commits, so that the move changes no sync rule.
US-16. As KC, I want the start page and machine-status each to be one TypeScript file that imports only Node built-ins, so that chezmoi still deploys a copy and nothing installs when they run.

### One toolchain pin (Must)

US-17. As KC, I want one `mise.toml` in machines that is both that repo's pin and the global mise config on both computers, so that one file sets the versions of Node, uv, Claude Code, bws, lefthook, Prettier, gitleaks, and lychee everywhere.
US-18. As KC, I want each pin to be an exact version, so that the two computers cannot resolve the same pin to different versions.
US-19. As KC, I want a repo's own mise file to win inside that repo, so that a repo's code runs on my computer at the versions its gate uses.
US-20. As KC, I want the hourly job to run `mise install` after it applies the dotfiles, so that a pin change reaches the other computer within the hour.
US-21. As KC, I want every systemd user unit, every launchd job, and every Claude Code hook to find the mise tools, so that a service runs the pinned version and not a system one.
US-22. As KC, I want Claude Code to come from the pin with its auto-updater off on both computers, so that both run the same version and it changes only when I change the pin.
US-23. As KC, I want `machine-status --full` to list each pinned tool that has a newer release, so that I know when to bump a pin.

### One hooks file (Must)

US-24. As KC, I want one lefthook file per repo that lists every format, lint, and policy check of the repo, so that each check is wired once.
US-25. As KC, I want the checks to run on the staged files at each commit, and a formatter's changes to be staged again, so that a commit never carries an unformatted file.
US-26. As KC, I want `make check` to run the same hook on all files and to fail when a check fails or the hook changed a file, so that the commit and the gate run one list.
US-27. As KC, I want `setup-repo` to write the lefthook file from the languages the repo has and to run `lefthook install`, so that a new repo gets its checks in the same run that writes the gate.
US-28. As an agent, I want Claude Code to run Prettier on each Markdown file that I edit or write, so that no instruction has to ask me to.
US-29. As an agent, I want a Prettier failure on that file sent back to me, so that I fix the Markdown that I broke.
US-30. As KC, I want agent-workflow's link check done by lychee, and its other repo checks ported to Vitest, so that the repo has no Python and no custom link parser.

### One secrets injector (Must)

US-31. As KC, I want each secret to live once, in Bitwarden Secrets Manager, so that a changed secret needs no copy step on any host.
US-32. As KC, I want each computer to hold one machine token file, mode 600, and no other copy of a loop secret, so that one revoke cuts a lost computer off.
US-33. As KC, I want the loop's run unit and watch unit to start under `bws run`, so that the run, its agents, and the watch page get the secrets as env vars with no secrets file.
US-34. As KC, I want `loop.toml [secrets]` to list only the env var names that the run needs, so that the store holds the values and the repo holds the names.
US-35. As KC, I want `loop start` to refuse with one line that names the missing token file or the missing secret name, so that I know the one fix.
US-36. As KC, I want the watch page to still mask the value of each secret, so that a screenshot of it leaks nothing.
US-37. As KC, I want a GitHub Actions job to read its secrets from the same store through the official Bitwarden action with one repo secret, so that a repo can run its stack in CI with the secrets it has on the T14.
US-38. As KC, I want `loop secrets` and the secrets file gone, and an old `[secrets]` entry with `item` and `field` to warn and be ignored, so that an old `loop.toml` still loads.

### Machines as a repo like the others (Must)

US-39. As KC, I want the chezmoi source at `~/dev/machines`, so that it has a row on the start page, a Remote Control server, and the loop.
US-40. As KC, I want chezmoi to ignore every file of the repo that is not a dotfile, such as the package files, `node_modules`, the Makefile, `AGENTS.md`, `docs`, and the tests, so that no dev file lands in my home folder.
US-41. As KC, I want machines on the gate with the admin bypass of its branch protection left on, so that chezmoi's auto-push and the hourly sync can still push to main.
US-42. As KC, I want each ticket to carry the Jira component of the repo it changes, `agent-workflow` or `machines`, so that a loop run in one repo takes only that repo's tickets.

### Behind the scenes (Must)

US-43. As the maintainer, I want the switchboard tests ported to Vitest against a fake `claude` written in TypeScript, and the suite to pass 20 runs in a row, so that the move keeps the PR #94 behaviour with no flaky test.
US-44. As the maintainer, I want the start page, pages, machine-status, and Mac backup tests ported to Vitest against the same fake commands, written in TypeScript, so that machines has no Python.
US-45. As the maintainer, I want the loop's scenario suite to cover a run under a fake `bws`, so that the secret path is tested end to end with no network.
US-46. As the maintainer, I want the loop to count a blocker outside the run's filter as done when Jira says Done, so that a machines ticket can wait on an agent-workflow ticket. Only when the gate spec's loop does not do this already.
US-47. As the maintainer, I want every document that names `~/.local/share/chezmoi`, `loop secrets`, or the secrets file fixed in the pull request that makes it false, so that no agent follows a dead path.

### Later

US-48. As KC, I want a bot to open a pull request when a pinned tool has a new release, so that bumps need no memory. Later: US-23 shows the bumps first, and the bot is a new tool.
US-49. As KC, I want the restic, B2, healthchecks, and switchboard secrets in the injector, so that every secret lives in one place. Later: a backup must run when Bitwarden is unreachable, and the switchboard token is made on the T14 and pasted into ElevenLabs.
US-50. As KC, I want GitHub Actions to read secrets with OIDC and no stored token, so that no long-lived token sits in GitHub. Later: the Bitwarden action documents only a stored machine token.

## Implementation Decisions

### Where each piece lives

| Piece                                                                                   | Repo           |
| --------------------------------------------------------------------------------------- | -------------- |
| The switchboard                                                                         | agent-workflow |
| The Prettier hook script, its `PostToolUse` entry, and `DISABLE_AUTOUPDATER` in `env`   | agent-workflow |
| The lefthook step of `setup-repo`                                                       | agent-workflow |
| The loop's secret source                                                                | agent-workflow |
| The repo checks of agent-workflow                                                       | agent-workflow |
| The start page, machine-status, and their tests                                         | machines       |
| The global `mise.toml`, the unit and launchd PATHs, the token file, `.chezmoiignore`    | machines       |
| The chezmoi `sourceDir`, the pages registry rows, the README sections that this changes | machines       |

### Tracking a change to machines

- Every ticket is an AW ticket. machines gets no Jira project.
- `to-tickets` sets the Jira component from the repo that the ticket changes. `docs/agents/issue-tracker.md` gets one line for it. A component names a repo, not readiness, so the no-labels rule holds.
- The loop runs once per repo, each with `--filter` on the Epic and the component, which the gate spec's loop input already takes.
- machines gets `/setup-repo` with Jira project `AW`, the gate, and a `loop.toml`, as any repo does. Its branch protection keeps the admin bypass, because `.chezmoi.toml.tmpl` turns on `autoCommit` and `autoPush` and machine-status pushes when ahead. An agent never pushes to main, so the gate still holds for agent work.

### The switchboard

- A package beside the loop, with the loop's TypeScript, oxlint, and Vitest setup from the gate spec. No new runtime dependency: the HTTP server is `node:http`.
- It keeps spawning `claude -p` in stream-json mode with the flags of today: auto mode, the name `switchboard`, replayed user messages, the appended prompt, and an optional model. It does not move to the Agent SDK, because the `[voice:<n>]` tag on replayed user messages is how it tells which turn answers which ask, and the SDK's support for the session name and the replay is not confirmed.
- The timings are constants with today's values: 1 second to the filler, 10 seconds between updates, 30 seconds for a retry to join, 45 seconds in all.
- The response headers and the first empty chunk go out before the ask starts, as today, so ElevenLabs gets bytes at once.
- `switchboard.service` runs Node on the package entry from the main checkout. The unit name, the port 8796, the env file, and the Funnel node stay. The pages registry row and `80-switchboard` change only where they name `uv`.
- The cutover is one restart. A restart ends a call in progress, so KC restarts it when not on a call. The rollback is a revert and a restart.

### The start page and machine-status

- Each is one `.ts` file with only `node:` imports and erasable syntax, run by Node's built-in type stripping. machines gets dev-only `package.json` entries for TypeScript, `@types/node`, oxlint, and Vitest. `tsc --noEmit` runs with `erasableSyntaxOnly`.
- The start page keeps every route, port 8780, the probes, the TTLs, and the env vars that the tests set. `index.html` does not change.
- machine-status keeps its flags, its output lines, its cache, its UNKNOWN rule, and its healthchecks slugs. It finds the chezmoi source with `chezmoi source-path`, as today, so the move of the source needs no change in it.
- A two-line shell shim on PATH runs each file, so `machine-status` stays a command and the units keep their names.
- `start-page.service`, `machine-status.service`, and the Mac launchd plist run Node through the mise shims.

### The toolchain pin

- The machines repo root holds `mise.toml`. chezmoi renders the global config, `~/.config/mise/config.toml`, from it with `include`, so the repo pin and the global pin are one file.
- Pinned there, exact versions: `node`, `uv`, `claude`, `bitwarden-secrets-manager` (the `bws` CLI), `lefthook`, `prettier`, `gitleaks`, `lychee`. The Node major matches the loop's, which the gate spec sets.
- No global Python pin. uv installs the Python that each project names, and the T14's system `python3` keeps the apt packages that depend on it.
- No Playwright pin. Each repo's lockfile pins Playwright, and Playwright installs the browsers of that version.
- mise's shim folder goes first on PATH in `.zshenv`, `environment.d`, each user unit, and the launchd plist. Shims install a missing version on first use, and the hourly job runs `mise install` so a new pin does not wait for a first use.
- Claude Code: `config/settings.json` sets `DISABLE_AUTOUPDATER` to `1` in `env`. The native install on the T14 and the Homebrew cask on the Mac are removed once the pinned `claude` runs. The start page's older-version row now appears only after a pin bump, and its restart button stays.
- `packages.yaml` drops `uv` and `gitleaks` from Homebrew, and `.chezmoiexternal.toml.tmpl` drops gitleaks. The apt `nodejs` stays, because the npm install of `@bitwarden/cli` uses it. `10-packages` never removes a package, so a computer keeps what it has.
- `machine-status --full` prints the output of `mise outdated --global` as observations, with no alert. "Show outdated tool versions", https://mise.jdx.dev/cli/outdated.html.

### The hooks file

- lefthook, one `lefthook.yml` per repo. Its `pre-commit` hook lists every check. Formatters use `stage_fixed`.
- `make check` starts with `lefthook run pre-commit --all-files`, then fails when `git diff --exit-code` shows a change. The gate runs `make check`, so the gate needs no change.
- `setup-repo` writes the checks from what the repo has: Prettier and gitleaks always; lychee in offline mode on Markdown always; Ruff with a `pyproject.toml`; oxlint and `tsc` with a `tsconfig.json`; shellcheck with a shell script. It runs `lefthook install`. A repo that sets `core.hooksPath` has it removed first, so machines loses `.githooks` and `00-git-hooks`.
- agent-workflow adopts it. Its repo checks move to Vitest. lychee replaces the Markdown link test. The em dash, skills, install, co-author, and pull request text checks are ported.
- The Prettier hook: a TypeScript script in `config/`, linked into `~/.claude` by `install.sh` like `notify.sh`. A `PostToolUse` entry with the matcher `Edit|Write` runs it. It reads `tool_input.file_path`, does nothing unless the path ends in `.md`, runs `mise exec -- prettier --write` from the file's folder so the repo's own Prettier pin and config apply, and exits 2 with Prettier's error on a failure, which Claude Code sends to the agent.

### The secrets injector

- Bitwarden Secrets Manager on a Free organization. Two projects: `loop` for the Jira, ntfy, and loop Claude token secrets that every repo's loop uses, and `pitchridge` for the stack secrets. Three machine accounts: `t14`, `mac`, and `github`. Each secret's name is its env var name.
- Each computer holds its token in a mode 600 env file, `BWS_ACCESS_TOKEN=<token>`, listed in `.chezmoiignore`. The token never enters a repo.
- The loop's units, started by `systemd-run`, load that file with `EnvironmentFile=` and run `bws run --` before the loop command. The watch unit does the same, so it knows the values to mask.
- `[secrets]` becomes a list of names. `REQUIRED_SECRETS` stays. `loop start` checks that the token file exists and that `bws` lists each name, and refuses with the one that is missing.
- `loop secrets`, the secrets file, and the code that copies from `bw` are deleted. The loop's design file and `setup-loop` change in the same pull request.
- A stack command outside the loop runs as `bws run --project-id <pitchridge> -- <command>`, which limits it to the stack secrets, as the prefix filter of the Pitchridge wrapper does today. Inside a loop run the agent's env already holds them.
- GitHub Actions: `bitwarden/sm-action` with the `github` machine token in one repo secret. This spec adds no workflow that needs it. It makes the path ready for the Pitchridge spec.

### Moving the chezmoi source

- `.chezmoi.toml.tmpl` sets `sourceDir` to `~/dev/machines`. Each computer moves its source there once and leaves a symlink at `~/.local/share/chezmoi`, so an old path in another repo's docs still resolves.
- chezmoi ignores source names that begin with a dot, so `.claude/worktrees`, `.github`, and the dotfile configs of the dev tools need no entry. `.chezmoiignore` lists every other dev file.
- The pages registry row of the start page, the machines README, and the `setup-loop` files name the new path.

### Seed data

- The switchboard tests: the fake `claude` of today, in TypeScript, with the same triggers: "slow" waits 2 seconds, "inbound" first plays a turn that a message woke, and each message it reads goes on a line of `received.log`.
- The machines tests: the fake `systemctl`, `journalctl`, `claude`, and `tailscale` of today, in TypeScript, and a temporary home with real git repos, as the tests make today.
- The loop secret test: a fake `bws` that runs its command with two set values, and fails with a missing token file.

## Testing Decisions

A good test runs the real program as KC's tools call it, over real HTTP or as a subprocess, against fakes of the commands it runs, and asserts what KC would see or hear. No test asserts a function call. No new test is written for a tool's own behaviour: lefthook, mise, bws, Prettier, and the Claude Code hook are proved by real use, at the first commit, the first apply, and the first run.

The seams are the ones that exist today, ported:

1. The switchboard over real HTTP against a fake `claude`. Prior art: `switchboard/tests/test_switchboard.py`.
2. The start page and machine-status as subprocesses against fake commands and a temporary home. Prior art: `tests/test_start_page.py`, `test_pages.py`, `test_machine_status.py`, and `test_backup_mac.py` in machines.
3. The loop's scenario suite from the gate spec, with a fake `bws`.

The ported tests keep today's margins, such as a 0.5 second filler against a 2 second fake answer. Each ported suite passes 20 runs in a row before its pull request merges.

| Test                                                                                    | Stories                           |
| --------------------------------------------------------------------------------------- | --------------------------------- |
| The last thing said goes in, and the answer streams back without markup                 | US-5                              |
| A reply that arrived between turns is said first                                        | US-6                              |
| A slow answer starts with the filler                                                    | US-1                              |
| A long turn keeps saying it is still working                                            | US-1, US-4                        |
| Three retries of the same words make one turn and all hear the answer                   | US-2, US-3                        |
| The session ID is kept so a restart resumes                                             | US-7                              |
| A request without the token is refused, and the status needs the token                  | US-8, US-9                        |
| A request that hangs up mid-answer leaves no error in the output                        | US-10                             |
| The 20-run repeat of the switchboard suite                                              | US-43                             |
| Each ported start page test: routes, Sessions rows, actions, older version, needs trust | US-12, US-13, US-16, US-44        |
| Each ported pages test: unit, port, serve mapping, checkout and copy drift              | US-12, US-44                      |
| Each ported machine-status test: summary, full report, ping, sync rules, UNKNOWN lines  | US-14, US-15, US-16, US-23, US-44 |
| Each ported Mac backup test                                                             | US-44                             |
| A run under a fake `bws` gives the agent the secrets, and the watch page masks them     | US-33, US-36, US-45               |
| `loop start` refuses with no token file and with a missing name                         | US-35                             |
| An old `[secrets]` entry with `item` and `field` loads with a warning                   | US-34, US-38                      |
| A blocker outside the filter that Jira has Done does not hold a ticket                  | US-46                             |

The ported repo checks of agent-workflow are their own proof for US-30. US-11, US-17 to US-22, US-24 to US-29, US-31, US-32, US-37, and US-39 to US-42 are proved by real use: the first call after the cutover, the first `chezmoi apply` on each computer, the first commit in each repo, and the first gate run in machines. Review checks US-47.

## Out of Scope

- Recibo. Technical. It stays Python. None planned.
- The Pitchridge backend, and Pitchridge's own adoption of the hooks file. Technical. The Pitchridge spec moves its Makefile and CI onto the gate, and its `make check` takes the hooks file then. Its policy scripts and the Prettier line in its `AGENTS.md` go in that change.
- The Pitchridge Makefile's use of the Python wrapper. Technical. A Pitchridge ticket, which blocks the AW ticket that deletes `loop secrets`, because the wrapper reads the secrets file. KC files it.
- The loop, except its secret source and the cross-repo blocker of US-46. Technical. The gate spec.
- The backup scripts, the statusline, and the notify script. Technical. They stay shell. None planned.
- Feature candidate generation. User-visible. Dropped by KC. None planned.

## Further Notes

- This spec is built after the gate spec lands, by the new loop. It needs the gate, the loop's `--filter` input, the loop's TypeScript package, and `setup-repo`'s mise step.
- The Mac was unreachable on 2026-10-29 (`~/.cache/machine-status`: `macbook|UNREACHABLE`), so its current Node and Claude Code versions are UNKNOWN.

### Human steps

1. Create a Bitwarden Free organization with Secrets Manager, the two projects, the secrets by env var name, and the three machine accounts. Put the `t14` and `mac` tokens in each computer's token file, and the `github` token in a repo secret when a workflow first needs it.
2. In Jira, add the components `agent-workflow` and `machines` to AW, and connect the machines repo to Jira's GitHub integration.
3. On each computer, once: move the chezmoi source to `~/dev/machines`, leave the symlink, and run `chezmoi init` so the new `sourceDir` takes effect.
4. Run `/setup-repo` in machines with an admin token.
5. Run `lefthook install` once in each existing clone on the other computer.
6. Remove the native Claude Code on the T14 and the Homebrew cask on the Mac after the pinned `claude` runs.
7. File the Pitchridge ticket for the wrapper.
8. Restart `switchboard.service` at the cutover when not on a call.

### Decisions for KC to verify

| Decision                                                   | Why                                                                                                         | Evidence                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets: Bitwarden Secrets Manager                         | KC is on Bitwarden already, the free tier fits, and it has a run command and a GitHub action                | Free plan "Up to 2 users", "Up to 3 machine accounts", "Up to 3 projects", unlimited secrets; Teams $6 per user per month, https://bitwarden.com/products/secrets-manager/, read 2026-10-29                                                                                |
| `bws run --` as the injector                               | One hop, no file, no custom code                                                                            | "`bws run -- 'your-command'`", `--project-id`, `BWS_ACCESS_TOKEN`, https://bitwarden.com/help/secrets-manager-cli/, read 2026-10-29                                                                                                                                        |
| CI through `bitwarden/sm-action` with one stored token     | The official action; no OIDC found                                                                          | `access_token: ${{ secrets.SM_ACCESS_TOKEN }}`, https://github.com/bitwarden/sm-action, read 2026-10-29                                                                                                                                                                    |
| Not Infisical                                              | A new vendor and a full migration; its OIDC is the one advantage                                            | Free "5 identities, unlimited projects, 3 environments"; Pro "$20/identity/month", https://infisical.com/pricing; OIDC, https://infisical.com/docs/integrations/cicd/githubactions, read 2026-10-29                                                                        |
| Not Doppler                                                | A new vendor; its GitHub path syncs into GitHub secrets, a second copy                                      | Developer "Free for 3 users", 50 service tokens, https://doppler.com/pricing; GitHub App sync, https://docs.doppler.com/docs/github-actions, read 2026-10-29                                                                                                               |
| Not 1Password                                              | A new paid account for KC, and its price for service accounts is UNKNOWN                                    | `OP_SERVICE_ACCOUNT_TOKEN`, https://www.1password.dev/service-accounts/get-started/, read 2026-10-29; the pages read give no plan or price for service accounts                                                                                                            |
| The machine token in an `EnvironmentFile`                  | systemd's own way to give a unit env vars; Bitwarden has no systemd doc                                     | `units.py` `run_in_unit` passes `--property` to `systemd-run`; no Bitwarden systemd page found                                                                                                                                                                             |
| Secrets recreated in Secrets Manager by hand               | The docs do not say that `bws` reads vault items                                                            | https://bitwarden.com/help/secrets-manager-overview/ covers Secrets Manager organizations only                                                                                                                                                                             |
| Hooks: lefthook, not pre-commit                            | A standalone binary in the mise registry, so mise pins it and its tools; pre-commit installs with pip       | "standalone, no-deps binary", https://github.com/evilmartians/lefthook/blob/master/docs/install.md; `--all-files`, https://github.com/evilmartians/lefthook/blob/master/docs/usage/commands/run.md; `pip install pre-commit`, https://pre-commit.com/                      |
| One hook for commit and check                              | `--all-files` turns the staged-file list into every file, so no second list                                 | `lefthook run pre-commit --all-files`, lefthook `run.md` above; `stage_fixed`, `docs/configuration/stage_fixed.md` there                                                                                                                                                   |
| lychee replaces the Markdown link test                     | An established tool already used in Pitchridge's CI, over 75 lines of custom parsing                        | `tests/test_markdown.py`; Pitchridge `.github/workflows/ci.yml` "Links in the repo" step                                                                                                                                                                                   |
| Claude Code hook on `Edit\|Write`                          | The documented event and matcher                                                                            | `PostToolUse` "After a tool call succeeds", `"matcher": "Edit\|Write"`, `tool_input.file_path`, https://code.claude.com/docs/en/hooks, read 2026-10-29                                                                                                                     |
| One `mise.toml` in machines, rendered as the global config | One file is both the gate's pin for machines and the computers' default                                     | Global config in `~/.config/mise`, https://mise.jdx.dev/configuration.html; `include` already used in `60-start-page`                                                                                                                                                      |
| Shims first on PATH in units and launchd                   | Units never run a shell, so `.zshenv` does not reach them                                                   | `dot_config/environment.d/path.conf` comment; shims "for editors and other programs that never see an activated shell", https://mise.jdx.dev/dev-tools/shims.html                                                                                                          |
| `mise install` in the hourly job                           | The sync applies with `--exclude=scripts`, so a `run_onchange` script would not run                         | machines README, Automation: `chezmoi apply --exclude=scripts`                                                                                                                                                                                                             |
| Claude Code from mise's `claude` tool, auto-updater off    | KC's decision; mise has the tool, and Claude Code has the off switch                                        | `registry/claude.toml` in jdx/mise, backend from Anthropic's release bucket; "Set `DISABLE_AUTOUPDATER` to `"1"`", https://code.claude.com/docs/en/setup, read 2026-10-29                                                                                                  |
| No global Python pin                                       | A mise `python3` shim first on PATH would hide the apt Python packages on the T14                           | machines `.chezmoidata/packages.yaml`: `python3-openpyxl`, `python3-pil`; uv already pins per project                                                                                                                                                                      |
| No Playwright pin in mise                                  | The regressions came from dependency bumps, which the lockfile and the gate control, not from the computers | Pitchridge commit `0edec7a` "the regressions of the WorkOS SDK 10.6 and Playwright 1.64 updates", after Dependabot PRs #185 and #192                                                                                                                                       |
| The amber Sessions rows are not drift between computers    | The row compares a running server with the installed version on the same computer                           | machines `executable_start-page` `started_with`, `installed`, `row`; README Sessions paragraph                                                                                                                                                                             |
| Start page and machine-status stay in machines             | chezmoi deploys them as copies, and the pages registry names machines as their home                         | `.chezmoidata/pages.toml` Start page row; `60-start-page` hashes the server file                                                                                                                                                                                           |
| One `.ts` file each, run by type stripping                 | No build and no install at run time, so the chezmoi copy model holds                                        | "v23.6.0, v22.18.0: Type stripping is enabled by default", https://nodejs.org/api/typescript.html; `erasableSyntaxOnly`, https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html                                                                    |
| machine-status is shell, not Python                        | It is 639 lines of bash with four inline `python3` blocks; the port replaces both                           | `grep -c python3 dot_local/bin/executable_machine-status` gives 4                                                                                                                                                                                                          |
| The switchboard keeps `claude -p`                          | The stream-json protocol is what PR #94 proved, and the fake `claude` tests it                              | `session.py` `TAG`, `--replay-user-messages` in `cli.py`; Agent SDK support for the name and replay is UNKNOWN                                                                                                                                                             |
| Move the chezmoi source to `~/dev/machines`                | Sessions lists repos in `~/dev`, and `claude-rc@.service` runs in `%h/dev/%i`                               | README Sessions paragraph; `dot_config/systemd/user/claude-rc@.service` `WorkingDirectory`; `sourceDir`, https://www.chezmoi.io/reference/configuration-file/variables/                                                                                                    |
| Ignore list covers only non-dot files                      | chezmoi skips dot names in the source                                                                       | "chezmoi ignores all files and directories in the source directory that begin with a `.`", https://www.chezmoi.io/reference/source-state-attributes/                                                                                                                       |
| Admin bypass stays on in machines                          | Auto-push and the hourly sync push to main as KC                                                            | `.chezmoi.toml.tmpl` `autoCommit`, `autoPush`; "restrictions ... don't apply to people with admin permissions" by default, https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches |
| AW tickets with a repo component                           | machines has no Jira project, and an Epic run must not take another repo's ticket                           | Gate spec: `loop start` takes `--filter <JQL>`; `docs/agents/issue-tracker.md` bans readiness labels only                                                                                                                                                                  |
| The repo checks of agent-workflow move to Vitest           | They are the last Python in the repo after the switchboard                                                  | `git ls-files` lists only `switchboard/` and `tests/` as Python outside `loop/`                                                                                                                                                                                            |

### UNKNOWN

- 1Password's plan and price for service accounts: the official pages read on 2026-10-29 give neither.
- Whether `bws` can read Password Manager vault items: the docs do not say, so the plan recreates the secrets.
- Whether the Agent SDK supports the session name and replayed user messages that the switchboard uses: not checked against the SDK docs, so the switchboard keeps `claude -p`.
- Whether the gate spec's loop already counts a cross-repo blocker as done: that loop is not built yet. US-46 holds the change if it does not.
- Whether lefthook refuses to install while `core.hooksPath` is set: not found in its docs, so the plan unsets it first.
- Whether Dependabot or another bot can bump mise pins: not checked. US-48.
- The Mac's current toolchain: the Mac was unreachable.
