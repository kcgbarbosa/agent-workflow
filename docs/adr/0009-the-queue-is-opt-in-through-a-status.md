# The queue is opt-in through a status

A new issue starts as `Awaiting Approval`, the initial status of the Jira workflow, in the To Do category. The runner starts only a To Do ticket, so an idea or a stale ticket costs no build and no tokens until the owner moves it to To Do. Moving a ticket is the approval, and ADR-0006 gives how a build starts from there.

A ticket moved back to Awaiting Approval stops: the runner gives it no status, no message and no auto-merge, even with a thread or an open pull request. A turn already running finishes and holds its place until it does. A pull request that has merged still moves the ticket to Done.

A Bug that `/to-bug` writes is Flagged and moves to To Do, so unflagging stays the owner's one approval of it.

## Considered Options

- A filter on the active sprint. Rejected because approving a ticket would need a running sprint.
- A `ready` label. Rejected because a label is less visible than a board column.

## Amendments

- The status was named `Backlog`. Renamed because Jira's own backlog is a separate thing, so the name meant two things on one board.
