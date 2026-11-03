---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Read `docs/agents/testing.md`. For each "What the user sees" line, write its acceptance test first, then build until it passes. Use /tdd where possible, at pre-agreed seams.

Run typechecking and single test files regularly. Before you finish, run the tests that cover your change.

Before you return, run the blast-radius skill on the branch diff. When the loop runs you, set `blast` in your output to the level it gives: `green`, `yellow`, or `red`. A person reads the writeup.

Commit your work to the current branch. When the loop runs you, with the path of its `ticket.md`, stop there: the loop pushes and opens the pull request. When a person runs you, push the branch and open the pull request, with its body written by /pr. Never run the merge gate yourself: it runs every check and the fuzz job on the pull request.
