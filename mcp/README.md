# holdback-market MCP server

A stdio MCP server that lets Claude (Desktop or Code) shop on the Holdback market and haggle for
monkey NFTs live. Each offer, bid and purchase is an escrow **hold** on Solana: the amount is locked
from the buyer's wallet, **captured** if the deal clears and **refunded** if it doesn't.

The server is a thin HTTP client of the market server (`demo/market/server.mts`, see `demo/API.md`).
On the first tool call it registers itself as a buyer (`POST /api/buyers`, kind `mcp`), and the market
gives that buyer a funded demo wallet. It runs with plain Node 22 type stripping, so there's no build step:

```sh
node mcp/server.mts
```

| Env | Default | Meaning |
|---|---|---|
| `MARKET_URL` | `http://localhost:4022` | Market server base URL |
| `BUYER_NAME` | `Claude` | Buyer name shown in the gallery / negotiation log |
| `OWNER_MAX` | `90` | The owner's hard spending limit (dUSDC). Sent to the market, and also enforced client-side |

## Tools

| Tool | Args | What it does |
|---|---|---|
| `list_items` | – | All NFTs with mechanism (offers / auction / dutch / buy-now), ask and status |
| `get_item` | `id` | Details, the seller's reasoning, auction state, your negotiation and holds. Viewing registers you as a watcher, which can change the mechanism |
| `make_offer` | `id, amount` | Places an offer as a **hold**. The seller replies at once with accept (captured, NFT delivered), counter (hold stays held) or decline (refunded). To counter, call it again with a new amount; the previous hold is refunded |
| `respond_to_counter` | `id, action: accept \| walk_away` | `accept` buys at the seller's last counter (new hold captured, old one refunded, in one tx). `walk_away` refunds the hold |
| `place_bid` | `id, max` | Proxy bid that holds `max`. The winner pays the 2nd-highest max + 1 and never more than `max`. Losers are refunded |
| `buy_now` | `id` | Buys at the buy-now price or the current Dutch price, captured right away |
| `my_holds` | – | Balance plus every hold (held / captured / refunded) with explorer tx links |
| `reclaim` | `hold_id` | Refunds a stale held hold |

**Prompt:** `buy_for_me(item, budget)` gives Claude a bargaining strategy: open at about 60–65% of the ask,
raise in shrinking steps, accept once the counter is within budget, and walk away otherwise. For auctions it
places one proxy bid at the budget.

**Owner limit:** any offer, bid, buy or counter-acceptance above `OWNER_MAX` is refused before it reaches
the market. The refusal reads like this: *"Refused: offering 140 dUSDC is above your owner's limit of 90 dUSDC
(OWNER_MAX)…"*

Each tool returns a short human-readable summary first, then `---` and the raw JSON.

## Install (not done automatically)

Claude Code:

```sh
claude mcp add holdback-market \
  -e MARKET_URL=http://localhost:4022 -e BUYER_NAME=Claude -e OWNER_MAX=90 \
  -- node /Users/shanliu/idea-2026/holdback/mcp/server.mts
```

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "holdback-market": {
      "command": "node",
      "args": ["/Users/shanliu/idea-2026/holdback/mcp/server.mts"],
      "env": { "MARKET_URL": "http://localhost:4022", "BUYER_NAME": "Claude", "OWNER_MAX": "90" }
    }
  }
}
```

Claude Desktop needs Node 22.6 or newer on its PATH. If `node` resolves to an older version, put the
absolute path to a Node 22 binary in `command`.

Then ask: *"Use the buy_for_me prompt: get me the Golden Monkey, budget 90."*

## Test

```sh
node mcp/test.mts                                     # starts the in-memory mock market on :4041
MARKET_URL=http://localhost:4022 node mcp/test.mts    # against the real market (must already be running)
node mcp/mock-market.mts                              # mock only, for manual poking (PORT env)
```

The test drives the server over stdio with the SDK `Client`. It checks the tools and prompt, then runs list →
get → over-limit offer/bid rejection → offer (counter) → offer again → accept → my_holds. Finally it asserts
that the superseded holds were refunded and the winning hold was captured.

## Sample transcript (mock market)

```
> make_offer({"id":"golden-monkey","amount":140})  [isError]
Refused: offering 140 dUSDC is above your owner's limit of 90 dUSDC (OWNER_MAX). You may not commit
more than 90 dUSDC on any item. Try an amount ≤ 90, or walk away.

> make_offer({"id":"golden-monkey","amount":71})
You offered 71 dUSDC on Golden Monkey.
- hold h1 (offer on golden-monkey): HELD 71 dUSDC in escrow — tx: https://explorer.solana.com/tx/MOCK00000001?cluster=devnet
Seller COUNTERS at 88 dUSDC: "I can do 88."
Next: make_offer again with a higher amount to keep bargaining, respond_to_counter(accept) to buy at
88 dUSDC, or respond_to_counter(walk_away) to get your hold refunded.

> make_offer({"id":"golden-monkey","amount":80})
You offered 80 dUSDC on Golden Monkey.
- hold h2 (offer on golden-monkey): HELD 80 dUSDC in escrow — tx: …MOCK00000003
Seller COUNTERS at 88 dUSDC: "I can do 88."

> respond_to_counter({"id":"golden-monkey","action":"accept"})
You accepted the seller's counter on Golden Monkey.
- hold h3 (offer on golden-monkey): CAPTURED 88 dUSDC (paid to seller) — tx: …MOCK00000005 | settle tx: …MOCK00000006
Seller: "Sold at 88. Enjoy!"
You own Golden Monkey — paid 88 dUSDC.

> my_holds({})
Claude — wallet MockWallet1
balance: 212 dUSDC | currently held in escrow: 0 dUSDC | owner limit: 90 dUSDC
- hold h1 (offer on golden-monkey): REFUNDED 71 dUSDC back to your wallet
- hold h2 (offer on golden-monkey): REFUNDED 80 dUSDC back to your wallet
- hold h3 (offer on golden-monkey): CAPTURED 88 dUSDC (paid to seller)
```
