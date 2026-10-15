---
name: to-tickets
description: Break a spec into a set of tracer-bullet Jira tickets under its Epic, each naming the story IDs it delivers and declaring its blocking edges as native Jira links.
disable-model-invocation: true
---

# To Tickets

Break a spec into a set of **tickets**: tracer-bullet vertical slices, each declaring the tickets that **block** it.

The tickets are Jira Tasks under the feature's Epic. Read `docs/agents/issue-tracker.md` for the project, the board fields and the ticket body. Read `docs/agents/domain.md` for the spec folder, and `docs/agents/testing.md` for the acceptance suite. If one of these files is missing, tell the user to run `/setup-repo`. Where `docs/agents/issue-tracker.md` differs from this skill, the file wins.

## Process

### 1. Gather context

Work from the spec, the file `/to-spec` wrote. If the user passes a spec path or an Epic key, use it. Otherwise find the spec in the conversation. Read the whole spec, and read the Epic and its comments through the Atlassian connector. The Epic holds the PRD, so do not edit it.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Ticket titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the work into **tracer bullet** tickets.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests): vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first

</vertical-slice-rules>

Give each ticket its **blocking edges**: the other tickets that must complete before it can start. A ticket with no blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change (rename a column, retype a shared symbol) whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch. When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket; green is promised only there.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each ticket, show:

- **Title**: a plain outcome, for example "Answer a question on the Product page"
- **Stories**: the spec's story group and the story IDs this ticket delivers
- **Blocked by**: which other tickets (if any) must complete first
- **What it delivers**: the end-to-end behaviour this ticket makes work

Then check every story ID of the spec against the list. Flag each story that no ticket delivers, and ask whether a new ticket, an existing ticket or Out of Scope takes it. Do not continue while a story has no home.

Check each "What the user sees" line against the seed. Flag each line that the seed cannot show, and add the seed change to the ticket that holds the line.

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct: does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?

Iterate until the user approves the breakdown.

### 5. Publish the tickets to Jira

Publish the approved tickets through the Atlassian connector, one Jira Task per ticket, with the Epic as its parent. Publish in dependency order (blockers first) so each ticket's blocking edges can reference real keys. Write each blocking edge as Jira's native "Blocks" link and nowhere else: no "Blocked by" line in the body. Leave priority at the Jira default and leave the other board fields empty, as `docs/agents/issue-tracker.md` says.

Work the **frontier**: any ticket whose blockers are all done. For a purely linear chain that means top to bottom.

Do NOT close or modify the Epic.

<ticket-template>

Title: a plain outcome, for example "Answer a question on the Product page"

**Goal.** One sentence from the user's side, with half a sentence on why.

**Stories.** The spec's story group and the IDs this ticket delivers.

**What the user sees.** Plain checks, one line each. Each line becomes one acceptance test whose title is the line, as `docs/agents/testing.md` gives, so write a line that a tap-through of the seeded stack can show.

**Technical checks.** Schema, routes, events, tests. For the agent. Name a stubbed test only for a state that the real stack cannot show.

**Spec.** A link, and the sections used.

**ADRs.** The files this work has to obey.

**Not in this ticket.** What a reader might assume is included and is not.

</ticket-template>

Avoid specific file paths or code snippets: they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.
