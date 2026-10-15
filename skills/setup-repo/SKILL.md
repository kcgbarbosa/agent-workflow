---
name: setup-repo
description: "Configure this repo for the Jira workflow: write docs/agents/issue-tracker.md, domain.md, testing.md and workflow.md and the Agent skills block of AGENTS.md. Run once before first use of /to-spec, /to-prd and /to-tickets."
disable-model-invocation: true
---

# Setup Repo

Scaffold the per-repo configuration that `grill-with-docs`, `to-spec`, `to-prd`, `to-tickets` and `implement` assume:

- **Issue tracker**: the Jira project, the key format, the board fields, the rule that the Epic is the PRD, the paths of the metrics file and the personas file, and the Confluence space for archived specs
- **Domain docs**: where `GLOSSARY.md`, the ADRs, the specs, the README Users table, the metrics file and the personas file live
- **Testing**: the acceptance suite that proves each "What the user sees" line on the real stack, and what may be stubbed
- **Workflow**: the order of the work for one feature

This is a prompt-driven skill, not a deterministic script. Explore, present what you found, confirm with the user, then write. It reads Jira and Confluence at most, and writes neither.

## Process

### 1. Explore

Look at the current repo to understand its starting state. Read whatever exists; don't assume:

- `git remote -v` and `git branch --show-current`
- `AGENTS.md` and `CLAUDE.md` at the repo root. Is there already an `## Agent skills` section? Does `CLAUDE.md` exist?
- `GLOSSARY.md`, `docs/adr/`, `docs/product/` (does it hold a metrics file or a personas file?), and the Users table in `README.md`
- `docs/agents/`: does this skill's prior output already exist? A labels file, or a GitHub or local-files `issue-tracker.md`, is output of the retired setup skill.
- `loop.toml` and `docs/agents/loop.md`: is there a loop?
- The test folders, the test commands in the `Makefile` or `package.json`, and the seed: is there a suite that runs on the real stack, and a stubbed one?
- Monorepo signals: a `pnpm-workspace.yaml`, a `workspaces` field in `package.json`, or a `GLOSSARY-MAP.md`.

If `CLAUDE.md` exists, stop. Claude Code reads `AGENTS.md` only when no `CLAUDE.md` exists in the working directory or above. Tell the user to merge `CLAUDE.md` into `AGENTS.md` and remove it, then run this skill again. Never create or edit `CLAUDE.md` or `CLAUDE.local.md`.

### 2. Present findings and ask

Summarise what is present and what is missing. Then take the sections in order. One section, one answer, then the next.

Lead each section with the recommended answer so the user can accept it in a word. Give a one-line explainer only when the choice genuinely branches. Skip a question that exploration already settled.

**Section A: Jira.** Ask for:

- The Jira project key. Recommend the key already in `docs/agents/issue-tracker.md` or in `.github/ticket-projects`, if either exists.
- The key format. Recommend `<KEY>-<n>`, used as the commit scope and in the branch name.
- The branch format. Recommend `<type>/<KEY>-<n>-<slug>`.
- The fields the owner sets by hand on a ticket. Recommend priority and sprint. Status is always `To Do`, `In Progress`, `In Review`, `Done`.
- The name of the PRD owner, as the PRD should show it. This is the one real name `/to-prd` writes.

**Section B: Metrics, personas and the spec archive.** Ask for:

- The paths of the metrics file and the personas file, in one question. Recommend `docs/product/metrics.md` and `docs/product/personas.md`. The owner writes the metrics file. It holds the baselines and targets that every PRD quotes. The personas file holds one fictional person per Role, drafted by an agent and approved by the owner.
- The Confluence space that archives specs. Recommend a space of its own for the project.
- The title of the parent page that archives specs. Recommend `Specs`.

Check that the two files exist in the repo. Report a file that is missing. Do not create it.
Read the space through the Atlassian connector to check that the parent page exists. Report it if it is missing. Do not create it.

**Section C: Domain docs.** The layout is single-context: one `GLOSSARY.md` and one `docs/adr/` at the repo root, and specs in `docs/product/specs/`. Write it without asking. If exploration found monorepo signals, tell the user that this skill writes the single-context layout only, and ask whether to continue.

**Section D: Testing.** Ask for:

- The acceptance folder, its command for one ticket, and its command that lists the titles of one ticket's tests. Recommend the ones exploration found. With no suite yet, recommend Playwright on the real stack, and say that the first UI ticket builds it.
- The UI review skill. Recommend `.claude/skills/ui-review/`.
- The stubbed and unit test folders, if any.

A repo with no screen and no stack writes "No acceptance suite" in `docs/agents/testing.md`, and each skill then skips the acceptance steps.

### 3. Confirm and edit

Show the user a draft of:

- The `## Agent skills` block to add to `AGENTS.md`
- The contents of `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, `docs/agents/testing.md` and `docs/agents/workflow.md`

Let them edit before writing.

### 4. Write

Write the four docs from the seed templates in this skill folder, with every `<placeholder>` filled in from the answers:

- [issue-tracker.md](./issue-tracker.md)
- [domain.md](./domain.md)
- [testing.md](./testing.md)
- [workflow.md](./workflow.md)

Write in the style of the repo's own documents. If `AGENTS.md` or `docs/agents/domain.md` names a writing standard, follow it.

Then edit `AGENTS.md`. If it does not exist, create it. If an `## Agent skills` block already exists, update its contents in place rather than appending a duplicate. Don't overwrite user edits to the surrounding sections. The block:

```markdown
## Agent skills

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/`. Read `docs/agents/domain.md` before you read or write a glossary term, an ADR, or any other document.

### Issue tracker

Jira, project `<KEY>`. See `docs/agents/issue-tracker.md`.

### Testing

Each "What the user sees" line is an acceptance test on the real stack. See `docs/agents/testing.md`.

### Workflow

grill-with-docs → to-spec → to-prd → to-tickets → implement, or the loop. See `docs/agents/workflow.md`.
```

When a labels file from the retired setup skill exists in `docs/agents/`, tell the user it is obsolete and offer to delete it. Delete it only if they agree.

### 5. Done

Tell the user which files you wrote. Say that they can edit `docs/agents/*.md` directly, and that this skill needs to run again only to change the Jira project, the paths of the metrics and personas files, the Confluence space, or the acceptance suite.

End by pointing at `/setup-loop`: run it to let the loop build an Epic unattended. Skip it for a repo that builds with `implement` only.
