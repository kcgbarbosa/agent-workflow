# agent-workflow

The skills, the agents and the code that build KC's repos from a ticket to a merged pull request.

## Language

**Runner**:
The code that turns ready tickets into T3 threads and acts on what Jira, GitHub and T3 show.
_Avoid_: Dispatcher, orchestrator

**Tick**:
One run of the runner: it reads the state, does the next action for each ticket and exits.
_Avoid_: Poll, cycle

**Stuck ticket**:
A ticket that is Flagged and has a thread. It waits on the owner, and it counts against the limit.
_Avoid_: Blocked, a term that a blocking link already uses

**Limit**:
How many tickets may hold a place at once: threads with an active agent turn, plus stuck tickets.
_Avoid_: Slot, parallel

**Port set**:
One group of a stack's ports, from a fixed list the repo owns.
_Avoid_: Slot
