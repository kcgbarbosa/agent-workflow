# The watch page on the TypeScript loop

Epic: [AW-16](https://kcgbarbosa.atlassian.net/browse/AW-16). Key persona: KC, the maintainer of every repo, who checks the loop from the phone. ADRs: none in this repo. This file holds the requirements for the watch page of the TypeScript loop: what needs KC, the pull request steps the page skips today, the outcome of a ticket, and a shorter usage view.

## Problem Statement

KC checks the loop from the phone, often, to answer one question: does anything need me? The watch page does not answer it. A pull request held by the hold label, checks that timed out, or a pull request that did not merge sit in the ticket list beside the tickets that are fine, and KC has to open each one to find them.

The shared merge gate gave the loop new steps, and the page skips some of them. A held pull request shows no checks state. A pull request whose auto-merge did not turn on, a retarget, and a worktree the loop failed to remove show nowhere. Each check names its bucket, with no way to open its run on GitHub.

When a ticket ends, the page shows the agent's raw output, long and terminal-like, when KC wants three lines: did it pass, why, and what did the agent decide. The usage view shows about a dozen figures when KC wants two things: how much of the plan the loop uses, and whether that is typical.

## Solution

Overview opens with a strip of what needs KC, each row linking to its pull request or ticket. When nothing does, the strip says so in one line. A held pull request reads Held, an auto-merge that did not turn on shows on its ticket, and each check opens its run on GitHub. The steps list shows retargets and worktree removals.

The ticket view opens with the ticket's outcome: the result, the agent's reason, and its decisions. The raw output is folded under it.

The usage view shows the two plan meter bars and one line: this run's share of the 5-hour window per merged ticket, and the typical share. The rest is folded under More.

The page still reads all of this from the decisions log, with no call to GitHub.

## User Stories

### What needs KC (Must)

US-1. As KC, I want Overview to open with a list of what needs me, so that one look at the phone tells me whether to act.
US-2. As KC, I want the list to say "Nothing needs you" when it is empty, so that I know the page did not fail to load.
US-3. As KC, I want a pull request held by the hold label in the list, with the reason the loop logged, so that I know the run waits on me.
US-4. As KC, I want a stuck ticket in the list, with its stuck reason, so that I see it without opening the ticket.
US-5. As KC, I want a ticket whose checks timed out in the list, so that I know its pull request waits with no agent on it.
US-6. As KC, I want a ticket whose pull request did not merge in the list, so that I merge it or find why.
US-7. As KC, I want a run whose process is gone before it finished in the list, so that I restart it.
US-8. As KC, I want each row to link to its pull request, or to the ticket view when the ticket has none, so that one tap takes me where I act.
US-9. As KC, I want a row to leave the list once its state clears, such as the hold label removed or the pull request merged, so that the list holds only what still needs me.
US-10. As KC, I want each run on the home page to show how many things need me, so that I pick the run to open.

### Pull requests and checks (Must)

US-11. As KC, I want a held pull request to show Held as its checks state, so that I tell it apart from pending checks.
US-12. As KC, I want a ticket whose auto-merge did not turn on to show it, with the reason, so that I know the loop merges it itself.
US-13. As KC, I want each check's name to open that check's run on GitHub, so that I read a red check from the phone.
US-14. As KC, I want a check logged with no link to show its name with no link, so that a log written before this change still shows.
US-15. As KC, I want the steps list to show each retarget, ok or failed, so that I see when a stacked pull request moved to main.
US-16. As KC, I want the steps list to show each worktree removal, and a failed one as a warning with its message, so that I clean up by hand only when it failed.

### The outcome of a ticket (Must)

US-17. As KC, I want the ticket view to open with the ticket's outcome: the result of its latest build, the agent's reason, and its decisions, so that I read in three lines what happened.
US-18. As KC, I want a blocked ticket's outcome to show why the agent was blocked, so that I unblock it.
US-19. As KC, I want each decision of the agent on its own line, so that I answer each one.
US-20. As KC, I want the agent's raw output folded under the outcome and opened on a tap, so that it is there when I need it and out of the way when I don't.
US-21. As KC, I want a ticket with no finished build to show no outcome, so that I am not shown an empty one.

### Usage (Must)

US-22. As KC, I want the usage view to open with the two plan meter bars, so that I see how much of each window is used.
US-23. As KC, I want one line under them with this run's share of the 5-hour window per merged ticket and the typical share, so that I know whether the loop uses the plan as it normally does.
US-24. As KC, I want the typical share to be the median of the project's last 5 runs before this one, so that one odd run does not move it.
US-25. As KC, I want the line in the warn colour when this run's share is above 1.5 times the typical share, so that an expensive run stands out.
US-26. As KC, I want the line to say there is no typical share yet when no earlier run merged a ticket under a meter reading, so that a new project shows no made-up figure.
US-27. As KC, I want the delivery figures, the comparison with the run before, and the capacity forecast under one More fold, closed when the view opens, so that the view stays short.

### Behind the scenes (Must)

US-28. As KC, I want the loop's wait line to keep each check's link, so that the page links checks with no call to GitHub.
US-29. As KC, I want the loop's passing build line to keep the agent's reason, as a failed or blocked one does, so that every outcome has a reason.
US-30. As KC, I want the page to work out what needs me, the outcome, and the typical share on the server, so that the tests check them and the page only draws them.
US-31. As KC, I want the page to read all of this from the decisions log, with no call to GitHub, so that it works with no network.

## Implementation Decisions

### The log

- Each check in a `wait` line, `held`, `green`, `red` or `timeout`, gains `link`, the check run's URL. The loop reads it from `gh pr checks` already and drops it when it writes the line.
- A `build` `pass` line gains `detail`, the agent's `reason`, as `fail` and `blocked` already carry.
- Rule 11 of the loop's design, in `setup-loop`, names both, in the same pull request as the loop change.
- A reader treats a missing `link` or a missing `detail` as absent. Old logs stay valid.

### The epic view

The server works out each state, and the page draws it. The epic view gains:

- `needs_kc`: a list of rows, each with `kind`, `ticket`, `reason`, and `pr` (a URL, or null). The kinds, in display order:

  | Kind      | When                                                                                  | Reason from               |
  | --------- | ------------------------------------------------------------------------------------- | ------------------------- |
  | `stopped` | The run's process is gone with no `finish` or `stop` line. `ticket` is the run's name | The run's stop reason     |
  | `held`    | The ticket's latest `wait` line after its latest push is `held`                       | That line's `detail`      |
  | `stuck`   | The ticket is in the stuck column                                                     | Its stuck reason          |
  | `timeout` | The ticket's latest `wait` line is `timeout` and it has not merged                    | That line's `detail`      |
  | `merge`   | The ticket's latest `merge` line is `fail` and it has not merged since                | That line's `detail`      |

- Each ticket gains `auto_merge`: null, or the `detail` of an `auto-merge` `fail` line after the ticket's latest `pr` `open` line. It is information, not a needs-KC row, since the loop merges that pull request itself on green.
- Each ticket gains `outcome`: null until a `build` line ends in `pass`, `fail` or `blocked`. Then `result`, `reason` (that line's `detail`), and `decisions` (from the ticket's latest `pr` `open` line, else empty).
- A pull request's `result` can be `held`. Each check carries `link` when the log has one.
- The home view gains `needs_kc`, the count of rows, per run.

### The steps list

Diagnostics' steps list shows `retarget` and `worktree` lines. A `worktree` `fail` and a `retarget` `fail` show as warnings with their `detail`.

### The usage view

- The plan view gains `typical`: the median of `per_merged.five_hour` over the project's last 5 runs before this one that have it, or null when none has. A run without the figure is skipped, not counted as zero.
- The line reads "This run: X% of the 5-hour window per merged ticket. Typical: Y%." With no typical share: "No typical share yet." It is warn when X is above 1.5 times Y.
- The two meter bars stay as they are. The run figures, the delivery figures, "Against the run before", and the capacity forecast move into one closed `<details>` named More. The forecast keeps loading only when More opens.

### The page

- Overview's first panel is the needs-KC list, above the metrics, on every width.
- The ticket view's first panel is the outcome, above the facts. The agent output it replaces as the first thing shown stays in the Agents tab, folded.
- No new route. The page draws only what the views give it.

### Seed data

- A run whose log has one ticket of each needs-KC kind, one ticket held and then released, one merged ticket whose auto-merge failed, and one ticket with no build yet.
- Six earlier runs of the project with `per_merged.five_hour` values, so the median takes the last 5 and skips the oldest, plus one earlier run with no value.

## Testing Decisions

- A good test drives the loop or writes a log, then reads the page's JSON. It asserts what KC would see, never how the server finds it.
- One seam: the watch page's JSON API, in the loop's Vitest suite, with the World fakes for gh, Jira and claude. A log change is proven through a real run under the fakes, then read through the page, as the test of each pull request and its checks does now.
- The HTML is not tested. It has no logic of its own to test. Review opens the page at phone width and checks each panel.
- Prior art: the watch tests that run a real run and read `/api/epic`, and the report test that compares two runs.

| Test                                                                                                          | Stories                       |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| A real run's wait lines carry each check's link, and the page gives it                                         | US-13, US-28, US-31           |
| A log with checks that have no link shows them with none                                                       | US-14                         |
| A log with one ticket of each kind gives the needs-KC rows in order, each with its reason and its link         | US-1, US-3 to US-8, US-30     |
| A run with nothing to act on gives an empty needs-KC list                                                      | US-2                          |
| A held pull request released by a later wait leaves the list, and a merged one leaves it                       | US-9                          |
| The home view counts the needs-KC rows of each run                                                             | US-10                         |
| A held pull request's result is held                                                                           | US-11                         |
| A ticket whose auto-merge failed carries its reason, and merges                                                | US-12                         |
| The steps list holds retarget and worktree lines, and a failed one is a warning                                | US-15, US-16                  |
| A real run's passing build line carries the agent's reason, and the outcome gives it with the decisions        | US-17, US-19, US-29           |
| A blocked ticket's outcome gives the agent's reason                                                            | US-18                         |
| A ticket with no finished build has no outcome                                                                 | US-21                         |
| The typical share is the median of the last 5 earlier runs that have one                                       | US-23, US-24                  |
| A run above 1.5 times the typical share is marked warn                                                         | US-25                         |
| A project with no earlier figure has no typical share                                                          | US-26                         |
| Review at phone width: the needs-KC list first, the outcome first, the raw output folded, More closed          | US-1, US-20, US-22, US-27     |

## Out of Scope

- Screenshots on the watch page. User-visible. KC reviews them on GitHub, in the judge's comments on the pull request. None planned.
- Copying or linking T3 Code's views. User-visible. T3 Code shows KC's own threads, and the page shows the loop's runs. Revisit if the loop runs through `t3 thread start`. None planned.
- Changes to the Python watch page that runs on the T14 until the TypeScript loop cutover. Technical. It retires at the cutover. None planned.
- Masking secrets read from `bws run` and not the secrets file. Technical. AW-8 owns it, as US-33 and US-36 of the tooling spec.
- A separate mobile pass. User-visible. The page already has a phone layout. None planned.
- Browser tests of the HTML. Technical. The server holds the logic. None planned.

## Further Notes

- No blocker link to AW-7, the TypeScript loop cutover. The Epic runs on whichever loop is live.
- The Python loop and its watch page keep running PITCH-187 on the T14 until the cutover, so this page goes live then.
- The decisions behind this spec are in the Decision log of the hybrid setup doc, thread "Watch page".
