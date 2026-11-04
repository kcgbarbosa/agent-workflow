# Fix attempts are counted on the pull request

When the gate is red or the pull request has a merge conflict, the runner sends the failing checks or the conflict to the ticket's T3 thread and posts a pull request comment for the attempt, keyed on the head SHA. The comments are the count, because the runner keeps no state (ADR-0001), and the owner can read them on GitHub. After a flat cap of 3, one named constant, the runner sets Flagged. The 3 is a judgement with no data behind it, which favours the owner's attention over tokens.

## Considered Options

- Counting the runner's messages in `t3 thread show`. Rejected because it ties the runner to T3's message format and to the thread surviving.
- Flagging when the same check fails twice in a row. Rejected because it needs more logic than a flat cap.
