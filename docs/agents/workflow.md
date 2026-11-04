# The build workflow

This file gives the order of the work for one feature, from the first question to merged code, and where each output goes.
Each skill holds its own steps. Where a skill publishes something, `docs/agents/issue-tracker.md` overrides it.

## One cycle

| #   | Step          | Skill                                          | Output                                                                                                            | Where it lives                           |
| --- | ------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | Feature grill | `grill-with-docs`                              | ADRs and glossary terms                                                                                           | `docs/adr/`, `GLOSSARY.md`               |
| 2   | Spec          | `to-spec`, then `to-prd` with a PRD            | The spec and the Epic, then the PRD in the Epic description                                                       | `docs/specs/<feature>.md`, the Jira Epic |
| 3   | Tickets       | `to-tickets`                                   | Tasks with blocking links                                                                                         | Jira, under the Epic                     |
| 4   | Planning      | None                                           | The hand-set fields on each ticket, and its move from Backlog to To Do, which approves its build                  | Jira                                     |
| 5   | Build         | The runner, or `implement` in a T3 Code thread | A branch and a pull request for each ticket, with an acceptance test for each line, and auto-merge on             | Git, the git host                        |
| 6   | Gate          | None                                           | `gate / check` and `gate / fuzz`. All green: GitHub squashes the pull request to one commit on the default branch | The git host                             |
| 7   | Acceptance    | None                                           | The deployed result checked against each ticket's "What the user sees"                                            | Jira                                     |

The owner makes every decision in a grill, approves a PRD before `/to-prd` writes it, and approves the tickets before they are published. Nobody merges by hand: the gate decides, and auto-merge merges. A draft pull request waits until the owner marks it ready. `[fuzz] enabled` in `gate.toml` turns the fuzz job on or off.
A repo off the gate, such as machines, has no auto-merge, and the owner merges.

Steps 1 to 3 share one context window. When it fills up, `/handoff` writes a summary and a new window continues from it.
A small change skips steps 2 to 4 and goes from the grill to `implement`.
A decision grill stops after step 1. Its only output is an ADR. A feature grill continues to steps 2 and 3.

## Two ways to build

| Way              | Scope                          | Pull requests                                      | Context                                                                                          |
| ---------------- | ------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| The runner       | Each ready ticket of the queue | One for each ticket, once its blockers have merged | A timer starts a T3 thread for each ticket, and sends it the failing checks when the gate is red |
| A T3 Code thread | One ticket                     | One for the ticket                                 | The thread runs `implement` in its own worktree, then pushes and opens the pull request          |

With the runner, the component decides: it builds every ready ticket of the repo's component, so a thread started by hand takes only a ticket out of that queue. A new ticket waits in Backlog. To start a build, by chat or by voice, move the ticket to To Do. `/setup-runner` writes `docs/agents/runner.md` for a repo that uses the runner.

`/correct` opens one pull request that makes the most frequent mistake class impossible. A T3 scheduled thread can run it once a day.
