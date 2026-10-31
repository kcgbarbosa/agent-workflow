#!/usr/bin/env bash
# setup-repo's lefthook step. Run it at the root of the repo.
# It writes `lefthook.yml` from what the repo has, when the repo has no lefthook file: Prettier, gitleaks, and lychee always,
# Ruff with a `pyproject.toml`, oxlint and `tsc` with a `tsconfig.json`, and shellcheck with a shell script.
# Then it removes the repo's `core.hooksPath`, which would stop lefthook's hooks from running, and runs `lefthook install`.
# A second run changes nothing.
set -euo pipefail

has_lefthook_file() {
  local name
  for name in lefthook.yml lefthook.yaml .lefthook.yml .lefthook.yaml; do
    [ -e "$name" ] && return 0
  done
  return 1
}

# One command that runs $2 in each folder of the repo that holds a tracked file named $1.
in_each_folder() {
  local folder command=""
  while read -r folder; do
    [ -n "$command" ] && command+=" && "
    if [ "$folder" = . ]; then command+="$2"; else command+="(cd $folder && $2)"; fi
  done < <(git ls-files "$1" "**/$1" | xargs -r -n1 dirname | sort -u)
  echo "$command"
}

write_lefthook_file() {
  cat > lefthook.yml <<'YAML'
# Every check of the repo, wired once. A commit runs it on the staged files.
pre-commit:
  parallel: true
  commands:
    prettier:
      glob: "*.{md,json,yml,yaml}"
      run: prettier --write {staged_files}
      stage_fixed: true
    gitleaks:
      run: gitleaks dir --no-banner --redact .
    lychee:
      glob: "*.md"
      run: lychee --offline --no-progress {staged_files}
YAML
  if [ -n "$(git ls-files pyproject.toml '**/pyproject.toml')" ]; then
    cat >> lefthook.yml <<'YAML'
    ruff-format:
      glob: "*.py"
      run: uvx ruff format {staged_files}
      stage_fixed: true
    ruff-check:
      glob: "*.py"
      run: uvx ruff check {staged_files}
YAML
  fi
  if [ -n "$(git ls-files tsconfig.json '**/tsconfig.json')" ]; then
    cat >> lefthook.yml <<YAML
    oxlint:
      glob: "*.{ts,tsx,mjs,js}"
      run: $(in_each_folder tsconfig.json "npx oxlint")
    tsc:
      glob: "*.{ts,tsx}"
      run: $(in_each_folder tsconfig.json "npx tsc --noEmit")
YAML
  fi
  if [ -n "$(git ls-files '*.sh')" ]; then
    cat >> lefthook.yml <<'YAML'
    shellcheck:
      glob: "*.sh"
      run: uvx --from shellcheck-py shellcheck {staged_files}
YAML
  fi
}

has_lefthook_file || write_lefthook_file
git config --local --unset-all core.hooksPath || true
lefthook install
