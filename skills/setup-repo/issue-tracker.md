# Issue tracker: Jira

Tickets live in Jira, project `<KEY>`. They are not files in this repo.

## Documents

| Document | Where it lives                            | Written by    |
| -------- | ----------------------------------------- | ------------- |
| Epic     | A Jira Epic, one for each feature         | `/to-spec`    |
| Spec     | `<spec folder>/<feature>.md` in this repo | `/to-spec`    |
| Ticket   | A Jira Task under the Epic                | `/to-tickets` |

`/to-spec` creates the Epic when the spec names none. The Epic's description is one line, `Spec: <link>`, which links the spec on the default branch.

The brief is not a ticket. It lives at `README.md`.
The spec is the source of truth for the build, the tests and the tickets. A ticket names the spec by its repo path, as text with no link, and cites story IDs. It does not copy the spec. Only the Epic links the spec.

When the Epic merges, a pull request deletes the spec, and the Spec line of the Epic changes to link the spec at the head of the default branch at that point, a commit git keeps. With the loop, the archive step does both when the last ticket of the Epic merges, as rule 10 of `~/.claude/skills/setup-loop/loop.md` gives. Without the loop, the owner does both by hand. The Spec line is the one line of the Epic that changes after it is written, and no ticket changes.

## The PRD

The Epic is the PRD. `/to-prd` replaces the description that `/to-spec` wrote with the whole PRD, from the spec, the metrics file, the personas file and the README Users table. The PRD ends with the Spec line. A re-run overwrites it. Nobody edits it by hand. A change to the PRD goes into the spec or the metrics file, and `/to-prd` runs again.
The PRD owner shown on the PRD is `<PRD owner>`.

| File     | Path                                | Written by                     |
| -------- | ----------------------------------- | ------------------------------ |
| Metrics  | `<Metrics file path>` in this repo  | The owner                      |
| Personas | `<Personas file path>` in this repo | The owner, drafted by an agent |

## The board

Issues carry these fields.

| Field         | Values                              | Who sets it |
| ------------- | ----------------------------------- | ----------- |
| Status        | To Do, In Progress, In Review, Done | The loop    |
| Priority      | Highest, High, Medium, Low          | The owner   |
| <Extra field> | <Values>                            | The owner   |

The owner sets priority and the other hand-set fields. A skill that creates an issue leaves them at the Jira default or empty.

## The ticket body

`/to-tickets` writes each ticket as a Task. Its parent is the Epic.

- **Goal.** One sentence from the user's side, with half a sentence on why.
- **Stories.** The spec's story group and the story IDs this ticket delivers.
- **What the user sees.** Plain checks, one line each. Acceptance uses these.
- **Technical checks.** Schema, routes, events, tests. For the agent.
- **Spec.** The spec's repo path as text, and the sections used.
- **ADRs.** The files this work has to obey.
- **Not in this ticket.** What a reader might assume is included and is not.

A blocking edge is Jira's native "Blocks" link. It is never text in the body.
A ticket does not copy the spec. It names the spec section that holds the values and the lists.

## Keys in git

The key format is `<KEY>-<n>`. In a commit message or a pull request title, the key is the scope: `feat(<KEY>-5): add login`. The key keeps its own case.
The branch format is `<type>/<KEY>-<n>-<slug>`.
Every branch, commit and pull request for a ticket carries its key. Jira does not act on `Closes <KEY>-14`.

## Labels

Tickets carry no readiness labels. Apply none.

## When a skill says "publish to the issue tracker"

Create a Jira issue with the fields and the body above. `/to-spec` creates the Epic, and `/to-tickets` creates the Tasks under it.

## When a skill says "fetch the relevant ticket"

Read the Jira issue by its key. The user passes the key.
Pass `view: "evidence"` to a JQL search when you need descriptions or links. The default view leaves them out.
