---
name: map-this
description: Check this thread's decisions against the setup map, and report what the map should change.
disable-model-invocation: true
---

# Map this

The setup map is `dot_local/share/start/map.html` in `~/dev/machines`. It shows how KC's setup connects and what each connection lets KC do. Each repo's docs hold the detail.

## 1. Read the map

Run `git -C ~/dev/machines fetch`, save `origin/main`'s copy to a temporary file, and read it from `<body>` to the end of the `WIRES` array. The CSS above and the script below hold no content.

## 2. List the decisions

Walk the thread from its first message and list each decision. A decision is a choice KC made or accepted, including a plan dropped, a question settled, or a status changed. An option KC left open is not one.

When the thread was compacted, you see its start only as a summary, so say so in the report.

## 3. Give each decision a verdict

- **Update**: it changes what the map shows, such as a box, a step, a connection, who acts, a schedule or a status, or it makes a statement on the map false, or it settles an item in Coming or Still open.
- **No change**: the map already says it, or it is a detail for a repo's docs. Test: without it, would KC reading the map be misled, or miss a way in or something that waits on them?

Check a status before you give it. Confirm on the repo's `origin/main` that the work merged, and read the map's Key for the badges. Decided and unbuilt is `proposed`. Merged and running has no badge.

This step is done when every decision on the list has a verdict.

## 4. Report, and wait

Lead with the answer: the changes the map needs, or that it stays as it is.

| Decision | Spot on the map | Change | Status |
| -------- | --------------- | ------ | ------ |

The spot is an `id` from the map, or a new box and the `id` it sits under. Below the table, give each no-change decision one line with its reason. KC picks which changes to apply, and the map waits for that answer.

## 5. Apply what KC picked

Work in a new worktree of `~/dev/machines`, branched from `origin/main`.

- Reuse the classes the Key shows. A new box gets an `id` and a `data-n`, and a `WIRES` entry for each connection it makes.
- Set the `Status as of` date to today.
- The Moments strip is on this page and on `index.html` beside it. Change both.

Run `npx vitest run tests/start-page.test.ts`, then open a pull request through `/pr`, titled `docs: ...`.
