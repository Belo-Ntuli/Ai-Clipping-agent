#!/usr/bin/env bash
# Entry point for launchd. Keeps the runner alive and stops the Mac from
# idling to sleep while it is plugged in, so a stream never goes unwatched.
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

BUN="$(command -v bun || true)"
if [ -z "$BUN" ]; then
  echo "bun not found on PATH; install it with: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

# -s prevents system sleep on AC power; it does not override a closed lid.
exec caffeinate -s "$BUN" run src/index.ts start
