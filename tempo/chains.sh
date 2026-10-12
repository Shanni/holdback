# Sourced by deploy.sh / demo.sh. Chain = first arg or $CHAIN (tempo | robinhood | local).
# Private keys are read into variables only; they are never echoed.
set -euo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NET="${1:-${CHAIN:-tempo}}"
unset CHAIN   # foundry also reads $CHAIN (as --chain); keep it out of forge/cast

json_key() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));d=d[0] if isinstance(d,list) else d;print(d['private_key'])" "$1"; }

case "$NET" in
  tempo)
    # Moderato testnet. No native gas token: fees are paid in a USD TIP-20.
    # Plain EVM txs (what this cast version sends) fall back to pathUSD for fees
    # unless the account set a preference on the FeeManager, so every signer needs
    # pathUSD from the faucet (`tempo_fundAddress` gives pathUSD + AlphaUSD + ...).
    RPC=https://rpc.moderato.tempo.xyz
    EXPLORER=https://explore.testnet.tempo.xyz
    DEPLOYER_KEY="$(cat "$HERE/.keys/deployer")"
    BUYER_KEY="$(cat "$HERE/.keys/buyer")"
    MERCHANT_KEY="$(cat "$HERE/.keys/merchant")"
    # Winning NFT bid: hold 100 AlphaUSD, capture 96 (second price), 4 refunded.
    WIN_TOKEN=0x20c0000000000000000000000000000000000001; WIN_SYMBOL=AlphaUSD; WIN_DECIMALS=6
    WIN_HOLD=100; WIN_CAPTURE=96
    # Losing bid: hold 50 AlphaUSD, merchant voids.
    LOSE_TOKEN=$WIN_TOKEN; LOSE_SYMBOL=$WIN_SYMBOL; LOSE_DECIMALS=6; LOSE_HOLD=50
    MERCHANT_GAS_TOPUP=""   # merchant pays its own fees in faucet pathUSD
    ;;
  robinhood)
    # Robinhood Chain testnet (Arbitrum Orbit). Native gas is ETH.
    RPC=https://rpc.testnet.chain.robinhood.com
    EXPLORER=https://explorer.testnet.chain.robinhood.com
    DEPLOYER_KEY="$(json_key "$HERE/../.keys/robinhood-deployer.json")"
    BUYER_KEY="$DEPLOYER_KEY"   # deployer doubles as the bidder
    MERCHANT_KEY="$(cat "$HERE/.keys/robinhood-merchant")"
    # Bid on the monkey NFT with tokenized stock: hold 3 TSLA, capture 2.5, 0.5 refunded.
    WIN_TOKEN=0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e; WIN_SYMBOL=TSLA; WIN_DECIMALS=18
    WIN_HOLD=3; WIN_CAPTURE=2.5
    # Losing bid: hold 1 AMZN, merchant voids.
    LOSE_TOKEN=0x5884ad2f920c162cfbbacc88c9c51aa75ec09e02; LOSE_SYMBOL=AMZN; LOSE_DECIMALS=18; LOSE_HOLD=1
    MERCHANT_GAS_TOPUP=0.001ether   # merchant needs a little ETH for capture/void
    ;;
  local)
    # Dry run against `anvil` with its well-known dev keys (#0 deployer/buyer, #1 merchant).
    # LOCAL_TOKEN must be an ERC-20 the buyer holds, e.g. test/HoldbackEscrow.t.sol:MockUSD.
    RPC=http://127.0.0.1:8545
    EXPLORER=local
    DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
    BUYER_KEY=$DEPLOYER_KEY
    MERCHANT_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
    WIN_TOKEN=$LOCAL_TOKEN; WIN_SYMBOL=mUSD; WIN_DECIMALS=6; WIN_HOLD=100; WIN_CAPTURE=96
    LOSE_TOKEN=$LOCAL_TOKEN; LOSE_SYMBOL=mUSD; LOSE_DECIMALS=6; LOSE_HOLD=50
    MERCHANT_GAS_TOPUP=""
    ;;
  *) echo "unknown chain $NET (expected tempo|robinhood|local)" >&2; exit 1 ;;
esac

DEPLOYMENT_FILE="$HERE/deployments/$NET.env"
