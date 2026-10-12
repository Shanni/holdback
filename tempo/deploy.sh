#!/usr/bin/env bash
# Deploy HoldbackEscrow.  Usage: ./deploy.sh tempo|robinhood   (or CHAIN=... ./deploy.sh)
source "$(dirname "$0")/chains.sh" "${1:-}"
cd "$HERE"

out=$(forge create src/HoldbackEscrow.sol:HoldbackEscrow \
  --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --broadcast --json)
addr=$(echo "$out" | python3 -c "import json,sys;print(json.load(sys.stdin)['deployedTo'])")
tx=$(echo "$out" | python3 -c "import json,sys;print(json.load(sys.stdin)['transactionHash'])")

mkdir -p deployments
printf 'ESCROW=%s\nDEPLOY_TX=%s\n' "$addr" "$tx" > "$DEPLOYMENT_FILE"
echo "[$NET] HoldbackEscrow deployed"
echo "  address: $EXPLORER/address/$addr"
echo "  tx:      $EXPLORER/tx/$tx"
