# The runner is a stateless tick

The runner that replaces the loop is a short script on a systemd timer. Each run reads Jira, GitHub and T3 Code, works out the next action for each ticket, does it and exits. It keeps no state of its own, so a restart needs no recovery logic and the same inputs always give the same action. ADR-0002 gives what an agent does.

## Considered Options

- A long-lived daemon. Rejected because it holds tickets in memory and needs restart recovery.
- A T3 scheduled thread, or a T3 pull request watch that wakes an agent. Rejected because an agent's judgement would drive the flow, which loses determinism.
