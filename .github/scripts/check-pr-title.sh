#!/usr/bin/env bash
# Fails when the pull request title is not `type(scope): subject`, or the title or body has an em dash.
# A squash merge makes the title the commit on main, and AGENTS.md forbids em dashes in any writing.
# Takes TITLE and BODY from the environment, so they never become shell code.
set -uo pipefail

found=0
if ! grep -qE '^(feat|fix|docs|refactor|test|chore|ci|perf|build|style|revert)(\([^)]+\))?!?: .+' <<< "${TITLE:-}"; then
  echo "The title must start with a type, such as 'fix(loop): stop a stuck session'." >&2
  found=1
fi
if printf '%s\n%s\n' "${TITLE:-}" "${BODY:-}" | grep -q $'\xe2\x80\x94'; then
  echo "The title or the body has an em dash. Use a comma, a period, or a new sentence." >&2
  found=1
fi
exit "$found"
