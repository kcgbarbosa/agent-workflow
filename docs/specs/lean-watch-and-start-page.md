# A leaner watch page and start page

Epic: [AW-24](https://kcgbarbosa.atlassian.net/browse/AW-24). Key persona: KC, the maintainer of every repo, who checks the loop from the phone. ADRs: none in this repo. This file holds the requirements for a watch page that opens on a card per repo and one log, styled like the start page, and for a start page whose Loop tile is a dot.

## Problem Statement

KC opens the watch page to learn three things: what is running, what needs KC, and what just finished. Since a loop run builds only its own repo's tickets, runs go per repo, side by side. The watch page still opens on a list of Epics per project, a running-now figure and the plan meter cards, and a run's screen opens on tabs and pickers. KC reads past all of it to find the answer.

The plan meter got a large place on the page when one run could drain the plan. It no longer can, so the meter needs a line, not cards.

The watch page and the start page look like two products: the watch page has its own grey palette, a blue run colour and small radii, and the start page has a warm ground, an evergreen brand and large cards.

The start page's Loop tile reads only the first running run, so with runs in two repos it hides one. It also shows steps and a meter that the watch page already shows.

## Solution

The watch page opens on one card per repo. Each card says running, needs you, or idle, and what that means: the running tickets and their steps, the rows that need KC, or the last result. Under the cards is one live log of what the loop did, across every repo. The plan meter is one line in the header.

A card opens its repo's run. The run's Tickets, Diagnostics and Usage views and the Epic picker stay as they are, behind one menu button. The ticket detail keeps every tool call.

The watch page takes the start page's colours, fonts and cards, with a blue accent where the start page uses green, so the two read as one family and can be told apart at a glance.

The start page's Loop tile shows its name and a dot: amber when a repo needs KC, pulsing while a run runs. Media Lab and T3 Code are both green tiles.

## User Stories

### The look (Must)

US-1. As KC, I want the watch page in the start page's ground, surface, ok, warn and bad colours, so that the two pages read as one family.
US-2. As KC, I want the watch page in Geist and Geist Mono, with the start page's card radius and shadow, so that its cards look like the start page's tiles.
US-3. As KC, I want the watch page's accent in blue where the start page uses green, so that I tell the two pages apart at a glance.
US-4. As KC, I want green on the watch page only for what is ok, so that the accent never reads as a state.
US-5. As KC, I want the watch page light or dark as the system is set, as the start page is, so that the two match on each device.

### A card per repo (Must)

US-6. As KC, I want the watch page to open on one card for each project on the host, so that I see every repo at once.
US-7. As KC, I want each card to say one of running, needs you, or idle, with a dot in the matching colour, so that one look tells me where to act.
US-8. As KC, I want a card to say needs you when its current run has a row that needs me, even while the run runs, so that what needs me is never hidden behind running.
US-9. As KC, I want a card to say running while its current run runs or is paused for the usage limit, so that a paused run does not read as idle.
US-10. As KC, I want a running card to list each running ticket with its step and how long it has been in that step, so that I see a slow step without opening the run.
US-11. As KC, I want a running card to show the Epic's key and its tickets complete of the total as a track, so that I see how far the run is.
US-12. As KC, I want a card that needs me to list each row that needs me, with its reason and a link to its pull request, or to the ticket when it has none, so that one tap takes me where I act.
US-13. As KC, I want an idle card to show the last run's Epic, its status, and how long ago it ended, so that I know what just finished.
US-14. As KC, I want a project with no runs to show idle with no runs yet, so that a new repo still has its card.
US-15. As KC, I want a tap on a card to open that project's current run, the running one or else the newest, so that I reach the detail in one tap.
US-16. As KC, I want the header to show the 5-hour window's use and its reset time on one line, so that I still see the plan meter without it taking the page.
US-17. As KC, I want the running-now figure and the plan meter cards gone from the home screen, so that the cards come first.

### The log (Must)

US-18. As KC, I want one log under the cards, merged across every project, newest first, so that I see what the loop just did anywhere.
US-19. As KC, I want each log line to show its time, its project, its ticket, and what happened in a few words, so that a line reads at a glance.
US-20. As KC, I want the log to leave out plan meter readings and the loop's bookkeeping lines, so that it shows only steps of the work.
US-21. As KC, I want to filter the log to one project, with all projects shown by default, so that I follow one repo when I need to.
US-22. As KC, I want the log to hold the latest 50 lines, so that it stays short.
US-23. As KC, I want a log line with a ticket to open that ticket's detail, so that I go from what happened to why.
US-24. As KC, I want the log to update with the page's poll, so that it is live.

### A run behind a menu (Must)

US-25. As KC, I want a run's Tickets, Diagnostics and Usage views and its Epic picker behind one menu button in the header, so that they are there without being in the way.
US-26. As KC, I want each of those views to show what it shows today, so that nothing I use is lost.
US-27. As KC, I want a run to open on its Overview, so that a card leads to what needs me in that run first.
US-28. As KC, I want the project picker gone, so that I reach a project from its card.
US-29. As KC, I want an address from before this change to open the same run and view, so that a saved link still works.

### The ticket detail (Must)

US-30. As KC, I want the ticket detail to keep each session's tool calls, with each call that auto mode denied in red, so that I see what the agent did.

### The start page's Loop tile (Must)

US-31. As KC, I want the Loop tile to show its name and a dot only, with no ticket, steps, track or plan meter, so that the start page only tells me whether to open the watch page.
US-32. As KC, I want the dot amber when any project needs me, so that I know to open the watch page.
US-33. As KC, I want the dot to pulse when a run runs and no project needs me, so that I see work in progress.
US-34. As KC, I want the dot green when the watch page answers and nothing runs or needs me, so that I know all is quiet.
US-35. As KC, I want the dot red when the watch page does not answer, so that I know the page is down.
US-36. As KC, I want the Media Lab and T3 Code tiles both green, so that the two apps I open most stand out.

### Behind the scenes (Must)

US-37. As KC, I want the server to work out each card's state, its rows, its last result and the log, so that the tests check them and the page only draws them.
US-38. As KC, I want the cards and the log read from the decisions logs, with no call to GitHub, so that they work with no network.
US-39. As KC, I want the epic, usage, report and forecast routes unchanged, so that `/check-loop` and agents keep reading them.
US-40. As KC, I want the start page to take each project's state from the watch page, not work it out again, so that the two never disagree.
US-41. As KC, I want the copied style block in the watch page to name the start page file it came from, so that a later restyle finds both.

## Implementation Decisions

### The home view

`/api/home` keeps each project's `runs`, which the Epic picker reads, and each project gains:

- `state`: `running`, `needs_kc` or `idle`. `needs_kc` when the current run's epic view has any needs-KC row; else `running` when the current run's status is running or paused; else `idle`.
- `current`: the key of the running run, else of the newest, else null.
- `needs_kc`: the current run's needs-KC rows, each with `kind`, `ticket`, `reason` and `pr`, as the epic view gives them.
- `working`: each running ticket of the current run, with `key`, `step`, and `since`, the time of the line that began its step.
- `progress` and `epic`: the current run's complete and total, and its Epic key and summary.
- `last`: when idle, the current run's `key`, `status`, and `at`, the time of its last line. Null with no runs.

Only the current run counts. A blocked or stopped run older than it is history, and shows in the Epic picker, not on the card.

### The log

- A new route, `/api/log`, GET only like the rest. It answers the latest 50 lines across every run of every project, newest first. `?project=<name>` keeps one project's lines, as the other routes take it.
- Each line: `time`, `project`, `epic`, `ticket`, `step`, `result`, `detail`, and `pr` when the line names one.
- It leaves out the steps `meter`, `tracker-status`, `frontier`, `notify` and `agent`. Each other step is a line.
- The page turns `step` and `result` into words, as the steps list does today. The secret masking applies to `detail`.

### The page

- Home: the header line, the cards, then the log with a chip per project and All.
- The header line reads the 5-hour window from `/api/usage`: its use and its reset time.
- A card's dot uses the state colours: running in the accent with the pulse, needs you in warn, idle quiet.
- Inside a run, the header holds one menu button. It opens a list: Overview, Tickets, Diagnostics, Usage, then the Epic picker. The tab bar and the project picker go. The routes `#/<project>/<Epic>/<view or ticket>` do not change.
- No route is added to the page beyond `/api/log`, and no view is removed.

### The look

- The start page's `:root` block and its dark block are copied into the watch page, with a comment naming the machines file `dot_local/share/start/index.html` as the source. Its ground, surface, stage, text, muted, quiet, ok, warn, warn-ink and bad tokens, Geist and Geist Mono, the 24 to 30px card radius and the soft and lift shadows come with it.
- The brand token is the watch page's run blue, `#2856c8` light and `#6f97ff` dark, in place of evergreen. The page name, set large as the start page sets `t14`, the progress tracks, focus rings and links use it.
- The watch page's own tokens map onto the copied ones and then go, so one set of names remains.
- The start page's `.dot`, `.track` and `.issue` shapes are copied with the tokens.

### The start page

These change the TypeScript start page that AW-13 writes.

- The loop probe in `/api/status` reads `/api/home` and returns `up` and `state`: `needs_kc` when any project's state is `needs_kc`, else `running` when any is `running`, else `idle`. It no longer reads `/api/usage`.
- The Loop tile draws the dot from it: warn for `needs_kc`, pulse for `running`, ok for `idle`, bad when the probe fails. It has no fact, no live block, no track and no meter.
- The T3 Code tile, slot 1 from AW-13, takes the green class beside Media Lab.

### Seed data

- A host of four projects: one with a running run and two tickets in different steps; one whose running run has a held pull request; one whose newest run completed, with an older blocked run; and one with no runs.
- Logs across those projects with more than 50 work lines, plus `meter`, `tracker-status`, `frontier`, `notify` and `agent` lines that the log must leave out, and one line whose detail holds a secret.
- For the start page: a fake `/api/home` for each of needs KC, running, and idle, and no answer at all.

## Testing Decisions

- A good test writes a log or drives the loop under the fakes, then reads the JSON a page reads. It asserts what KC would see, never how the server finds it.
- Seam 1: the watch page's JSON API, in the loop's Vitest suite, with the World fakes for gh, Jira and claude. Prior art: the watch tests that read `/api/home` and `/api/epic`, such as the home view's count of needs-KC rows.
- Seam 2: the start page's `/api/status`, in the machines suite, run as a subprocess against a fake watch API. Prior art: the start page tests that AW-13 ports, which point each probe at a fake.
- The HTML is not tested. It has no logic of its own. Review opens both pages at phone width, light and dark, and checks each story the table marks review.

| Test                                                                                                          | Stories                   |
| ------------------------------------------------------------------------------------------------------------- | ------------------------- |
| The home view gives each project of the host, including one with no runs                                      | US-6, US-14               |
| A running run's project is running, with each ticket's step and when it began, and the Epic's progress        | US-9, US-10, US-11, US-37 |
| A project whose running run has a held pull request is needs KC, with the row, its reason and its link        | US-8, US-12               |
| A paused run's project is running                                                                             | US-9                      |
| A completed project is idle with its last run's key, status and time, and an older blocked run is not counted | US-13                     |
| The current run is the running one, else the newest                                                           | US-15                     |
| The log merges every project's lines newest first, at most 50                                                 | US-18, US-22, US-24       |
| The log leaves out meter, tracker-status, frontier, notify and agent lines                                    | US-20                     |
| The log filtered to one project holds only its lines                                                          | US-21                     |
| Each log line carries its time, project, Epic, ticket, step, result and link, with each secret masked         | US-19, US-23, US-38       |
| The epic, usage, report and forecast routes answer as before                                                  | US-26, US-39              |
| A host with a project that needs KC and one running gives a needs-KC Loop probe                               | US-32, US-40              |
| A host with a running project and none needing KC gives a running Loop probe                                  | US-33                     |
| A quiet host gives an idle Loop probe, and no answer gives a down one                                         | US-34, US-35              |
| Review, watch page: the colours, fonts, cards, blue accent, light and dark, style source comment              | US-1 to US-5, US-41       |
| Review, watch page: the cards, the header meter line, no running-now figure or meter cards                    | US-7, US-16, US-17        |
| Review, watch page: the menu, the views as before, Overview first, no project picker, an old address          | US-25 to US-29            |
| Review, watch page: the ticket detail's tool calls, denied ones red                                           | US-30                     |
| Review, start page: the Loop tile's name and dot only, Media Lab and T3 Code green                            | US-31, US-36              |

## Out of Scope

- A needs-you list on the start page. User-visible. KC chose the dot only. None planned.
- One style file both pages load. Technical. KC chose a copy, since two repos would need chezmoi to share a file. None planned.
- Screenshots on the watch page. User-visible. KC reviews them on GitHub, in the judge's comments. None planned.
- Copying or linking T3 Code's views from the watch page. User-visible. T3 Code shows KC's threads, the page shows the loop's runs. None planned.
- Tests of the HTML. Technical. Neither page has logic in its HTML. None planned.
- Removing the Sessions section and adding the T3 Code tile. User-visible. AW-13.

## Further Notes

- The start page changes land on the TypeScript start page, which AW-13 wrote. AW-13 is done.
- The home view keeps every field it has today, so the start page reads it before and after AW-26.
- The proposal and KC's decisions of 2026-10-31: [Loop watch and start page: a leaner pair](https://claude.ai/artifact/69SRGu9ZU48CJiy2B1BiJe).
