---
name: to-prd
description: "Write the PRD into the Jira Epic description from the spec, the metrics file, the personas file, and the README users table."
disable-model-invocation: true
---

# To PRD

Write the **PRD** of one feature: a one-page brief that an executive reads in two minutes and comes away knowing what is being built, for whom, and why. It is the description of the feature's Jira Epic. The spec is the long, agent-facing source of truth that the tickets and the build follow; the PRD is a short summary generated from it and never edited by hand. Every detail the PRD leaves out stays in the spec, which the PRD links.

Do NOT interview the user. Synthesize from the sources below, show the draft, and wait for approval.

## Process

### 1. Find the sources

Read `docs/agents/issue-tracker.md`. `/setup-repo` writes it. If it is missing, tell the user to run `/setup-repo`. A repo has a PRD only when the file says "The Epic is the PRD." When it does not, stop: tell the user that this repo has no PRD, and that its Epic description is the Spec line `/to-spec` wrote. The file names the paths of the metrics file and the personas file. When it names no path, use `docs/product/metrics.md` and `docs/product/personas.md`.

Read `docs/agents/domain.md` for the spec folder. Then collect:

- The Epic key, from the user, the conversation, or the spec's Epic line. Read the Epic through the Atlassian connector: its current description, its sprint or due date.
- The spec of the feature, the file `/to-spec` wrote.
- The metrics file and the personas file in this repo.
- The Users table in the project `README.md`.

If the spec, the Epic, the metrics file, or the personas file cannot be read, stop and tell the user which one.

### 2. Draft the PRD

Write for an executive: plain business prose about people, outcomes, and trade-offs, at 500 words or fewer. Name what a person does and gains, and leave the mechanism to the spec: routes, fields, error codes, screen components, test data and vendor settings stay there. Name a vendor only by its role, such as "the sign-in provider". The PRD is exempt from any simplified-English rule that the repo's other documents follow. The no-em-dash rule and `unslop` still apply. Use the template below.

<prd-rules>

- The PRD body holds no ADR number, no ticket key and no story ID.
- The PRD body holds no name or title of a real person. Persona names are fictional. The one exception is the Owner line, which takes the owner given in `docs/agents/issue-tracker.md`.
- Success numbers come only from the metrics file. Each goal copies its baseline and target from one row. A feature with no row gets a named signal and no target. Keep the caveat that a figure carries, for example "estimate". End the goals with one line that names the baseline source.
- Scenario names equal story group names of the spec.
- Take the Target from the Epic's sprint or due date. When the Epic has none, write "Target: not set".
- Write Rollout only for a feature that ships after go-live. The spec's Further Notes and the README say when go-live is. When they do not say, leave Rollout out and tell the user.
- Leave out Open questions when none needs the owner or blocks the feature. Every other section stays.

</prd-rules>

<prd-template>

Title: <Feature name>
Owner: <name>. Target: <sprint or date>.

**TL;DR.** One sentence: what changes for the user and why it matters.

**Problem.** Two or three sentences: who has it, what it costs them or us, and why now. One sentence on what we are not solving.

**Who it's for.** The key persona first, then the others, one line each. Take them from the personas file. Match each to a Role in the README Users table.

**How it works.** Two short scenarios, each a person doing a real task start to finish in two or three sentences.

**Goals and success.** Two or three outcomes, one line each: the baseline, the target, and how it is measured.

**Scope.** One line for the Musts, one line for the Should and Later groups, and at most four items not included, each with where it goes later.

**Key decisions.** The two to four choices an executive would question, one line each: what was chosen and what was given up.

**Open questions.** One line each: the question, who answers it, and by when.

**Dependencies and rollout.** One or two lines. Write the rollout only for a feature that ships after go-live.

**Spec.** A link to the spec file on the default branch, built from the git remote. When the spec is no longer on the default branch, link it at the Epic's merge commit: `<remote>/blob/<sha>/<path>`. With the loop, the Archive spec button on the `loop watch` page deletes the spec in a pull request and makes this change: see Logs in [loop.md](../setup-loop/loop.md).

</prd-template>

### 3. Check the draft

Before you show it, check every line of the draft against the rules:

- The body, from the TL;DR to the Spec line, is 500 words or fewer. Count it, and cut detail into the spec until it fits.
- Each number traces to a row of the metrics file. Remove any that does not.
- Each persona is in the personas file. Each scenario name is a story group name of the spec.
- No ADR number, ticket key, story ID, em dash, route, field name or error code remains, and no real name remains except the Owner line.

### 4. Show the draft and wait

Show the user the full draft, then a short note on anything you left out or could not fill: no metrics row, no target date, no rollout. Wait for approval. Do NOT write to Jira before the user approves. If the user asks for changes, redraft and show it again.

### 5. Write the Epic description

After approval, replace the whole description of the Epic with the approved text, through the Atlassian connector. Leave the Epic's title field, status, priority and links as they are.

A re-run overwrites the whole description. That is why nobody edits it by hand: a change to the PRD goes into the spec or the metrics file, and `/to-prd` runs again.

Tell the user the Epic link. The next step is `/to-tickets`.
