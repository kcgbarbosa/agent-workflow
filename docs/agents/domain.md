# Domain docs

How to read and write this repo's documents. The repo is single-context: one `GLOSSARY.md` at the root, one `docs/adr/`.

## Read these before exploring

- `GLOSSARY.md`, the domain glossary.
- `docs/adr/README.md`, the index. Then read only the ADRs that touch your area.

If one of these files does not exist, proceed. `/domain-modeling` creates them when a term or a decision is settled.

## Where a fact goes

Write it in one file only.

| What you have                                                | File                                       |
| ------------------------------------------------------------ | ------------------------------------------ |
| A decision that is hard to reverse and came from a trade-off | `docs/adr/`                                |
| A user, a constraint, a scope cut, or a go-live item         | `README.md`, in the Users table for a user |
| A term the project has settled on                            | `GLOSSARY.md`                              |
| How the agents work                                          | `AGENTS.md` and `docs/agents/`             |
| The spec of a feature whose Epic is not merged               | `docs/specs/<feature>.md`                  |

The Epic is not a file in this repo. `docs/agents/issue-tracker.md` gives what its description holds, and the metrics and personas files of a repo with a PRD.
When the Epic merges, a pull request deletes the spec. `docs/agents/issue-tracker.md` gives how the Epic links it after that. The tests hold its acceptance criteria.

## Keep documents accurate

A statement is wrong only when an agent that trusts it would make a wrong change. A general statement, or one that leaves something out, is not wrong. Do not edit it.
A pull request greps the documents for the names it touches, and fixes each statement it made false.

## ADRs

`docs/adr/` holds only current decisions, one file per decision.

- An ADR names another decision by number and never restates it.
- When a decision changes, edit the ADR in place to state the current decision. Add one line under `## Amendments`: the old decision and why it changed, so no agent proposes it again.
- When a decision is reversed or no longer applies, delete the ADR. The ADR that replaces it carries the Amendments line.
- A number belongs to one decision for the life of the repo, so the numbering has gaps.

## Use the glossary's vocabulary

When your output names a domain concept, use the term as `GLOSSARY.md` defines it.
This applies to issue titles, spec stories, refactor proposals, hypotheses, and test names.
Do not drift to a synonym the glossary lists under `_Avoid_`.

If a concept is missing from the glossary, one of two things is true.
Either you are inventing language the project does not use, or there is a real gap.
Check the first case first. Note the gap for `/domain-modeling` if the gap is real.

## Flag ADR conflicts

If your output contradicts an ADR, say so. Do not override it silently.

> Contradicts ADR-0007 (the decision's title). Worth reopening because...
