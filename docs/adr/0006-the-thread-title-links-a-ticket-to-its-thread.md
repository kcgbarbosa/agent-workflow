# The thread title links a ticket to its thread

The runner titles a ticket's thread `<KEY>: <summary>` and matches it in `t3 thread list --json`. It starts no thread for a ticket that has a matching thread or an open pull request for its key. The thread is its own record, so no second write can get out of step with it, and any client that can list T3 threads can find a run by its key.

A build starts one way from any client: the ticket moves to To Do in Jira. A client that starts a thread for a ticket directly puts the key in the title, because the runner would otherwise start a second one.

## Considered Options

- A Jira comment with the thread id. Rejected because a crash between starting the thread and writing the comment causes a second start.
- The branch name alone. Rejected because a thread that has not pushed has no branch to see.
