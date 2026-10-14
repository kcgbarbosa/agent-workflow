#!/usr/bin/env bash
# Claude Code status line: minimal token counter -> "46.1k (5.0%)"
# Receives session JSON on stdin. See https://code.claude.com/docs/en/statusline

input=$(cat)

IN=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0')

TOK=$(awk -v n="$IN" 'BEGIN{
  if (n >= 1000000) printf "%.1fM", n/1000000;
  else if (n >= 1000) printf "%.1fk", n/1000;
  else printf "%d", n;
}')

printf '%s (%.1f%%)' "$TOK" "$PCT"
