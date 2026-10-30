---
name: check-loop
description: Give a short status of the running loop, and say whether anything needs KC.
disable-model-invocation: true
---

# Check loop

KC wants a status of the loop that reads in ten seconds. KC has ADHD, so the reply is the [Report](#report) and nothing else. When KC names a worry in the arguments, such as "TIDE-52 looks slow", the report answers it first.

## 1. Refresh on the loop

The loop changes often. Read its current version before you judge a run:

- [`../setup-loop/loop.md`](../setup-loop/loop.md), the fixed design: what each step should do.
- `git -C ~/dev/agent-workflow fetch -q`, then `git -C ~/dev/agent-workflow log --oneline -10 -- loop skills/setup-loop` and `git -C ~/dev/agent-workflow status -sb`: the latest loop changes, and whether this checkout is behind origin.
- The repo's `loop.toml` and `docs/agents/loop.md`. The repo is the working directory of the run's unit, from `systemctl --user list-units 'loop-*'` and `systemctl --user show -p WorkingDirectory <unit>`. With no run unit, ask KC which repo.

Done when you can say what each step and limit of this run should be.

## 2. Read the run

One watch page serves every project on the host, so each `/api/` path below but `/api/usage` takes `?project=<name>`, the `name` of the repo's `loop.toml`. Without it, the page answers for the repo that started it.

The run's files are in `~/.local/state/<name>-loop/<run>/`, where the run is the key it started with, or `filter-<hash>`. The unit `loop-<name>-<run>` names the running run. With no unit, the run is the newest folder there.

- `systemctl --user is-active loop-<name>-<run>`: is the run alive?
- `curl -s 'localhost:8790/api/epic/<run>?project=<name>'`: the state, `stats`, `plan`, and each ticket's column, `step` with its `since`, its pull request and checks, and `recent` tool calls.
- The last 30 lines of `decisions.jsonl`, and `journalctl --user -u loop-<name>-<run> -n 30`. The `frontier` line lists each ticket with its state. A ticket's `pr` line gives its pull request and whether auto-merge is on, and each `wait` line gives the result and the `checks` the loop saw.
- For each ticket whose last `pr` line has no `merge` line after it, the pull request on GitHub, from the repo: `gh pr view <url> --json state,baseRefName,autoMergeRequest,mergeStateStatus` and `gh pr checks <url>`. GitHub is the truth when it and the log disagree.
- `loop report <run>`, run from the repo, when the cost looks off.

When the watch page does not answer, read the same facts from `decisions.jsonl`.

Done when you know each ticket's state, its pull request's state, and what the running ticket is doing right now.

## 3. Hunt trouble

Check every item. Each one that holds is a flag.

- **Dead**: the run's unit is gone, and `decisions.jsonl` ends without a `stop` or `finish` line.
- **Slow**: an agent past `agent_timeout_minutes`, a `wait` on checks past 120 minutes, or `recent` repeating the same tool call.
- **Stuck**: a stuck ticket, a `blocked` agent, red `wait` lines near `fix_attempts`, or stuck tickets in a row near `circuit_breaker`.
- **Gate**: a pull request whose checks are red with no fix running, that is green with auto-merge off, that GitHub reports conflicting or blocked, or that still targets a merged branch.
- **Denied**: a tool call that auto mode denied. `/api/agent/<run>/<ticket key>/<n>?project=<name>` marks each one `"denied": true`. Check the newest agent log of the running ticket.
- **Plan**: `five_hour.utilization` of `/api/usage`, the newest meter reading on the host, above 0.8, or `plan.fits.five_hour` at 0. The loop pauses at the limit and resumes at `resets_at` (rule 8).
- **Paused**: a ticket's `step.paused` is true.
- **Errors**: a stack trace in the unit's journal, a `fail` or `loop-error` line in `decisions.jsonl`, or an `agent-*.err` with content.
- **Drift**: the run does something the design from step 1 says it should not. Name the rule.
- **Stale loop**: the agent-workflow checkout is behind origin, so the next `loop start` takes new code.

For each flag, dig into the logs and the agent's own words until you can name the cause in one line. Done when every item is checked and every flag has a cause.

## 4. Judge each fix

For each flag, name the **proper fix**: the change at the root cause, made where that cause lives, as the codebase's own conventions would make it. A workaround that gets this one run moving is not the fix; leave it out of the report.

- A loop bug is fixed in `~/dev/agent-workflow`, where `loop/` and `skills/setup-loop/loop.md` change in one pull request.
- A wrong setting is fixed in the repo's `loop.toml` or `docs/agents/loop.md`.
- A fault in the ticket's work is fixed in the repo, on the ticket.

Then decide who makes the proper fix:

- **I can do it** when the fix is a change to code, config, or docs that you can make, test, and open as a pull request.
- **You're needed** when the fix needs something only KC holds: a product or scope decision, a spend, an account, a secret, an admin control such as identity-provider roles, or a merge.
- **No fix needed** when the loop handles it by design, such as a pause for the plan limit. Name the rule.

Done when every flag has its proper fix and a verdict.

## Report

Plain words, local times, durations in minutes. A blank line between every line, so each one stands alone. No headings, tables, or preamble.

```
🟡 TIDE-14 Tide alerts · running 49 min

✅ 2 merged · 🔄 1 running · ⏳ 2 waiting · 🛑 0 stuck

🔄 TIDE-52: waiting on its checks, 4 min in

⚠️ **TIDE-53 stuck**: auto mode denied `docker volume rm` on its own stack

🔧 Fix: the loop's agent settings allow removing a `tidepool-<key>` volume

👉 **I can do it**, as a loop PR in agent-workflow. Want me to?

⚠️ **5h plan at 83%**

👉 **No fix needed**: the loop pauses at the limit and resumes at 4:10 PM (rule 8)
```

- The first line's dot: 🟢 running clean, 🟡 running with a flag, 🔴 stopped, dead, or stuck, ✅ finished, with the Epic's archive pull request link when it has one.
- Each flag, worst first: ⚠️ what is wrong and its cause, 🔧 the proper fix in one line, 👉 the verdict. A **No fix needed** flag skips the 🔧 line.
- With **You're needed**, the 👉 line says what KC has to do or decide.
- A clean run ends with `👉 Nothing needs a fix.`
