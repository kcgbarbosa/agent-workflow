# The build workflow

This file gives the order of the work for one feature, from the first question to merged code, and where each output goes.
Each skill holds its own steps. Where a skill publishes something, `docs/agents/issue-tracker.md` overrides it.

## One cycle

| #   | Step          | Skill                                        | Output                                                                                                                                   | Where it lives                           |
| --- | ------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | Feature grill | `grill-with-docs`                            | ADRs and glossary terms                                                                                                                  | `docs/adr/`, `GLOSSARY.md`               |
| 2   | Spec          | `to-spec`, then `to-prd` with a PRD          | The spec and the Epic, then the PRD in the Epic description                                                                              | `docs/specs/<feature>.md`, the Jira Epic |
| 3   | Tickets       | `to-tickets`                                 | Tasks with blocking links                                                                                                                | Jira, under the Epic                     |
| 4   | Planning      | None                                         | The hand-set fields on each ticket                                                                                                       | Jira                                     |
| 5   | Build         | The loop, or `implement` in a T3 Code thread | A branch and a pull request for each ticket, with an acceptance test for each line, and auto-merge on                                    | Git, the git host                        |
| 6   | Gate          | None                                         | `gate / check`, then `gate / review` and `gate / judge`. All green: GitHub squashes the pull request to one commit on the default branch | The git host                             |
| 7   | Acceptance    | None                                         | The deployed result checked against each ticket's "What the user sees"                                                                   | Jira                                     |

The owner makes every decision in a grill, approves a PRD before `/to-prd` writes it, and approves the tickets before they are published. Nobody merges by hand: the gate decides, and auto-merge merges. The `hold` label keeps a green pull request waiting until the owner takes it off. `loop.toml` turns the review on or off.
A repo off the gate, such as machines, has no auto-merge, and the owner merges.

Steps 1 to 3 share one context window. When it fills up, `/handoff` writes a summary and a new window continues from it.
A small change skips steps 2 to 4 and goes from the grill to `implement`.
A decision grill stops after step 1. Its only output is an ADR. A feature grill continues to steps 2 and 3.

## Two ways to build

| Way              | Scope                  | Pull requests                                                 | Context                                                                                                |
| ---------------- | ---------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| The loop         | All tickets of an Epic | One for each ticket, stacked on a blocker's open pull request | A script starts a session for each ticket, and resumes it with the failing checks when the gate is red |
| A T3 Code thread | One ticket             | One for the ticket                                            | The thread runs `implement` in its own worktree, then pushes and opens the pull request                |

The owner picks one for each Epic. `/setup-loop` writes `docs/agents/loop.md` for a repo that uses the loop.

After a build, the owner can run `/retro` in the same window. It looks at the session and proposes changes to the checks and the pointers an agent reads.
