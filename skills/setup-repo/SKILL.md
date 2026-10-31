---
name: setup-repo
description: "Configure this repo for the Jira workflow and the shared merge gate: write docs/agents/issue-tracker.md, domain.md, testing.md and workflow.md, the Agent skills block of AGENTS.md, the lefthook file, the gate workflows, and the branch protection. Run once before first use of /to-spec, /to-prd and /to-tickets."
disable-model-invocation: true
---

# Setup Repo

Scaffold the per-repo configuration that `grill-with-docs`, `to-spec`, `to-prd`, `to-tickets` and `implement` assume:

- **Issue tracker**: the Jira project, the key format, the board fields, what the Epic description holds, and whether the repo has a PRD
- **Domain docs**: where `GLOSSARY.md`, the ADRs, the specs and the README Users table live
- **Testing**: the acceptance suite that proves each "What the user sees" line on the real stack, and what may be stubbed
- **Workflow**: the order of the work for one feature
- **Checks**: one `lefthook.yml` that lists every format, lint and policy check, run at each commit
- **Gate**: the shared merge gate that every pull request must pass, and auto-merge behind it

This is a prompt-driven skill, not a deterministic script. Explore, present what you found, confirm with the user, then write. It reads Jira at most, and writes nothing in it.

## Process

### 1. Explore

Look at the current repo to understand its starting state. Read whatever exists; don't assume:

- `git remote -v` and `git branch --show-current`
- `AGENTS.md` and `CLAUDE.md` at the repo root. Is there already an `## Agent skills` section? Does `CLAUDE.md` exist?
- `GLOSSARY.md`, `docs/adr/`, `docs/product/` (does it hold a metrics file or a personas file?), and the Users table in `README.md`
- `docs/agents/`: does this skill's prior output already exist? A labels file, or a GitHub or local-files `issue-tracker.md`, is output of the retired setup skill.
- `loop.toml` and `docs/agents/loop.md`: is there a loop?
- The test folders, the test commands in the `Makefile` or `package.json`, and the seed: is there a suite that runs on the real stack, and a stubbed one?
- `.github/workflows/`, the `check` and `check-docs` targets of the `Makefile`, and a `mise.toml` or `.tool-versions`: is the repo on the gate?
- `lefthook.yml` and `git config --local core.hooksPath`: are the checks wired?
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

**Section B: The PRD.** Ask whether the repo has a PRD. Recommend no. A PRD is a one-page brief for an executive, which `/to-prd` writes into the Epic description. Without one, the Epic description is the link to the spec that `/to-spec` writes, and no skill needs a metrics file, a personas file or an owner name. On yes, ask for:

- The paths of the metrics file and the personas file, in one question. Recommend `docs/product/metrics.md` and `docs/product/personas.md`. The owner writes the metrics file. It holds the baselines and targets that every PRD quotes. The personas file holds one fictional person per Role, drafted by an agent and approved by the owner.
- The name of the PRD owner, as the PRD should show it. This is the one real name `/to-prd` writes.

Check that the two files exist in the repo. Report a file that is missing. Do not create it.

**Section C: Domain docs.** The layout is single-context: one `GLOSSARY.md` and one `docs/adr/` at the repo root. Ask for the spec folder. Recommend `docs/product/specs/` with a PRD and `docs/specs/` without one. If exploration found monorepo signals, tell the user that this skill writes the single-context layout only, and ask whether to continue.

**Section D: Testing.** Ask for:

- The acceptance folder, its command for one ticket, and its command that lists the titles of one ticket's tests. Recommend the ones exploration found. With no suite yet, recommend Playwright on the real stack, and say that the first UI ticket builds it.
- The UI review skill, and its UI review run: the command that runs one ticket's tests and saves a screenshot of each step in a folder it names. Recommend `.claude/skills/ui-review/` and `make ui-review ticket=<key> run=<folder>`. Only the UI review run saves screenshots, because nobody looks at those of another run. The command for one ticket, the merge gate, and a check run save none.
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

Without a PRD, leave out the `## The PRD` section of `issue-tracker.md`. Skills read that section's first line, "The Epic is the PRD.", to tell that a repo has one.

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

grill-with-docs → to-spec → to-tickets → the loop or a T3 Code thread → the gate. See `docs/agents/workflow.md`.
```

When a labels file from the retired setup skill exists in `docs/agents/`, tell the user it is obsolete and offer to delete it. Delete it only if they agree.

### 5. Wire the checks

Run `~/.claude/skills/setup-repo/hooks.sh` at the repo root. When the repo has no lefthook file, it writes `lefthook.yml` from the languages the repo has. Its header lists the checks of each language. Then it unsets the repo's `core.hooksPath` and runs `lefthook install`, so each commit runs the checks on its staged files. Show the user the file.

Draft the start of the `check` target of the `Makefile` with `lefthook run pre-commit --all-files --no-stage-fixed --no-auto-install` then `git diff --exit-code`, so the gate runs the same list and fails when a formatter changed a file. Write it once the user approves, after the gate's runner has the tools: `lefthook`, `prettier`, `gitleaks` and `lychee` in the repo's `mise.toml`.

### 6. Put the repo on the gate

The shared merge gate is `.github/workflows/gate.yml` in agent-workflow. It runs the repo's `make check` on each pull request, and `make check-docs` on one that changes only `*.md` files and `docs/`. Beside the check, `gate / review` has a second model review the pull request, except on a docs-only one. After a green check, `gate / judge` has a model look at each changed screenshot. Both bill the repo secret `CLAUDE_CODE_OAUTH_TOKEN`, a Claude plan, or `ANTHROPIC_API_KEY`, the API. A check that needs keys, such as for its stack, gets them from the optional repo secret `CHECK_ENV`, one `NAME=value` per line. When the `Makefile` lacks either target, draft it from the test commands that exploration found, and write it once the user approves.

Then, at the repo root:

1. Ask whether the review is on. Recommend off for a small private repo, where a review of each pull request costs more than it saves.
2. Run `~/.claude/skills/setup-repo/gate.sh write`. Its header lists the files it writes: the call to the gate, the `hold` check, a `mise.toml` when there is no mise file, and the gate's `loop.toml` settings with the review on. When the answer was off, set `enabled = false` in the `[review]` table. When the repo has a UI, ask which faults block a merge, such as text cut off or an element off screen, and write them as `blocking` in its `[ui]` table. Show the user the diff. A CI workflow that runs the same tests as `make check` can go once the gate runs. The gate reads `loop.toml` from the base branch, so on this first pull request `gate / review` runs as if the review were on, and fails in a repo with no token. That failure is expected: merge the pull request anyway, since the branch is not protected yet.
3. Ask before you run `~/.claude/skills/setup-repo/gate.sh protect`. It changes the GitHub settings and needs an admin token: squash merges only with the pull request title, auto-merge on, delete branch on merge, the `hold` label, and the default branch protected with required checks `gate / check`, `gate / review`, `gate / judge`, and `hold`, no required approvals, and no force push. Run it after the pull request that adds the workflows merges, so no open pull request waits on a check it cannot run.

Both steps are safe to run again. A second run in a repo already on the gate adds the checks it lacks, such as `gate / review` and `gate / judge`. A pull request with auto-merge on merges itself when every required check is green. The `hold` label keeps it waiting.

### 7. Done

Tell the user which files you wrote. Say that they can edit `docs/agents/*.md` directly, and that this skill needs to run again only to change the Jira project, the PRD, or the acceptance suite.

End by pointing at `/setup-loop`: run it to let the loop build an Epic unattended. Skip it for a repo that builds with `implement` only.
