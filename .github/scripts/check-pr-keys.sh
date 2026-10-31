#!/usr/bin/env bash
# Fails when a pull request names a ticket key of another project. This repo's own project is AW, whose keys may appear.
# A merged pull request that names a key of a project in .github/ticket-projects would link this repo's change to
# that ticket, and a Jira Automation rule of that project could move it to Done.
# Reads the title and body on stdin, and takes the commit range as its argument. The projects are listed in
# .github/ticket-projects, one per line.
set -uo pipefail

range=$1
projects=${TICKET_PROJECTS_FILE:-.github/ticket-projects}
text=$(cat)
commits=$(git log --format=%B "$range")

pattern=$(grep . "$projects" | paste -sd'|')
[ -n "$pattern" ] || exit 0
named=$(grep -oE "\\b($pattern)-[0-9]+\\b" <<< "$text"$'\n'"$commits" | sort -u || true)

if [ -n "$named" ]; then
  echo "check-pr-keys: the pull request names ticket keys: $(tr "\n" " " <<< "$named")." >&2
  echo "Merging it would move them to Done. Remove them from the title, the body, and the commit messages." >&2
  exit 1
fi
