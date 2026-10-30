---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Read `docs/agents/testing.md`. For each "What the user sees" line, write its acceptance test first, then build until it passes. Use /tdd where possible, at pre-agreed seams.

Run typechecking and single test files regularly. Before you finish, run the tests that cover your change.

Commit your work to the current branch, then stop. Never run the merge gate, push, or open the pull request: the loop or the person who runs you pushes and opens it, and the gate runs every check, the code review, and the UI review on it.
