#!/usr/bin/env bash
# Fails when a pull request's commits or body credit Claude or Anthropic as a co-author.
# AGENTS.md forbids it, and a squash merge carries the branch's trailers onto main.
# Takes BASE_SHA, HEAD_SHA, and PR_BODY from the environment, so the body never becomes shell code.
set -euo pipefail

pattern='^co-authored-by:.*(claude|anthropic)'
found=0

# Only the pull request's own commits. Older commits on main already carry trailers.
for sha in $(git rev-list "$BASE_SHA..$HEAD_SHA"); do
  if git log -1 --format=%B "$sha" | grep -qiE "$pattern"; then
    echo "Commit $(git log -1 --format='%h %s' "$sha") has a Claude co-author trailer." >&2
    found=1
  fi
done

if printf '%s\n' "${PR_BODY:-}" | grep -qiE "$pattern"; then
  echo "The pull request body has a Claude co-author trailer." >&2
  found=1
fi

if [ "$found" = 1 ]; then
  echo "Remove each Co-authored-by trailer above: reword the commits and edit the pull request body." >&2
  exit 1
fi
