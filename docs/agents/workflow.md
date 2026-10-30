# The build workflow

This file gives the order of the work for one feature, from the first question to deployed code, and where each output goes.
Each skill holds its own steps. Where a skill publishes something, `docs/agents/issue-tracker.md` overrides it.

## One cycle

| #   | Step             | Skill                               | Output                                                                 | Where it lives                           |
| --- | ---------------- | ----------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------- |
| 1   | Feature grill    | `grill-with-docs`                   | ADRs and glossary terms                                                | `docs/adr/`, `GLOSSARY.md`               |
| 2   | Spec             | `to-spec`, then `to-prd` with a PRD | The spec and the Epic, then the PRD in the Epic description            | `docs/specs/<feature>.md`, the Jira Epic |
| 3   | Tickets          | `to-tickets`                        | Tasks with blocking links                                              | Jira, under the Epic                     |
| 4   | Planning         | None                                | The hand-set fields on each ticket                                     | Jira                                     |
| 5   | Build            | `implement` or the loop             | Commits on a branch, with an acceptance test for each line, and a pull request | Git                                      |
| 6   | Review and merge | `code-review`                       | A pull request, then one commit on the default branch                  | The git host                             |
| 7   | Acceptance       | None                                | The deployed result checked against each ticket's "What the user sees" | Jira                                     |

The owner makes every decision in a grill, approves a PRD before `/to-prd` writes it, approves the tickets before they are published, and merges. The agent never merges into the default branch.

Steps 1 to 3 share one context window. When it fills up, `/handoff` writes a summary and a new window continues from it.
A small change skips steps 2 to 4 and goes from the grill to `implement`.
A decision grill stops after step 1. Its only output is an ADR. A feature grill continues to steps 2 and 3.

## Two ways to build

| Way         | Scope                  | Pull requests       | Context                                                                 |
| ----------- | ---------------------- | ------------------- | ----------------------------------------------------------------------- |
| `implement` | One ticket             | One for each ticket | Each ticket starts a new window                                         |
| The loop    | All tickets of an Epic | One for each ticket | A script starts a new session for each ticket, and the gate checks each |

The owner picks one for each Epic. `/setup-loop` writes `docs/agents/loop.md` for a repo that uses the loop.

After a build, the owner can run `/retro` in the same window. It looks at the session and proposes changes to the checks and the pointers an agent reads.
