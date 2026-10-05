#!/usr/bin/env bash
# Links each skill in this repo, and AGENTS.md as CLAUDE.md, into ~/.claude. Safe to run again.
set -euo pipefail

repo="$(cd "$(dirname "$0")" && pwd)"
dest="$HOME/.claude"
mkdir -p "$dest/skills"

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

if [ -e "$dest/CLAUDE.md" ] && [ ! -L "$dest/CLAUDE.md" ]; then
  echo "agent-workflow: skipped CLAUDE.md, $dest/CLAUDE.md is a real file. Remove it, then run this again" >&2
else
  ln -sfn "$repo/AGENTS.md" "$dest/CLAUDE.md"
fi
