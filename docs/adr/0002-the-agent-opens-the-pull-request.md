# The agent opens the pull request

A ticket's T3 thread runs `/implement` and `/pr`, so the agent pushes and opens the pull request, the same as a thread the owner starts by hand. The runner finds the pull request by branch name and treats a thread that completes with none as a failed run. Labels and auto-merge stay with the runner, and the gate decides the merge. This gives one build path, and a better pull request body than a template would write.

## Considered Options

- The agent only commits, and the runner pushes and opens the pull request from the ticket. Rejected because it keeps a second path and a templated body, and determinism already holds: the runner acts only on what GitHub shows.
