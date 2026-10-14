#!/usr/bin/env bash
# Fresh demo state for a recording take: market server restarted in presenter (step) mode,
# demo store seeded, Chrome window sized for 1440x900 capture with the gallery + store tabs.
#
#   demo/record.sh              reset the market and open Chrome
#   NO_BROWSER=1 demo/record.sh  skip the Chrome window
#
# Env passed through to the server: PACE (default 0.8), AUCTION_SECS (45), DUTCH_STEP_SECS (4).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-4022}
LOGS=${TMPDIR:-/tmp}; LOGS=${LOGS%/}
GALLERY="http://localhost:$PORT/?theme=light"
STORE="http://localhost:$PORT/store/"

listener() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }
wait_for() { for _ in $(seq 1 60); do eval "$1" && return 0; sleep 0.5; done; echo "timed out: $2" >&2; exit 1; }

# 1. market server, fresh in-memory state, presenter mode
if [[ -n "$(listener "$PORT")" ]]; then echo "• stopping market server on :$PORT"; kill "$(listener "$PORT")"; sleep 1; fi
echo "• starting market server (step mode)"
STEP=1 PORT="$PORT" PACE="${PACE:-0.8}" AUCTION_SECS="${AUCTION_SECS:-45}" DUTCH_STEP_SECS="${DUTCH_STEP_SECS:-4}" \
  nohup node demo/market/server.mts > "$LOGS/holdback-market.log" 2>&1 &
wait_for "curl -sf localhost:$PORT/api/state >/dev/null" "market server"
PORT="$PORT" node demo/market/seed-store.mts >/dev/null

# 2. browser: one clean 1440x900 window, gallery first
if [[ -z "${NO_BROWSER:-}" ]]; then
  echo "• opening Chrome"
  osascript - "$GALLERY" "$STORE" <<'OSA' >/dev/null
on run argv
  tell application "Google Chrome"
    set w to make new window
    set bounds of w to {0, 25, 1440, 925}
    set URL of active tab of w to item 1 of argv
    tell w to make new tab with properties {URL:item 2 of argv}
    set active tab index of w to 1
    activate
  end tell
end run
OSA
fi

cat <<EOF

Ready.  Gallery  $GALLERY
        Store    $STORE
        Logs     $LOGS/holdback-market.log

Before you hit record:
  [ ] Do Not Disturb on (Control Centre → Focus)
  [ ] Chrome: bookmarks bar hidden (Cmd+Shift+B), zoom 100% (Cmd+0)
  [ ] Claude Code open in another window, holdback-market MCP connected (/mcp)
  [ ] Record the window: Cmd+Shift+5 → Record Selected Window, mic on
  [ ] Space (or Next scene) advances; rerun this script for a new take
EOF
