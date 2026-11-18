#!/usr/bin/env bash
# Install the runner as a macOS LaunchAgent so it starts at login and restarts
# if it crashes. Safe to re-run; uninstall with:
#   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.clipper.runner.plist
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
AGENT="$HOME/Library/LaunchAgents/com.clipper.runner.plist"
LOG="$HOME/Library/Logs/clipper-runner.log"

if [ ! -f "$ROOT/.env" ]; then
  echo "Missing $ROOT/.env — copy .env.example and paste your runner token first." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|__ROOT__|$ROOT|g" -e "s|__LOG__|$LOG|g" \
  "$HERE/com.clipper.runner.plist" > "$AGENT"

launchctl bootout "gui/$(id -u)" "$AGENT" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENT"

echo "Installed. Logs: $LOG"
echo "Status:  launchctl print gui/$(id -u)/com.clipper.runner | head -20"
