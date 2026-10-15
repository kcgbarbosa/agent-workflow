---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Read `docs/agents/testing.md`. For each "What the user sees" line, write its acceptance test first, then build until it passes. Use /tdd where possible, at pre-agreed seams.

Before you finish, run the ticket's acceptance tests. When the diff touches the UI, run the UI review skill that the file names, unless the spec says that another session runs it.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work, unless the spec says that another session reviews it.

Commit your work to the current branch.
