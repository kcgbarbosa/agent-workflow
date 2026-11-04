# T3 handles usage limits

The runner does not detect, wait out or resend for a usage limit. With `autoResumeLimitedThreads` on, T3 resumes a limited thread after the reset, as its source gives. T3 marks that thread `failed` with an error class the `t3` CLI does not print, so the runner cannot tell a limit from any other failure, and treats both the same way: one retry, then Flagged. Stuck tickets count against the limit (ADR-0008), so a usage limit stops new starts with no extra logic. A ticket flagged this way can finish by itself after the reset, and the owner unflags it.

## Considered Options

- The runner waits for the reset and resends. Rejected because it duplicates what T3 does.
- Reading the limit from the error text of a thread's run. Rejected because no text format is promised, and a limit could not be produced on demand to test it.
