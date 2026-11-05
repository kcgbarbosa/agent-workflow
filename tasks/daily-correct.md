# Daily correct

Run `/correct` in this repo. Post nothing in Slack: the triage reports a pull request that waits on KC.

This folder is the project's main checkout, which other agents read, so leave it and its branch as they are. Work in a worktree of your own:

`git fetch origin main && git worktree add -b fix/correct-$(date +%F) "$(mktemp -d)/correct" origin/main`

Run the skill there. When the skill changes nothing, remove the worktree with `git worktree remove` and delete its branch. Reply with the pull request's link, or with why there is none.
