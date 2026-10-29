#!/usr/bin/env bash
# setup-repo's gate step. Run it at the root of the repo that goes on the shared gate.
#   gate.sh write    writes the caller and hold workflows, a mise file when there is none, and the gate's loop.toml settings.
#   gate.sh protect  sets squash-only auto-merge, the hold label, and the branch protection through gh api. It needs an admin token.
# A second run of either step changes nothing.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
templates=$here/gate

has_mise_file() {
  local name
  for name in mise.toml .mise.toml .tool-versions .config/mise.toml; do
    [ -e "$name" ] && return 0
  done
  return 1
}

# Pins the host's versions of the tools the repo uses, so the runner matches the T14.
write_mise_file() {
  local files tools=""
  files=$(git ls-files)
  if grep -qE '(^|/)package\.json$' <<<"$files"; then
    tools+="node = \"$(node --version | sed 's/^v//')\"\n"
  fi
  if grep -qE '(^|/)(pyproject\.toml|uv\.lock)$' <<<"$files"; then
    tools+="uv = \"$(uv --version | cut -d' ' -f2)\"\n"
  fi
  [ -n "$tools" ] && printf '[tools]\n%b' "$tools" > mise.toml
  return 0
}

write() {
  mkdir -p .github/workflows
  # agent-workflow calls its own gate, so a change to the gate runs in the pull request that makes it.
  if grep -qs '^  workflow_call:' .github/workflows/gate.yml; then
    sed 's|uses: kcgbarbosa/agent-workflow/.github/workflows/gate.yml@main|uses: ./.github/workflows/gate.yml|' \
      "$templates/pull-request.yml" > .github/workflows/pull-request.yml
  else
    cp "$templates/pull-request.yml" .github/workflows/pull-request.yml
  fi
  cp "$templates/hold.yml" .github/workflows/hold.yml
  has_mise_file || write_mise_file
  if ! grep -qsE '^(# )?\[review\]' loop.toml; then
    if [ -s loop.toml ]; then echo >> loop.toml; fi
    cat "$templates/loop.toml" >> loop.toml
  fi
}

protect() {
  local branch
  branch=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)
  gh api -X PATCH 'repos/{owner}/{repo}' \
    -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
    -F allow_auto_merge=true -F delete_branch_on_merge=true \
    -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY > /dev/null
  gh label create hold --force --color B60205 --description "Keeps a green pull request from merging" > /dev/null
  # No approvals, but a pull request is required, so nothing reaches the default branch another way.
  gh api -X PUT "repos/{owner}/{repo}/branches/$branch/protection" --input - > /dev/null <<'JSON'
{
  "required_status_checks": {"strict": false, "checks": [{"context": "gate / check"}, {"context": "gate / review"}, {"context": "gate / judge"}, {"context": "hold"}]},
  "enforce_admins": true,
  "required_pull_request_reviews": {"required_approving_review_count": 0},
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
}

case "${1:-}" in
  write) write ;;
  protect) protect ;;
  *)
    echo "usage: gate.sh write|protect" >&2
    exit 2
    ;;
esac
