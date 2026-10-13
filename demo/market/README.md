# Holdback market (demo)

A seller agent sells monkey NFTs to buyer agents, humans on the page and MCP clients.
Every offer, bid and purchase is an on-chain **hold**: captured with NFT delivery in one
transaction when the deal clears, refunded otherwise. API contract: `demo/API.md`.

## Run

```sh
# terminal 1 (from the repo root): local validator with the program loaded
solana-test-validator --reset --bpf-program 63hjwfJZ8vHLL97WgGezNhuJenF6orxETi2yQGbMbygU target/deploy/holdback.so

# terminal 2: market server + scripted buyer agents
node demo/market/server.mts            # open http://localhost:4022
STEP=1 node demo/market/server.mts     # presenter mode: POST /api/control/next per scene
curl -XPOST localhost:4022/api/control/next
```

Tests: `node --test demo/market/negotiation.test.mts demo/mechanism.test.mts`

## Env

| var | default | |
|---|---|---|
| `PORT` | 4022 | HTTP port |
| `RPC` | `http://127.0.0.1:8899` | contains `devnet` → devnet; wallets funded by SOL transfer from `.keys/dev-wallet.json` instead of airdrops |
| `PACE` | 1 | multiplier on the scripted agents' pauses (0.2 = fast) |
| `STEP` | off | `1` = one scene per `POST /api/control/next` |
| `SCENARIO` | on | `0` = no scripted agents (only Monkey #3 is listed, for humans/MCP) |
| `AUCTION_SECS` | 45 | proxy auction length |
| `DUTCH_STEP_SECS` | 6 | Dutch price drops every N seconds |
| `STALE_SECS` | 20 | default "no interest" time before a listing goes Dutch |
| `BUYER_USD` | 300 | dUSDC given to each new buyer wallet |

`demo/market/rails.json` (optional): extra payment rails shown in `snapshot.rails`
(array of `{id, name, status, explorer, note}`); the Solana entry is always added.

## Scenes (agents act only through the HTTP API)

1. Seller lists **Monkey #3** (ask 100, hidden floor 70, open to offers: left for humans / MCP) and **Monkey #1** (ask 100, floor 50).
2. Bo (limit 60) watches Monkey #1 → seller switches to OFFERS. Four rounds: 55→87, 58→79, 59→71, 60→66; Bo walks away and reclaims his hold.
3. Ada (120) and Cy (95) watch → 3 watchers → seller switches to a proxy AUCTION.
4. Cy, Bo, Ada bid their limits (each bid is a binding hold).
5. Auction closes: Ada pays 96 (2nd max 95 + 1) via captureSale, 24 refunded in the same tx; Cy's and Bo's holds voided.
6. Monkey #2 (ask 90, floor 40) is listed; nobody watches.
7. No interest → seller switches to a DUTCH auction (90, 80, 70, …).
8. Bo buys at 60.
9. A hi-res print (digital, 5 dUSDC, 7-day money-back guarantee): Cy buys.
10. Cy reclaims the 5 dUSDC inside the guarantee window, no seller approval.

A human or MCP buyer can join at any time: `POST /api/buyers`, then offer / respond / bid / buy.

## Extensions beyond API.md (backward compatible)

- `POST /api/control/list {name, ask, floor?, goal?, hue?, kind?: "nft"|"digital", mechanism?: "offers", staleSecs?}` (seller lists an item; `staleSecs <= 0` = never goes Dutch).
- `GET /api/state` (same snapshot as `/events`), `GET /api/buyers`.
- Item: `kind`, `guarantee`, `listing`, `nft`, `auction.price` (current 2nd-price), `auction.closed`.
- Snapshot: `seller {name, wallet, balance}`, `scenario {mode, scene, total, running, next}`, `rails`.
- Offer/respond bodies accept an optional `message` (≤280 chars): the seller agent reads it locally (rule-based
  `readMessage`, no LLM, nothing on-chain), answers it in its reply, and nudges its concession within the floor
  (hardship faster, enthusiasm firmer, rude none). Seller turns carry `read: Intent[]`. See "Buyer messages" in `demo/API.md`.
  The Gallery's You panel has a message box with three quick chips; messages show as chat bubbles.
- `Hold.tx` / `settleTx` and log `tx` are explorer URLs.
- Seller accepts an offer within 3% of ask of its standing counter ("close enough").
