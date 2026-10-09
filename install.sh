#!/usr/bin/env bash
# Links each skill and subagent tier in this repo, and AGENTS.md as CLAUDE.md, into ~/.claude, and installs the loop command.
# Safe to run again.
set -euo pipefail

repo="$(cd "$(dirname "$0")" && pwd)"
dest="$HOME/.claude"
mkdir -p "$dest/skills" "$dest/agents"

for skill in "$repo"/skills/*/; do
  name="$(basename "$skill")"
  target="$dest/skills/$name"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "agent-workflow: skipped $name, $target is a real folder" >&2
    continue
  fi
  ln -sfn "${skill%/}" "$target"
done

# Remove the links to skills that are no longer in this repo.
for link in "$dest"/skills/*; do
  [ -L "$link" ] || continue
  case "$(readlink "$link")" in
    "$repo"/skills/*) [ -e "$link" ] || rm "$link" ;;
  esac
done

for tier in "$repo"/agents/*.md; do
  name="$(basename "$tier")"
  target="$dest/agents/$name"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "agent-workflow: skipped the $name tier, $target is a real file" >&2
    continue
  fi
  ln -sfn "$tier" "$target"
done

for link in "$dest"/agents/*; do
  [ -L "$link" ] || continue
  case "$(readlink "$link")" in
    "$repo"/agents/*) [ -e "$link" ] || rm "$link" ;;
  esac
done

# A trial subagent's worktree branches from the default branch unless this setting says otherwise.
if ! grep -qs '"baseRef": *"head"' "$dest/settings.json"; then
  echo 'agent-workflow: the trial tier needs "worktree": {"baseRef": "head"} in ~/.claude/settings.json' >&2
fi

if [ -e "$dest/CLAUDE.md" ] && [ ! -L "$dest/CLAUDE.md" ]; then
  echo "agent-workflow: skipped CLAUDE.md, $dest/CLAUDE.md is a real file. Remove it, then run this again" >&2
else
  ln -sfn "$repo/AGENTS.md" "$dest/CLAUDE.md"
fi

# An editable install, so a git pull updates the loop command too.
if command -v uv >/dev/null 2>&1; then
  uv tool install --quiet --editable "$repo/loop" || echo "agent-workflow: the loop command did not install" >&2
else
  echo "agent-workflow: skipped the loop command, uv is missing" >&2
fi
