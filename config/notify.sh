#!/usr/bin/env bash
# The Claude Code Notification hook. Shows a desktop notification, or does nothing where none is possible.
text="Claude Code is waiting for input"

case "$(uname)" in
  Darwin)
    command -v osascript >/dev/null 2>&1 || exit 0
    osascript -e "display notification \"$text\" with title \"Claude Code\" sound name \"Funk\"" >/dev/null 2>&1 || true
    ;;
  Linux)
    command -v notify-send >/dev/null 2>&1 || exit 0
    DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}" \
      notify-send --app-name='Claude Code' --hint=string:sound-name:message-new-instant 'Claude Code' "$text" >/dev/null 2>&1 || true
    ;;
esac
exit 0
