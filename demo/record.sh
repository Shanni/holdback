#!/usr/bin/env bash
# Fresh demo state for a recording take: validator up, market server restarted in presenter
# (step) mode, Chrome window sized for 1440x900 capture with the gallery + explorer tabs.
#
#   demo/record.sh              reset the market (keeps a running validator) and open Chrome
#   demo/record.sh --reset-chain also wipe the local validator ledger
#   NO_BROWSER=1 demo/record.sh  skip the Chrome window
#
# Env passed through to the server: PACE (default 0.8), AUCTION_SECS (45), DUTCH_STEP_SECS (4).
set -euo pipefail
cd "$(dirname "$0")/.."

PROGRAM_ID=63hjwfJZ8vHLL97WgGezNhuJenF6orxETi2yQGbMbygU
RPC=http://127.0.0.1:8899
PORT=${PORT:-4022}
LOGS=${TMPDIR:-/tmp}; LOGS=${LOGS%/}
LEDGER=${LEDGER:-$LOGS/holdback-ledger}
GALLERY="http://localhost:$PORT/?skin=bright&band=${BAND:-8fd3ff}&theme=light"
EXPLORER="https://explorer.solana.com/?cluster=custom&customUrl=$(printf %s "$RPC" | sed 's/:/%3A/g; s#/#%2F#g')"
ROBINHOOD="https://explorer.testnet.chain.robinhood.com/address/0xED594057c6350D622d95a19e7FE96f0565E1E7dF"

healthy() { curl -sf -XPOST "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"ok"'; }
listener() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }
wait_for() { for _ in $(seq 1 60); do eval "$1" && return 0; sleep 0.5; done; echo "timed out: $2" >&2; exit 1; }

# 1. validator
if [[ "${1:-}" == "--reset-chain" ]] && [[ -n "$(listener 8899)" ]]; then
  echo "• stopping validator"; kill "$(listener 8899)"; sleep 2
fi
if healthy; then
  echo "• validator already running on $RPC"
else
  [[ -f target/deploy/holdback.so ]] || { echo "missing target/deploy/holdback.so (run: pnpm build)" >&2; exit 1; }
  echo "• starting validator (ledger $LEDGER)"
  nohup solana-test-validator --reset --quiet --ledger "$LEDGER" \
    --bpf-program "$PROGRAM_ID" target/deploy/holdback.so > "$LOGS/holdback-validator.log" 2>&1 &
  wait_for healthy "validator"
fi

# 2. market server, fresh in-memory state, presenter mode
if [[ -n "$(listener "$PORT")" ]]; then echo "• stopping market server on :$PORT"; kill "$(listener "$PORT")"; sleep 1; fi
echo "• starting market server (step mode)"
STEP=1 PORT="$PORT" RPC="$RPC" PACE="${PACE:-0.8}" AUCTION_SECS="${AUCTION_SECS:-45}" DUTCH_STEP_SECS="${DUTCH_STEP_SECS:-4}" \
  nohup node demo/market/server.mts > "$LOGS/holdback-market.log" 2>&1 &
wait_for "curl -sf localhost:$PORT/api/state >/dev/null" "market server"

# 3. browser: one clean 1440x900 window, gallery first
if [[ -z "${NO_BROWSER:-}" ]]; then
  echo "• opening Chrome"
  osascript - "$GALLERY" "$EXPLORER" "$ROBINHOOD" <<'OSA' >/dev/null
on run argv
  tell application "Google Chrome"
    set w to make new window
    set bounds of w to {0, 25, 1440, 925}
    set URL of active tab of w to item 1 of argv
    tell w to make new tab with properties {URL:item 2 of argv}
    tell w to make new tab with properties {URL:item 3 of argv}
    set active tab index of w to 1
    activate
  end tell
end run
OSA
fi

cat <<EOF

Ready.  Gallery  $GALLERY
        Logs     $LOGS/holdback-market.log, $LOGS/holdback-validator.log

Before you hit record:
  [ ] Do Not Disturb on (Control Centre → Focus)
  [ ] Chrome: bookmarks bar hidden (Cmd+Shift+B), zoom 100% (Cmd+0)
  [ ] Claude Code open in another window, holdback-market MCP connected (/mcp)
  [ ] Record the window: Cmd+Shift+5 → Record Selected Window, mic on
  [ ] Space (or Next scene) advances; rerun this script for a new take
EOF
