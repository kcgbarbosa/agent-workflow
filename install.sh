#!/usr/bin/env bash
# Links each skill and subagent tier in this repo, the shared files in config/, and config/CLAUDE.md, into ~/.claude, and installs the runner command.
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
for file in settings.json statusline.sh keybindings.json notify.sh format-markdown.ts; do
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
  ln -sfn "$repo/config/CLAUDE.md" "$dest/CLAUDE.md"
fi

# Auto memory lives under <config dir>/projects, so a T3 Code account with its own config dir (homePath) gets a second memory for each repo.
# Its projects folder merges into ~/.claude/projects and becomes a link. A file that differs stays in its place, and the link waits until it is gone.
t3_settings="$HOME/.t3/userdata/settings.json"
if [ -f "$t3_settings" ] && command -v jq >/dev/null 2>&1; then
  shared="$dest/projects"
  while IFS= read -r home_path; do
    own="${home_path/#\~/$HOME}/projects"
    [ "$own" != "$shared" ] || continue
    mkdir -p "$shared" "$(dirname "$own")"
    if [ -L "$own" ]; then
      [ "$(readlink "$own")" = "$shared" ] || echo "agent-workflow: skipped $own, it is a link to somewhere else" >&2
      continue
    fi
    if [ -d "$own" ]; then
      while IFS= read -r -d '' file; do
        file="${file#"$own"/}"
        if [ ! -e "$shared/$file" ] && [ ! -L "$shared/$file" ]; then
          mkdir -p "$(dirname "$shared/$file")"
          mv "$own/$file" "$shared/$file"
        elif cmp -s "$own/$file" "$shared/$file"; then
          rm "$own/$file"
        fi
      done < <(find "$own" ! -type d -print0)
      find "$own" -depth -type d -empty -delete
    fi
    if [ -e "$own" ]; then
      echo "agent-workflow: skipped the link of $own, these files differ from $shared, so merge them by hand and run this again:" >&2
      find "$own" ! -type d | sort >&2
    else
      ln -s "$shared" "$own"
    fi
  done < <(jq -r '.providerInstances // {} | .[] | select(.driver == "claudeAgent") | .config.homePath // empty' "$t3_settings")
fi

# User-scope MCP servers live in ~/.claude.json, which no repo can track. Each one signs in with OAuth on first use.
if command -v claude >/dev/null 2>&1; then
  claude mcp get workos >/dev/null 2>&1 || claude mcp add --scope user --transport http workos https://mcp.workos.com/mcp
  claude mcp get aws-mcp >/dev/null 2>&1 || claude mcp add --scope user --transport http aws-mcp https://aws-mcp.us-east-1.api.aws/mcp
fi

# The runner command is a link to runner/bin/runner, so a git pull updates it too. Node runs its TypeScript as it is.
if command -v npm >/dev/null 2>&1; then
  if npm ci --prefix "$repo/runner" --no-audit --no-fund --silent; then
    mkdir -p "$HOME/.local/bin"
    ln -sfn "$repo/runner/bin/runner" "$HOME/.local/bin/runner"
  else
    echo "agent-workflow: the runner command did not install" >&2
  fi
else
  echo "agent-workflow: skipped the runner command, npm is missing" >&2
fi
# The old command is gone, so its link would point at nothing. A link to elsewhere belongs to someone else.
if [ "$(readlink "$HOME/.local/bin/loop" 2>/dev/null)" = "$repo/loop/bin/loop" ]; then rm "$HOME/.local/bin/loop"; fi # retired-name-ok until 2027-02-05, approved KC: removes the link of the retired command

