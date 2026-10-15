#!/usr/bin/env bash
# Links each skill and subagent tier in this repo, the shared files in config/, and AGENTS.md as CLAUDE.md, into ~/.claude, and installs the loop command.
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

# The shared files win over a file made by hand. The old file is kept as <name>.bak, or <name>.bak.<time> when that exists.
for file in settings.json statusline.sh keybindings.json notify.sh; do
  target="$dest/$file"
  if [ -L "$target" ]; then
    case "$(readlink "$target")" in
      "$repo"/config/*) ;;
      *)
        echo "agent-workflow: skipped $file, $target is a link to somewhere else" >&2
        continue
        ;;
    esac
  elif [ -e "$target" ]; then
    backup="$target.bak"
    [ ! -e "$backup" ] && [ ! -L "$backup" ] || backup="$target.bak.$(date +%Y%m%d%H%M%S).$$"
    mv "$target" "$backup"
    echo "agent-workflow: moved $target to $backup" >&2
  fi
  ln -sfn "$repo/config/$file" "$target"
done

if [ -e "$dest/CLAUDE.md" ] && [ ! -L "$dest/CLAUDE.md" ]; then
  echo "agent-workflow: skipped CLAUDE.md, $dest/CLAUDE.md is a real file. Remove it, then run this again" >&2
else
  ln -sfn "$repo/AGENTS.md" "$dest/CLAUDE.md"
fi

# User-scope MCP servers live in ~/.claude.json, which no repo can track. Each one signs in with OAuth on first use.
if command -v claude >/dev/null 2>&1; then
  claude mcp get workos >/dev/null 2>&1 || claude mcp add --scope user --transport http workos https://mcp.workos.com/mcp
  claude mcp get aws-mcp >/dev/null 2>&1 || claude mcp add --scope user --transport http aws-mcp https://aws-mcp.us-east-1.api.aws/mcp
fi

# An editable install, so a git pull updates the loop command too.
if command -v uv >/dev/null 2>&1; then
  uv tool install --quiet --editable "$repo/loop" || echo "agent-workflow: the loop command did not install" >&2
else
  echo "agent-workflow: skipped the loop command, uv is missing" >&2
fi
