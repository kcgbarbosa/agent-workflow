# The thread title links a ticket to its thread

The runner titles a ticket's thread `<KEY>: <summary>` and finds it in `t3 thread list --json` by the `<KEY>:` prefix only, so a side thread that names a ticket is left alone. It starts no thread for a ticket that has a matching thread or a pull request for its key, by the branch name or a `(<KEY>):` scope in the title. The thread is its own record, so no second write can get out of step with it, and any client that can list T3 threads can find a run by its key.

A build starts one way from any client: the ticket moves to To Do in Jira. An agent asked by chat or voice to start a build moves the ticket, with no skill and no direct thread. A thread started directly for a ticket must have a title that starts with `<KEY>:`, or the runner starts a second one.

## Considered Options

- A Jira comment with the thread id. Rejected because a crash between starting the thread and writing the comment causes a second start.
- The branch name alone. Rejected because a thread that has not pushed has no branch to see.
