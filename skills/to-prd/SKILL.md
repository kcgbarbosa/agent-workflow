---
name: to-prd
description: "Write the PRD into the Jira Epic description from the spec, the metrics file, the personas file, and the README users table."
disable-model-invocation: true
---

# To PRD

Write the **PRD** of one feature: a product requirements document that a person reads, polished enough for a portfolio. It is the description of the feature's Jira Epic. The spec stays the agent-facing source of truth; the PRD is generated from it and never edited by hand.

Do NOT interview the user. Synthesize from the sources below, show the draft, and wait for approval.

## Process

### 1. Find the sources

Read `docs/agents/issue-tracker.md`. It names the Epic rule, the paths of the metrics file and the personas file, and the Confluence space that archives specs. When it names no path, use `docs/product/metrics.md` and `docs/product/personas.md`. `/setup-repo` writes it. If it is missing, tell the user to run `/setup-repo`.

Read `docs/agents/domain.md` for the spec folder. Then collect:

- The Epic key, from the user or the conversation. Read the Epic through the Atlassian connector: its current description, its sprint or due date.
- The spec of the feature, the file `/to-spec` wrote.
- The metrics file and the personas file in this repo.
- The Users table in the project `README.md`.

If the spec, the Epic, the metrics file, or the personas file cannot be read, stop and tell the user which one.

### 2. Draft the PRD

Write plain professional prose, as a product manager would. The PRD is exempt from any simplified-English rule that the repo's other documents follow. The no-em-dash rule and `unslop` still apply. Use the template below.

<prd-rules>

- The PRD body holds no ADR number, no ticket key and no story ID.
- The PRD body holds no name or title of a real person. Persona names are fictional. The one exception is the Owner line, which takes the owner given in `docs/agents/issue-tracker.md`.
- Success numbers come only from the metrics file. Each goal copies its baseline and target from one row. A feature with no row gets a named signal and no target. Keep the caveat that a figure carries, for example "estimate". End the goals with one line that names the baseline source.
- Scenario names equal the spec's story group names.
- Take the Target from the Epic's sprint or due date. When the Epic has none, write "Target: not set".
- Write Rollout only for a feature that ships after go-live. The spec's Further Notes and the README say when go-live is. When they do not say, leave Rollout out and tell the user.
- Leave out Decisions and open questions when it is empty. Every other section stays.

</prd-rules>

<prd-template>

Title: <Feature name>
Owner: <name>. Target: <sprint or date>.

**TL;DR.** One sentence: what changes for the user and why it matters.

**Problem.** Who has it, what it costs them or us, and why now. What we are not solving.

**Who it's for.** The key persona first, then the others, one line each. Take them from the personas file. Match each to a Role in the README Users table.

**Approach.** A short paragraph. Enough to picture the solution, not to build it.

**Goals and success.** Two to four outcomes. Each has the baseline, the target, how it is measured, and why it matters.

**How it works.** Two or three short scenarios, each a person doing a real task start to finish.

**Scope.**

- In: one line per story group, tagged Must, Should or Later, with why.
- Not included: each item with the reason and where it goes later.

**Decisions and open questions.** Each decision: what was chosen, why, what was given up. Each open question: who answers it and by when.

**Dependencies and rollout.** Dependencies always apply. Write the rollout only for a feature that ships after go-live.

**Acceptance.** What can be checked on the deployed result, one line each, in user terms.

**Spec.** A link to the spec file on the default branch, built from the git remote. When the Epic has merged and the spec is archived, link the Confluence page that `docs/agents/issue-tracker.md` names.

</prd-template>

### 3. Check the draft

Before you show it, check every line of the draft against the rules:

- Each number traces to a row of the metrics file. Remove any that does not.
- Each persona is in the personas file. Each scenario name is a story group name of the spec.
- No ADR number, ticket key, story ID, or em dash remains, and no real name remains except the Owner line.

### 4. Show the draft and wait

Show the user the full draft, then a short note on anything you left out or could not fill: no metrics row, no target date, no rollout. Wait for approval. Do NOT write to Jira before the user approves. If the user asks for changes, redraft and show it again.

### 5. Write the Epic description

After approval, replace the whole description of the Epic with the approved text, through the Atlassian connector. Leave the Epic's title field, status, priority and links as they are.

A re-run overwrites the whole description. That is why nobody edits it by hand: a change to the PRD goes into the spec or the metrics file, and `/to-prd` runs again.

Tell the user the Epic link. The next step is `/to-tickets`.
