---
name: to-bug
description: Write a Jira Bug from a report, such as a Sentry issue, a Slack message, a red nightly run, or a fuzz finding the owner approved in the DM, with a Reproduce section and the correct behaviour as "What the user sees" lines, To Do so the runner starts it on its next tick. Use for /to-bug.
---

# To Bug

Turn one report into one **Bug** that a T3 thread can reproduce. The agent that builds it has no Sentry connector and no Slack, so everything it needs goes in the ticket as text.

Read `docs/agents/issue-tracker.md` for the project, the fields, and the ticket body.

## Process

### 1. Read the report

The report is a Sentry issue, a Slack message, a red nightly run, or a fuzz finding the owner approved in the DM. A fuzz finding with no yes from the owner is no report. Read all of it: for Sentry, the stack trace, the breadcrumbs, the environment, the release, and the user's role; for Slack, the whole thread; for a nightly run, the failed job's log; for a fuzz finding, its section of the review: the command, the output, and the reproduction.

### 2. Find a duplicate

Search the tracker for an open ticket of the same failure. When one exists, comment the report's link on it and stop. One report never becomes more than one ticket.

### 3. Write the Bug

Its body is the ticket body of the issue tracker doc, with a **Reproduce** section before "What the user sees":

- **Goal.** One sentence from the user's side.
- **Reproduce.** The steps, the environment, and the role, then the stack trace and the breadcrumbs pasted in as text, in code blocks. No link stands in for them.
- **What the user sees.** Each line states the correct behaviour, not the bug. The first line is the one the reproduction fails: the agent writes its acceptance test first, and sees it fail twice.
- **Technical checks.** Only what the report shows.
- **Not in this ticket.** What a reader might assume is included.

### 4. Create it

Create a Jira issue of type Bug, with no parent. Priority stays at the default. Then, in this order:

1. Set the component to the repo the bug is in, by an edit right after the create, since the create screen has none. In the same edit, give a Bug from a fuzz finding the label `fuzz`.
2. Move it from Awaiting Approval to To Do, after the component, so the runner of that repo starts it on its next tick.
3. Comment `Proposed by intake` with the link of the report.

Done when the Bug has no parent, the Reproduce section holds the trace as text, the component is set, a Bug from a fuzz finding has the label `fuzz`, it is To Do and not Flagged, and the comment names the report. Reply with the ticket's link.
