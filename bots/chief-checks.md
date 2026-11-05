# Checks of the Chief

The owner runs these by hand, because no test can reach Grokbot. Send each message in the Chief's chat, unless a check says otherwise. `chief.md` holds the rules these test.

A fail in a read check means a connector cannot do it. Note what the Chief said, and fix the connector or the rule that depends on it.

## Read checks

These change nothing, so run them any time. The pull requests are merged, so the answers stay the same. A job's log expires, so when that check stops working, ask about a newer pull request.

| What it proves                                | Send                                                                                                                                                                                                | Pass                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| It reads fuzz reviews, and takes the newest   | Read only. On kcgbarbosa/pitchridge pull request 248, read the newest review whose body starts with `<!-- gate fuzz head=`. Reply with its head commit and the titles under its `### New findings`. | Head `0f9bd3b`, and two findings that start "check-docs skips". Head `bbb59eb` is a fail.               |
| It reads a job's log                          | Read only. On kcgbarbosa/pitchridge pull request 248, open the log of the latest `gate / fuzz` job. Quote its line that says how many findings are new.                                             | A quote that says `2 new, 0 pre-existing`.                                                              |
| It knows a skipped check is no failure        | Read only. Would a brief say anything about fuzz for kcgbarbosa/pitchridge pull request 252? Say why.                                                                                               | No: the check was skipped, because the pull request is docs-only.                                       |
| It reads earlier briefs from the DM's history | Read only. Read the history of my self-DM, and list the last two morning briefs with their dates.                                                                                                   | The two latest briefs, and their dates match Slack.                                                     |
| The brief's fuzz part works                   | Dry run of the morning brief's fuzz part, since the last brief. Post nothing, and create nothing. Reply here.                                                                                       | Each line names a finding and links its pull request, or it says the part is empty, or `fuzz: UNKNOWN`. |

## Dry runs of a yes

| What it proves             | Send                                                                                                                                                                                     | Pass                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A yes gives the right Bug  | Dry run. Create nothing. Say I said yes to the first finding on kcgbarbosa/pitchridge pull request 248. Give the Bug's project, component, label, and status, and its Reproduce section. | PITCH, `pitchridge`, `fuzz`, To Do, and the command and the output as text. |
| A bare yes gets a question | Dry run. Create nothing. Say two findings are open and I reply only "yes". What do you do?                                                                                               | It asks which one.                                                          |

## The test ticket

These write one ticket in AW and close it, in this order. The ticket has no component, so the runner cannot see it, even in To Do.

1. **It writes an idea.** Send: `Make a ticket in AW from this idea: test of the Chief, delete me.` Pass: an AW Task in Awaiting Approval, with the label `idea`, no component, and those words as its body. Its key is `<KEY>` below.
2. **It refuses to start an idea.** Send: `go on <KEY>`. Pass: it says the ticket needs a grill, and the status does not change.
3. **It takes a stop in its chat.** Move `<KEY>` to To Do by hand in Jira. Send: `stop <KEY>`. Pass: the ticket is back in Awaiting Approval. This tests the Chief's part only. `runner/tests/` holds what the runner does next.
4. **A message in the DM does nothing.** Move `<KEY>` to To Do by hand again. Send `stop <KEY>` in your Slack self-DM. Wait 15 minutes. Pass: the ticket stays in To Do. If it moves, the Chief does see the DM, and the rule in `chief.md` can change.
5. **It closes the ticket.** Send: `Close <KEY>, it was a test.` Pass: Done, with the label `wont-do` and a comment that gives the reason.
