---
name: to-spec
description: "Turn the current conversation into a spec file in the project repo: no interview, just synthesis of what you've already discussed."
disable-model-invocation: true
---

This skill takes the current conversation context and codebase understanding and writes a **spec**: the agent-facing requirements of one feature. The spec is the source of truth for the build, the tests and the tickets. Do NOT interview the user; just synthesize what you already know.

The spec is a file in the project repo. Read `docs/agents/domain.md` for its folder; the default is `docs/product/specs/<feature>.md`. Read `docs/agents/issue-tracker.md` for the Epic, and `docs/agents/testing.md` for the acceptance suite. If one of these files is missing, tell the user to run `/setup-repo`.

The spec is not the PRD. `/to-prd` writes the PRD into the Epic description, and `/to-tickets` writes the tickets. This skill publishes nothing to the issue tracker.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the spec, and respect any ADRs in the area you're touching.

2. Sketch out the seams at which you're going to test the feature. The acceptance suite of `docs/agents/testing.md` is the first seam: each story that a user can see is tested there, on the real stack. Use a lower seam only for what it cannot reach, such as a rule matrix or an error state. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better - the ideal number is one.

Check with the user that these seams match their expectations.

3. Write the spec to its file using the template below. When the file exists, update it in place. Take the Epic link from the user or the conversation; when there is none, write `Epic: none yet` and say so in your reply.

4. Tell the user the path of the file. The next steps are `/to-prd`, then `/to-tickets`.

<spec-template>

# <Feature name>

Epic: <Jira link>. Key persona: <Role>. ADRs: <numbers>. One line on what this file holds.

## Problem Statement

The real-world problem that the user is facing, from the user's perspective. No project status. Status goes in Further Notes.

## Solution

The solution to the problem, from the user's perspective. Short. Implementation Decisions holds the mechanism.

## User Stories

Group the stories under plain capability headings. Tag each group Must, Should or Later.
Number the stories straight through the whole list (US-1, US-2, ...). Never restart the count in a group.
The last group, "Behind the scenes", holds the stories whose actor is the maintainer or the system.

Each story is in the format:

US-1. As a <Role>, I want <one observable behaviour>, so that <benefit>

<user-story-example>
US-1. As a mobile bank customer, I want to see the balance of each account, so that I can make better informed decisions about my spending
</user-story-example>

Every story is one behaviour that a test can pass or fail. This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema, rules, API contracts, screens and status screens
- Seed data: what each acceptance test needs to show its story, such as three rows for a list of three
- Specific interactions

Do NOT include an "Order of the work": `/to-tickets` derives it.

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- The seams, and the tools
- Prior art for the tests (i.e. similar types of tests in the codebase)
- A test table. Each row names a test and cites the story IDs it covers. A row does not restate a rule. A story that a user can see has an acceptance test row.

## Out of Scope

A list of the things that are out of scope for this spec. Each item has its reason and the ticket that picks it up, or "none planned". Mark each item user-visible or technical.

## Further Notes

Dependencies, release holds, go-live checks, and the current state of the project.

</spec-template>
