# Shared merge gate, and the loop as a PR runner

Epic: [AW-1](https://kcgbarbosa.atlassian.net/browse/AW-1). Key persona: KC, the maintainer of every repo. ADRs: none in this repo. This file holds the requirements for one reusable gate that every repo calls, the two model checks that run inside it, auto-merge behind it, and the loop that pushes a pull request and waits for it, rewritten in TypeScript.

## Problem Statement

KC builds several repos with agents and merges their work alone. Each repo has its own idea of what must be true before work lands. In Pitchridge, three different gates run three different subsets, the loop runs two of them itself, and CI runs a third that repeats on every merge. In the other repos there is no gate at all, so the loop cannot be trusted there, and KC does every small change by hand.

KC does not read pull requests. The trust that lets KC press merge comes from the checks, so every check has to be one that cannot be skipped, that a second opinion backs, and that works the same in every repo. Today the only code review is a session of the same model right after it wrote the code, and the UI review writes faults into a comment that nothing reads. A review that is allowed to keep fixing small things burns the usage window and stalls the run.

## Solution

One reusable GitHub workflow, the gate, lives in agent-workflow. A repo adopts it with a ten-line workflow file, a `loop.toml`, and a `make check` target that runs everything the repo needs green. The gate runs that target, asks a second model to review the pull request once, judges only the screenshots whose pixels changed, and lets a green pull request merge itself. Branch protection makes the gate required, so nothing reaches main another way.

The loop stops running gates and building an Epic branch. For each ticket on the frontier it starts the agent, pushes a branch, opens the pull request, and waits for the gate. Red sends the failure back to the agent up to the attempt limit. Green merges. The loop takes an Epic, one ticket, or a filter, so it runs a typo fix and a twenty-ticket Epic the same way. It is rewritten in TypeScript on the Claude Agent SDK, and KC can read it.

## User Stories

### Adopting the gate (Must)

US-1. As KC, I want to put a repo on the gate by adding one short workflow file that calls the shared one, so that every repo runs the same checks without a copy of them.
US-2. As KC, I want the gate to run the repo's own `make check`, so that the repo decides what a green check means and the gate stays the same everywhere.
US-3. As KC, I want `setup-repo` to write the workflow file, the `loop.toml`, and the branch protection in one run, so that adopting a repo is one command and no settings page.
US-4. As KC, I want the branch protection to require the gate, allow squash merges only, allow auto-merge, and delete the branch after the merge, so that main takes only green work and no settings drift between repos.
US-5. As KC, I want a repo with no browser tests and no stack to pass the gate with only its unit tests, so that agent-workflow, machines, and recibo adopt it with no new tests.
US-6. As KC, I want the gate to install the repo's pinned toolchain before the check, so that the runner uses the same Node, Python, and uv as the T14.
US-7. As KC, I want the gate to run on pull requests only and never again on the push to main, so that a merge bills no second run.
US-8. As KC, I want a new push to a pull request to cancel the older run, so that a stale run bills nothing.
US-9. As KC, I want a docs-only pull request to skip the test job and the review and still pass the gate, so that a one-line doc fix merges in a minute.

### The second-model review (Must)

US-10. As KC, I want a model that did not write the code to review each pull request once, so that the merge rests on a second opinion and not on the author's confidence.
US-11. As KC, I want the review to post its findings as a pull request review, with each finding at its line, so that the finding is where the agent and I read code.
US-12. As KC, I want a review with a blocking finding to fail its check, so that auto-merge waits until the agent resolves it.
US-13. As KC, I want the review to skip paths I name, such as docs and lockfiles, so that a dependency bump or a doc fix costs no model run.
US-14. As KC, I want the review to run on the model and effort that `loop.toml` names, with a strong default, so that the second opinion is never weaker than the model that wrote the code.
US-15. As KC, I want the review to bill the account I name in the repo's secrets, so that it can run on API billing apart from my own windows.
US-16. As KC, I want the review to read the repo's `AGENTS.md`, the ticket, and the spec the pull request names, so that it checks the work against what was asked and the repo's standards, not against taste.
US-17. As KC, I want a second review on a later push to look only at what changed since the last review, so that a fix does not pay for a full review again.
US-60. As KC, I want each review to end with the line `review api cost: $<amount>`, so that I see what every review cost.
US-61. As KC, I want to turn the review off in a repo's `loop.toml`, and `setup-repo` to ask whether it is on, so that a small private repo spends nothing on reviews.

### The UI judge (Must)

US-18. As KC, I want the check to compare each step screenshot with its saved baseline and to flag only a change above a tolerance, so that anti-aliasing noise never wakes a model.
US-19. As KC, I want a model to look only at the steps whose screenshot changed, with the before image, the after image, and the ticket line for that step, so that it judges a change and never hunts for problems.
US-20. As KC, I want the judge to answer each changed step with one of blocking, minor, or fine, and one sentence, so that the result is a fixed shape I can read on a phone.
US-21. As KC, I want the blocking list to be a short list of words in `loop.toml`, such as text cut off, element off screen, untranslated key, wrong value, broken layout, so that only what I named can block.
US-22. As KC, I want a blocking verdict to fail the judge check and a minor verdict to become a checklist comment on the pull request, so that small things never stop a merge and never get lost.
US-23. As KC, I want the judge to have no tools and one turn per step, so that it cannot loop, fix, or spend more than cents.
US-24. As KC, I want a pull request that changed no screenshot to skip the judge, so that a backend change costs no judge run.
US-25. As KC, I want a pull request that changes a screen to commit its new screenshots as the baselines, so that I see the change in the diff and the next pull request compares with what main shows.

### Auto-merge (Must)

US-26. As KC, I want a pull request the loop opened to merge itself when every required check is green, so that I am not the merge button.
US-27. As KC, I want a pull request I open myself to merge itself only after I enable auto-merge on it, so that my own drafts wait for me.
US-28. As KC, I want to hold any pull request by converting it to a draft or adding a `hold` label, so that one click stops a merge I want to look at.
US-29. As KC, I want the merge to be a squash with the pull request title as the commit, so that main keeps one commit per ticket with its key.

### The loop as a PR runner (Must)

US-30. As KC, I want to start the loop with an Epic key, a ticket key, or a filter, so that one command runs a typo fix and a whole Epic.
US-31. As KC, I want the loop to take the frontier from the tracker's blocking links as it does today, so that `to-tickets` output needs no change.
US-32. As KC, I want each ticket to get a worktree and a branch from main, the agent run, a push, and a pull request, so that every ticket is one pull request.
US-33. As KC, I want a ticket blocked by a ticket whose pull request is still open to branch from that pull request's branch and target it, so that dependent tickets run without waiting for a merge.
US-34. As KC, I want the dependent pull request to retarget main when its base merges, so that the stack unwinds by itself.
US-35. As KC, I want the loop to wait for the gate and read the result from GitHub, so that the loop and I trust the same check.
US-36. As KC, I want a red gate to resume the agent with the failing job's log tail and the review's blocking findings, up to the attempt limit, so that the agent fixes its own work.
US-37. As KC, I want a ticket that stays red after the limit to be flagged in the tracker with the reason and the pull request link, so that I see what needs me.
US-38. As KC, I want the loop to set the ticket to In Progress at start and In Review when the pull request opens, and the tracker to set Done at merge, so that the board tells the truth without a person.
US-39. As KC, I want a ticket whose pull request merged before the run to count as done, so that a restart never redoes merged work.
US-40. As KC, I want the loop to pause at a usage limit and resume when it resets, as today, so that a run survives the window.
US-41. As KC, I want each agent to still get its own stack slot for the tests it runs while building, so that two tickets build side by side.
US-42. As KC, I want the loop to run no gate, no code review, no UI review, no landing, no Epic branch, and no Epic pull request, so that the loop does only what the gate cannot.
US-43. As KC, I want an Epic whose tickets have all merged to be marked complete and its spec archived, so that the end of an Epic needs no person.
US-44. As KC, I want the loop written in TypeScript on the Claude Agent SDK, so that I can read it and it runs agents through a library and not a process.
US-45. As KC, I want the decisions log to keep its JSONL shape with one line per step, so that the watch page, the report, and the forecast keep working.
US-46. As KC, I want the watch page to show each ticket's pull request and the state of its checks, so that I follow a run from the phone as today.
US-47. As KC, I want the cost report to keep its plan meter view, so that I see what a run cost in windows.
US-48. As KC, I want the loop to run as a systemd unit on the T14 and `loop start`, `loop stop`, and `loop watch` to keep their names, so that nothing in `docs/agents/loop.md` of a repo changes but the settings.

### Skills (Must)

US-49. As an agent running `implement`, I want the skill to tell me to run the tests that cover my change, commit, and stop, and never to run the gate or open the pull request, so that the loop and the gate do their parts.
US-50. As an agent writing a pull request body, I want the `pr` skill to ask for the ticket, the spec, and the evidence, and never for a list of decisions, so that a reviewer reads what matters.
US-51. As the review check, I want the `code-review` skill to return its findings in a fixed shape with a file, a line, a severity, and a sentence, so that the gate can post them and decide.
US-52. As KC, I want `check-loop` to read the new log shape and the pull request state, so that it still tells me what is wrong in a few lines.
US-53. As KC, I want the loop design in `loop.md` rewritten for the new loop in the same pull request as the code, so that the design and the code never disagree.

### Behind the scenes (Must)

US-54. As the maintainer, I want the gate's own repo, agent-workflow, to run on the gate, so that every change to the gate passes through it.
US-55. As the maintainer, I want the loop's scenario tests to run `loop` as a subprocess against a fake tracker, a fake GitHub, and a fake agent, as today, so that a run is tested end to end with no network.
US-57. As the maintainer, I want a `loop.toml` key the old loop knew and the new loop dropped to print a warning naming the key, so that an old file still loads.

### Later

US-56. As the maintainer, I want the review and the judge to be tested with recorded pull requests and screenshots, so that a change to a prompt shows its effect before it ships. Later: the first real pull requests show more than recorded ones.
US-58. As KC, I want a merge queue, so that two green pull requests that conflict never both land. Later, because squash on a small team seldom conflicts.
US-59. As KC, I want the gate to run on a self-hosted runner on the T14 when a repo asks, so that a repo with a stack runs its browser tests with its secrets. Later: the Pitchridge spec decides and the gate takes a `runs-on` input then.

## Implementation Decisions

### The gate

- One reusable workflow named `gate` in agent-workflow, called with `workflow_call`. agent-workflow is public, so any repo of the account can call it.
- The gate runs on GitHub-hosted runners. A private repo bills its own minutes.
- Inputs: the check command, default `make check`; the review skip paths; the review model and effort; a flag for docs-only detection. Secrets: the token the review and the judge bill.
- Jobs, in order: `check`, `review`, `judge`. Each is a job of its own so each is a required status of its own. `review` and `judge` run after `check` passes, so a broken build never pays for a model.
- The `check` job installs the toolchain from the repo's `mise` file when one exists, then runs the check command. The repo's check command starts whatever stack it needs. Docker is on every runner. No service containers in the gate, so one workflow serves a repo with Postgres and a repo with nothing.
- Docs-only is decided by the changed paths against the base: only `*.md` and `docs/`. Then `check` runs the repo's format and docs checks only, and `review` and `judge` are skipped and report success.
- The `judge` job runs only when the `check` job uploaded a screenshot diff artifact. A repo produces that artifact from its own browser tests, with Playwright's screenshot comparison, at a tolerance set in the repo. The gate reads the diff folder convention and nothing else about the tests.
- Auto-merge is GitHub's own. The loop enables it on each pull request it opens. A person enables it on their own. A `hold` label is a required check that fails while the label is on.
- Auto-merge is on in every repo that adopts the gate, with no required approvals. A merge to main is not a release. A repo that serves users ships to production by a tag that KC pushes, and one tag can carry many merged pull requests. The Pitchridge spec sets up its staging and its tags.
- Branch protection is written by `setup-repo` through the GitHub API: required checks `gate / check`, `gate / review`, `gate / judge`, and `hold`; no required approvals; squash only; auto-merge on; delete branch on merge; no force push.

### The review

- A composite action in agent-workflow. It runs Claude Code in the runner with the repo's `code-review` skill, reads the pull request, the ticket text the loop attached, the spec the body names, and `AGENTS.md`.
- Output is one JSON list of findings, each with a path, a line, a severity of blocking or minor, and one sentence. The action posts them as one pull request review, requests changes on any blocking finding, and fails the job on blocking.
- A later push runs the review on the diff since the last reviewed commit only, with the earlier findings as context.
- `loop.toml [review] enabled` turns the job on or off. Off skips the job, and the job reports success. `setup-repo` asks, and recommends off for a small private repo.
- The review ends with `review api cost: $<amount>`, the cost Claude Code reports for the run, to the cent.
- Default model Opus 5.5 at high effort. `loop.toml [review]` overrides it. The token comes from the repo secret the action names, so a repo can bill the API.

### The judge

- A composite action. Input is the diff artifact: for each changed step, the baseline, the new image, the diff image, and the step's ticket line, which the repo's test writes beside the screenshot.
- One model call per changed step, no tools, a fixed JSON answer: verdict, sentence. The prompt holds the blocking list from `loop.toml [ui] blocking` and says that anything not on the list is minor or fine.
- Blocking fails the job and comments the step, the sentence, and the two images. Minor collects into one checklist comment. Fine says nothing.
- The pull request commits its new screenshots as the baselines. The gate never writes to main.

### The loop

- TypeScript, Node 22, one package in `loop/`. The Claude Agent SDK runs each agent session and streams its events to the agent log. Processes go through one spawn function with the process group kill of today.
- Input: `loop start <KEY>` where KEY is an Epic, a ticket, or `--filter <JQL>`. The frontier is the set of tickets whose blockers are merged or whose blockers have an open pull request to stack on.
- A ticket is a fixed list of steps: build, push, pull request, wait, merge. A restart starts each ticket at its first step with no pass at the branch's HEAD, as today.
- Wait polls the pull request's check runs through `gh`. Red collects the failing job's log tail and the review's blocking findings into one message and resumes the session as a fix attempt. The attempt limit and the circuit breaker keep their keys.
- Stacking: a ticket whose blocker has an open pull request branches from that branch and targets it. GitHub retargets the dependent pull request to main when the base merges and its branch is deleted. The loop checks the base after each merge and retargets itself when GitHub did not.
- Dropped `loop.toml` keys: `[gates]`, `[acceptance]`, `[ui].skill`, `[demo]`. Kept: `[tracker]`, `[agent]`, `[limits]`, `[stack]`, `[ui].path` and `accepted_unchecked`, `[notify]`, `[watch]`, `[secrets]`. New: `[ui].blocking`, `[review]`. A dropped key warns and is ignored.
- The decisions log keeps one JSONL line per step with the same fields, plus `pr` on the pull request line and `checks` on the wait result. The watch page reads the pull request and the checks from the log, not from GitHub, so it keeps working offline.
- systemd units, `loop secrets`, the usage pause, the notify events, and the report keep their behaviour. The archive step runs when the last ticket of an Epic merges.

### Skills

- `setup-repo` gains a step that writes the caller workflow, a `loop.toml` with the new keys, a `mise` file when the repo has none, and the branch protection through `gh api`. It keeps its four docs.
- `setup-loop/loop.md` is rewritten as the design of the new loop, with the fixed rules renumbered. The docs test that checks every `loop.toml` key against it stays.
- `implement` loses the gate and the pull request steps. `pr` loses the decisions section. `code-review` gains the fixed output shape. `check-loop` reads the new log.

### Seed data

- The scenario tests get a fake `gh` that records pull requests and check runs, beside today's fake `claude` and fake Jira. A test sets a check to red or green and the loop reacts.
- The review and judge tests get three recorded pull requests: one clean, one with a blocking finding, one docs-only; and three screenshot pairs: no change, a one-pixel change under tolerance, and a cut-off title.

## Testing Decisions

A good test runs the real command against fakes and asserts what KC would see: the lines in the log, the state of the pull request, the comment on it. No test asserts a function call.

One seam: the loop's scenario tests. `loop run` runs as a subprocess against the fake tracker, the fake `gh`, and the fake agent, in a temporary git repo, as `loop/tests` does today. The suite moves to Vitest with the same fixtures.

Prior art: `loop/tests/conftest.py` and `test_run.py`.

| Test                                                                                       | Stories             |
| ------------------------------------------------------------------------------------------ | ------------------- |
| `loop start` with an Epic, a ticket, and a filter builds the same frontier shape           | US-30, US-31        |
| A ticket becomes a worktree, a branch, a pull request with auto-merge on                   | US-32               |
| A dependent ticket stacks on an open pull request and retargets main after the base merges | US-33, US-34        |
| Red resumes the agent with the log tail and the findings, then flags after the limit       | US-35, US-36, US-37 |
| Statuses follow start, pull request, and merge                                             | US-38               |
| A merged ticket is not rebuilt on restart                                                  | US-39               |
| A usage limit pauses and resumes the run                                                   | US-40               |
| Two tickets build on two slots                                                             | US-41               |
| The log has no gate, review, land, or Epic branch lines                                    | US-42               |
| The last merge of an Epic archives the spec                                                | US-43               |
| The watch page shows each pull request and its checks from the log                         | US-45, US-46, US-47 |
| `loop start`, `loop stop`, and `loop watch` run as units                                   | US-48               |
| The scenario suite runs with no network                                                    | US-55               |
| An old `loop.toml` loads with a warning per dropped key                                    | US-57               |

The gate, the review, the judge, auto-merge, and `setup-repo` have no tests of their own. When agent-workflow adopts the gate, its first pull requests run each check on the real GitHub, and that is the proof for US-1 to US-29, US-54, US-60, and US-61. Review checks US-44 and the skill stories, US-49 to US-53.

## Out of Scope

- Pitchridge's own suites, the stubbed suite deletion, test speed, previews, staging, and releases. Technical. The Pitchridge spec picks them up.
- The switchboard, the start page, machine-status, the secrets injector, and the toolchain pin outside the gate. Technical. The tooling spec picks them up.
- A merge queue. Technical. US-58, none planned.
- A self-hosted runner. Technical. US-59, the Pitchridge spec decides.
- Feature candidate drafting. User-visible. Dropped by KC, none planned.
- Any tracker other than Jira. Technical. None planned.

## Further Notes

- The current loop builds this spec, in agent-workflow, where the check is `uv run pytest`. Its last ticket is the rewrite. The new loop builds the Pitchridge spec and the tooling spec.
- Human steps: the repo secret for the review token, and the first `setup-repo` run that writes branch protection, which needs an admin token.
- Numbers behind this spec, from the Pitchridge logs of October 14 to 28: the loop's code reviews cost a median of $1.22 at list price; the UI review on PITCH-176 reported every test failing and the ticket landed; the merge gate ran about 20 minutes per ticket; 152 of 320 CI minutes were the repeat run on main.
