---
name: interrogate
description: 'Use for "interrogate", "adversarial review", "challenge this", "stress test this code", "find blind spots", or "tear this apart". Adversaries try to break a change or design, and only findings proven by a run survive.'
disable-model-invocation: true
---

# Interrogate

Adversaries try to break a change or a design. A finding survives only when a run proves it. Report the findings. Do not apply fixes.

## Frame

The scope is what the user names. Otherwise it is the branch diff from its merge base with the base branch, through the working tree. State the intent in your own words, from the user's message, the commits, and the pull request description. Ask the user when the intent is unclear and someone can answer; otherwise state the reading you chose and go on.

## Fan out

Spawn the adversaries with the Agent tool, three unless the user names a count, all in one message so they run at once. Give each a different angle of attack, such as the inputs, the state and its order, and the edges the intent names. Give each adversary the scope, the intent, its angle, and this brief:

> Break this change. Prove each finding with a run against the real code, such as a failing test, a repro script, or command output that shows the wrong behavior. For a design or plan, run a prototype or probe the current tree. Write each repro as a test file under a name of your own, so no other adversary's file collides with it. Report each finding with a title, the exact command, the output it printed, the output the intent requires, and the path of the repro. Leave out anything you did not run. That covers style, naming, structure, and risks that need a future change to matter. No findings is a valid result.

The adversaries share the working tree and any running stack. Tell them not to stop or reset what another one may be using.

## Verify

Verify each finding by rerunning its command yourself. Keep a finding when the output shows the failure and the failure breaks the intent. Drop the rest. Merge findings that share a root cause. Adversaries find different failures, so the verdict keeps every verified finding, not one adversary's list.

## Output

- **Intent**: the restatement.
- **Findings**: for each verified finding, the command, its output, how it breaks the intent, the path of its repro, and the adversaries that found it. Say "no verified findings" when none survive.
- **Dropped**: for each adversary, the count of dropped findings and why.

Carried from pstack, `pstack/skills/interrogate` of `cursor/plugins` at `ae5650febf4320793844c12c4adaa937f417f8da`, under the MIT license in `licenses/pstack.LICENSE`. The fan-out spawns adversaries with Claude Code's Agent tool in place of pstack's `arena` worktrees, so they share one stack.
