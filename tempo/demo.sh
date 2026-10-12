#!/usr/bin/env bash
# End-to-end auth-capture demo against a deployed HoldbackEscrow.
# Usage: ./demo.sh tempo|robinhood   (or CHAIN=... ./demo.sh; run deploy.sh first)
#
#   1. winning bid:  buyer authorizes WIN_HOLD, merchant captures WIN_CAPTURE
#                    (second price), the remainder is refunded to the buyer in the same tx
#   2. losing bid:   buyer authorizes LOSE_HOLD, merchant voids it
source "$(dirname "$0")/chains.sh" "${1:-}"
source "$DEPLOYMENT_FILE"

BUYER=$(cast wallet address --private-key "$BUYER_KEY")
MERCHANT=$(cast wallet address --private-key "$MERCHANT_KEY")
LOG="$HERE/deployments/$NET-demo.log"
: > "$LOG"

# send <label> <key> <to> <sig> [args...]  -> prints explorer link, fails on revert
send() {
  local label=$1 key=$2; shift 2
  local r tx status
  r=$(cast send --rpc-url "$RPC" --private-key "$key" --json "$@")
  tx=$(echo "$r" | python3 -c "import json,sys;print(json.load(sys.stdin)['transactionHash'])")
  status=$(echo "$r" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
  printf '  %-34s %s/tx/%s\n' "$label" "$EXPLORER" "$tx" | tee -a "$LOG"
  [[ "$status" == "0x1" || "$status" == "1" ]] || { echo "  ^ reverted" >&2; exit 1; }
}
bal() { cast call "$1" "balanceOf(address)(uint256)" "$2" --rpc-url "$RPC" | awk '{print $1}'; }

echo "[$NET] escrow $EXPLORER/address/$ESCROW" | tee -a "$LOG"
echo "  buyer    $BUYER" | tee -a "$LOG"
echo "  merchant $MERCHANT" | tee -a "$LOG"

if [[ -n "$MERCHANT_GAS_TOPUP" ]]; then
  send "gas top-up -> merchant" "$BUYER_KEY" "$MERCHANT" --value "$MERCHANT_GAS_TOPUP"
fi

RUN=$(date +%s)
EXPIRY=$((RUN + 3600))   # authorizationExpiry: 1h

# ---- 1. winning bid: authorize -> capture (partial) ----
WIN_ID=$(cast keccak "holdback:$NET:win:$RUN")
hold=$(cast parse-units "$WIN_HOLD" "$WIN_DECIMALS")
cap=$(cast parse-units "$WIN_CAPTURE" "$WIN_DECIMALS")
b0=$(bal "$WIN_TOKEN" "$BUYER"); m0=$(bal "$WIN_TOKEN" "$MERCHANT")
echo "winning bid: hold $WIN_HOLD $WIN_SYMBOL, capture $WIN_CAPTURE" | tee -a "$LOG"
send "approve $WIN_HOLD $WIN_SYMBOL" "$BUYER_KEY" "$WIN_TOKEN" "approve(address,uint256)" "$ESCROW" "$hold"
send "authorize $WIN_HOLD $WIN_SYMBOL" "$BUYER_KEY" "$ESCROW" \
  "authorize(bytes32,address,address,uint256,uint64,bool)" "$WIN_ID" "$MERCHANT" "$WIN_TOKEN" "$hold" "$EXPIRY" false
send "capture $WIN_CAPTURE $WIN_SYMBOL" "$MERCHANT_KEY" "$ESCROW" "capture(bytes32,uint256)" "$WIN_ID" "$cap"
b1=$(bal "$WIN_TOKEN" "$BUYER"); m1=$(bal "$WIN_TOKEN" "$MERCHANT")
python3 - "$b0" "$b1" "$m0" "$m1" "$WIN_DECIMALS" "$WIN_SYMBOL" <<'PY' | tee -a "$LOG"
import sys; b0,b1,m0,m1,d=map(int,sys.argv[1:6]); s=sys.argv[6]; u=10**d
print(f"  buyer net {(b1-b0)/u:+} {s} (= -hold + refund), merchant net {(m1-m0)/u:+} {s}")
PY

# ---- 2. losing bid: authorize -> void ----
LOSE_ID=$(cast keccak "holdback:$NET:lose:$RUN")
hold=$(cast parse-units "$LOSE_HOLD" "$LOSE_DECIMALS")
echo "losing bid: hold $LOSE_HOLD $LOSE_SYMBOL, merchant voids" | tee -a "$LOG"
send "approve $LOSE_HOLD $LOSE_SYMBOL" "$BUYER_KEY" "$LOSE_TOKEN" "approve(address,uint256)" "$ESCROW" "$hold"
send "authorize $LOSE_HOLD $LOSE_SYMBOL" "$BUYER_KEY" "$ESCROW" \
  "authorize(bytes32,address,address,uint256,uint64,bool)" "$LOSE_ID" "$MERCHANT" "$LOSE_TOKEN" "$hold" "$EXPIRY" false
send "void" "$MERCHANT_KEY" "$ESCROW" "void(bytes32)" "$LOSE_ID"

echo "payment ids: win=$WIN_ID lose=$LOSE_ID" | tee -a "$LOG"
echo "log: $LOG"
