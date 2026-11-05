# Stuck tickets count against the limit

The runner has no circuit breaker. A stuck ticket, one that is Flagged and has a thread, counts against the limit on tickets building at once, the same as a thread with an active agent turn. A ticket whose pull request waits on the gate does not count, because the limit protects usage and the host, and that wait uses little of either. A Flagged ticket with no thread does not count. When stuck and running tickets reach the limit, nothing new starts until the owner unflags one. A system-wide failure, such as an expired token or a broken `main`, costs at most the limit's worth of tickets, with no count, order or reset to keep.

## Considered Options

- A separate breaker that pauses the queue after N stuck tickets in a row. Rejected because it needs its own count and a way to reset, which a stateless runner (ADR-0001) would have to store somewhere.
- No protection. Rejected because each stuck ticket would free its place for the next one to fail the same way.

## Consequences

A stuck ticket the owner leaves alone lowers how many tickets build at once.
