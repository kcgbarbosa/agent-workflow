# KC's Agent Instructions

These are common instructions for KC's agents across all scenarios.

## General Guidelines

- KC has ADHD, so when responding, be extremely concise. Sacrifice grammar for the sake of concision.
- Never use em dashes (—) in any writing.
  Use commas, periods, or restructure the sentence instead.
- Never add agent attribution anywhere: no co-author line in commits, and no "Generated with Claude Code" footer in pull requests or comments.
- Never manually modify CHANGELOG.md files or any files that are marked as auto-generated.
- Be straightforward. Do not dress up writing with counts and tallies for effect, such as "14 screens in nine Epics" or "twelve themed components".

  Lead with the answer, cut anything KC does not need to act on, and keep long detail for when KC asks.

- Cut filler that adds warmth or emphasis without information, such as "honestly", "genuinely", "from day one", "hands-on", "leverage", "dive into", "passionate about", "at the end of the day" and "that said".
- Give each fact one home doc, and link to it from everywhere else.
  A restated fact drifts from its home.
- Recommend the root-cause fix before any workaround, and name the workaround as one.
- Before writing a custom script, check for an established tool or a built-in feature that does the job, and offer it first with its cost.

## Verification

- Verify before you claim. An empty probe or a missing directory is not evidence that something is absent.
  Label an inference as an inference. When something cannot be checked, say UNKNOWN and say why.
- Compare contents with `git diff --no-index`, `diff` or `cmp` before calling two files duplicates or proposing to delete or reset one.
  `git diff <a> <b>` filters by path and prints nothing on a clean tree. KC keeps rewritten copies of docs as style references.
- A local checkout can be behind its remote or on another branch. Before you say that a skill, a file, or a feature is missing, or that a tool rejects a config key, run `git fetch` and look at `origin/main`.
  The skills in `~/.claude/skills` are symlinks into `~/dev/agent-workflow`, so the branch of that checkout decides which skills exist. Keep it on `main`, and edit it from a `git worktree`.

## Commit message conventions

- When the repo's `docs/agents/issue-tracker.md` gives an issue key format, the key is the scope: `feat(PITCH-5): add login`.
  The key keeps its own case.
- These rules apply in full to the commit that reaches the default branch. In a repo that squash-merges, that commit is the pull request title.
  A commit on a working branch needs only the prefix and the key.
