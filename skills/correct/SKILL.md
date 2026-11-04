---
name: correct
description: "Find the mistakes agents keep repeating in this repo and make each one impossible. Try architecture first, then types, then a lint whose error names the fix, then a test, and write docs last. Prove each check fails on a real past mistake. The loop runs it once a day. Use for /correct."
disable-model-invocation: true
---

# Correct

The operator keeps correcting agents in this repo for the same mistakes. Change the repo so the next agent can't make them.

Assume every contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Design the repo so a change that looks right from one file is right for the whole repo.

## Find the mistake classes

First, read recent commits, reverts, review comments, agent instruction files, and comments that explain workarounds. When the loop runs you, its argument is a file that lists the commits and the reverts since the last correction, the fix attempts in the loop logs, and the pull requests with a red fuzz check, whose findings are in the fuzz comment. Group the mistakes into classes. A class counts once it has happened twice.

## Fix the most frequent class at the highest level that works

1. **Eliminate it with architecture.** Give each piece of state one owner and each task one supported way. Hide internals so the wrong import fails. Replace hand-synced lists with one source of truth. Delete old ways and dead code an agent would copy.
2. **Enforce it with types so the bad state can't be written.** If bad code still compiles, add a lint or CI check whose error names the file, type, or function to use instead. If the pattern is already common, fail only when a change adds more.
3. **Test the behavior.** Fix or delete any test that still passes when the behavior it checks breaks, or that fails when only the internals change.
4. **Write docs or agent rules last, only for judgment calls.** Nothing fails when an agent skips them.

## Fix and prove

Then fix the most frequent class now, in this run, and leave the others for the next one. Each run opens at most one pull request. Prove each new check fails on a real past mistake. Run the same command locally and in CI. Exceptions go on the offending line with a reason, an expiry date, and a human's approval.

When no class has happened twice, change nothing. Commit on the current branch, and do not push: the loop pushes and opens the pull request, with your commit's subject as its title.

## Keep the rule table

Last, keep a table in the agent instruction file that pairs each rule with what enforces it. If the rule was already there and nothing enforces it, that's a repeat, so fix it at the highest level in the same change. Drop a rule once its mistake can't happen.

**Reply:** each class with its evidence, the level you picked, and why a higher level didn't work.

Carried from pstack, `pstack/skills/correct` of `cursor/plugins` at `ae5650febf4320793844c12c4adaa937f417f8da`, under the MIT license in `licenses/pstack.LICENSE`. It fixes one class a run where pstack fixes the most frequent classes one commit each, reads the file the loop gives it, and leaves the push and the pull request to the loop.
