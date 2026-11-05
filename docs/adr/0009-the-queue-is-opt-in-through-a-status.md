# The queue is opt-in through a status

A new issue starts as `Awaiting Approval`, the initial status of the Jira workflow, in the To Do category. The runner starts only a To Do ticket, so an idea or a stale ticket costs no build and no tokens until the owner moves it to To Do. Moving a ticket is the approval, and ADR-0006 gives how a build starts from there.

A ticket moved back to Awaiting Approval stops: the runner gives it no status and no message, even with a thread or an open pull request, and it holds an open pull request back from merging. It turns auto-merge off, writes the pull request comment `Runner hold: Awaiting Approval`, and makes the pull request a draft, each after a read of GitHub, so a tick repeats nothing. A turn already running finishes and holds its place until it does. A pull request that has merged still moves the ticket to Done.

A ticket that leaves Awaiting Approval gets a draft with that comment marked ready and auto-merge on, and the comment `Runner hold released`. The latest of the two comments is how the runner knows its own draft, so a draft the agent or the owner made stays a draft (ADR-0004).

A Bug that `/to-bug` writes starts unflagged and moves to To Do, so it builds at the next tick. The Chief DMs the owner the key, and `stop <KEY>` in that DM moves the ticket to Awaiting Approval. The Bug the Chief files for a repeated stuck fingerprint is the exception: it is created Flagged, since it changes the runner itself.

## Considered Options

- A filter on the active sprint. Rejected because approving a ticket would need a running sprint.
- A `ready` label. Rejected because a label is less visible than a board column.

## Amendments

- A Bug that `/to-bug` wrote was Flagged, so unflagging was the owner's one approval, and a stop only withheld auto-merge. Changed because every fix waited on an unflag, and because auto-merge already on could still merge a stopped build.
- The status was named `Backlog`. Renamed because Jira's own backlog is a separate thing, so the name meant two things on one board.
