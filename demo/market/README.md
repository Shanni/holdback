# Holdback market (demo)

A seller agent sells one-of-a-kind monkey prints and handmade goods to buyer agents, humans on the page and MCP
clients. Every offer, bid and purchase is a payment **hold** (a card authorization): captured when the deal
clears, released otherwise. API contract: `demo/API.md`.

Payments go through a `HoldProvider` (`payments.mts`). The default, `FakeCardProvider`, is an in-memory card
processor with the same rules as a real one: an authorization reserves the buyer's available credit, captures can be
partial but never exceed it, authorizations expire after 7 days, and refunds only follow a capture.

## Run

```sh
node demo/market/server.mts            # server + scripted buyer agents, open http://localhost:4022
node demo/market/seed-store.mts        # add the handmade goods for /store/
STEP=1 node demo/market/server.mts     # presenter mode: POST /api/control/next per scene
curl -XPOST localhost:4022/api/control/next
```

Tests: `npm test` (mechanism, negotiation, payments) and `npm run test:mcp` (MCP server against a real market).

## Env

| var | default | |
|---|---|---|
| `PORT` | 4022 | HTTP port |
| `PACE` | 1 | multiplier on the scripted agents' pauses (0.2 = fast) |
| `STEP` | off | `1` = one scene per `POST /api/control/next` |
| `SCENARIO` | on | `0` = no scripted agents (only Monkey #3 is listed, for humans/MCP) |
| `AUCTION_SECS` | 45 | proxy auction length |
| `DUTCH_STEP_SECS` | 6 | Dutch price drops every N seconds |
| `STALE_SECS` | 20 | default "no interest" time before a listing goes Dutch |
| `BUYER_USD` | 300 | available credit on each new buyer's demo card |

## Scenes (agents act only through the HTTP API)

1. Seller lists **Monkey #3** (ask 100, hidden floor 70, open to offers: left for humans / MCP) and **Monkey #1** (ask 100, floor 50).
2. Bo (limit 60) watches Monkey #1 → seller switches to OFFERS. Four rounds: 55→87, 58→79, 59→71, 60→66; Bo walks away and his hold is released.
3. Ada (120) and Cy (95) watch → 3 watchers → seller switches to a proxy AUCTION.
4. Cy, Bo, Ada bid their limits (each bid is a binding hold).
5. Auction closes: Ada's 120 hold is partially captured at 96 (2nd max 95 + 1), 24 released; Cy's and Bo's holds released.
6. Monkey #2 (ask 90, floor 40) is listed; nobody watches.
7. No interest → seller switches to a DUTCH auction (90, 80, 70, …).
8. Bo buys at 60.
9. A hi-res print (digital, 5 USD, 7-day money-back guarantee): Cy buys and is charged.
10. Cy asks for the 5 USD back inside the guarantee window and is refunded, no seller approval.

Pages: `/` Gallery (Listings + Holds ledger, `/#ledger`), `/store/` a Shopify-style store with the
Holdback widget embedded (`demo/public/holdback.js`). The store's shoppers appear in the Gallery next to the agents.

A human or MCP buyer can join at any time: `POST /api/buyers`, then offer / respond / bid / buy.

## Extensions beyond API.md (backward compatible)

- `POST /api/control/list {name, ask, floor?, goal?, hue?, image?, description?, kind?: "unique"|"digital"|"physical", guaranteeDays?, mechanism?: "offers", staleSecs?}`
  (seller lists an item; `staleSecs <= 0` = never goes Dutch; `guaranteeDays` defaults to 14 for physical, 7 for digital).
- `GET /api/state` (same snapshot as `/events`), `GET /api/buyers`.
- Snapshot: `seller {name, balance}` (captured, net of refunds), `scenario {mode, scene, total, running, next}`.
- Offer/respond bodies accept an optional `message` (≤280 chars): the seller agent reads it locally (rule-based
  `readMessage`, no LLM), answers it in its reply, and nudges its concession within the floor
  (hardship faster, enthusiasm firmer, rude none). Seller turns carry `read: Intent[]`. See "Buyer messages" in `demo/API.md`.
- Static files: everything in `demo/public/` is served at `/`, directories at their `index.html`
  (`/holdback.js` is the embeddable widget, `/store/` the Shopify-style demo store).
- Seller accepts an offer within 3% of ask of its standing counter ("close enough").

## Not production-ready (see docs/v2-plan.md)

No authentication: buyer ids are public and the control endpoints are open. State is in memory. Buyer cards are
created by the server. These are Phase 1 work.
