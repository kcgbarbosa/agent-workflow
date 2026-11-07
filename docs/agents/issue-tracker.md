# Issue tracker: Jira

[`skills/setup-repo/issue-tracker.md`](../../skills/setup-repo/issue-tracker.md) is this repo's issue tracker doc, with the values below. Read it there, and change a shared rule there.

| Placeholder     | This repo           |
| --------------- | ------------------- |
| `<KEY>`         | `AW`                |
| `<spec folder>` | `docs/specs`        |
| `<Extra field>` | Sprint              |
| `<Values>`      | The board's sprints |

The key format is `AW-<n>`, and the branch format is `<type>/AW-<n>-<slug>`.

Only this repo:

- It has no PRD, so skip the doc's section on one.
- A pull request here names no key of another project, such as `PITCH`, because a merge would move that ticket to Done. `.github/scripts/check-pr-keys.sh` fails one that does, for each project in `.github/ticket-projects`.
