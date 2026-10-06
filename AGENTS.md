# KC's Agent Instructions

These are common instructions for KC's agents across all scenarios.

## General Guidelines

- Never use em dashes (—) in any writing.
  Use commas, periods, or restructure the sentence instead.
- Never add your agent name as co-author, in commit messages or anywhere else.
- Never manually modify CHANGELOG.md files or any files that are marked as auto-generated.
- Be straightforward. Do not dress up writing with counts and tallies for effect, such as "14 screens in nine Epics" or "twelve themed components".
  Nobody cares. Say what the thing is, and give a number only when the reader needs it to act.
- Give each fact one home doc, and link to it from everywhere else.
  A restated fact drifts from its home.
- Auto mode holds changes to sensitive admin controls, such as WorkOS roles and settings, until KC approves them, so plan each one as a human step when the work runs unattended.

## Commit message conventions

- When the repo's `docs/agents/issue-tracker.md` gives an issue key format, the key is the scope: `feat(PITCH-5): add login`.
  The key keeps its own case.
- These rules apply in full to the commit that reaches the default branch. In a repo that squash-merges, that commit is the pull request title.
  A commit on a working branch needs only the prefix and the key.
