# holdback-market MCP server

A stdio MCP server that lets Claude (Desktop or Code) shop on the Holdback market and haggle for
items live. Each offer, bid and purchase is a **hold** on the buyer's card (a card authorization, in USD):
the amount is reserved but not charged, **captured** (charged) if the deal clears and **released**
(authorization voided, never charged) if it doesn't. Fixed-price digital / physical items are charged at
once and can be **refunded** within their guarantee window.

The server is a thin HTTP client of the market server (`demo/market/server.mts`, see `demo/API.md`).
On the first tool call it registers itself as a buyer (`POST /api/buyers`, kind `mcp`, `max` = `OWNER_MAX`),
and the market gives that buyer a demo card with some available credit. Payments run through the market's
fake card processor, so nothing else needs to be running. It uses plain Node 22 type stripping, so there's
no build step:

```sh
node demo/market/server.mts   # the market, http://localhost:4022
node mcp/server.mts           # usually started by Claude instead (see Install)
```

| Env | Default | Meaning |
|---|---|---|
| `MARKET_URL` | `http://localhost:4022` | Market server base URL |
| `BUYER_NAME` | `Claude` | Buyer name shown in the gallery / negotiation log |
| `OWNER_MAX` | `90` | The owner's hard spending limit (USD). Sent to the market, which enforces it on every hold, and also checked client-side |

## Tools

| Tool | Args | What it does |
|---|---|---|
| `list_items` | – | All items with kind (unique / digital / physical), mechanism (offers / auction / dutch / buy-now), ask and status |
| `get_item` | `id` | Details, the seller's reasoning, auction state, your negotiation and holds. Viewing registers you as a watcher, which can change the mechanism |
| `make_offer` | `id, amount, message?` | Places an offer as a **hold** on your card. The seller replies at once with accept (captured: you bought it), counter (hold stays held) or decline (released). To counter, call it again with a new amount; the previous hold is released |
| `respond_to_counter` | `id, action: accept \| walk_away, message?` | `accept` buys at the seller's standing price for you (the last counter, or the ask after a decline): a new hold at that price is captured at once and the old one released. `walk_away` releases the hold |
| `place_bid` | `id, max` | Proxy bid that holds `max`. The winner is charged the 2nd-highest max + 1, never more than `max`; the rest is released. Losers' holds are released. Bids are binding until the auction closes |
| `buy_now` | `id` | Buys at the buy-now price or the current Dutch price, captured right away. Digital / physical items show a `refundableUntil` time |
| `my_holds` | – | The card, its available credit, and every hold (held / captured / released / refunded) with its processor reference |
| `reclaim` | `hold_id` | Withdraws a held offer (released, nothing charged) or refunds a guarantee purchase before `refundableUntil`. Bids can't be reclaimed |

**Prompt:** `buy_for_me(item, budget)` gives Claude a bargaining strategy: open at about 60–65% of the ask,
raise in shrinking steps, accept once the counter is within budget, and walk away otherwise. For auctions it
places one proxy bid at the budget.

**Owner limit:** any offer, bid, buy or acceptance above `OWNER_MAX` is refused before it reaches the market.
For `respond_to_counter(accept)` the check uses the price that would actually be accepted: the amount of the
seller's latest turn, whatever its action (after a decline that is the full ask). The market enforces the
same limit on every hold as a second line of defence. The refusal reads like this: *"Refused: offering 140 USD
is above your owner's limit of 90 USD (OWNER_MAX)…"*

`message` (optional, ≤280 chars) is a note to the seller; the seller agent answers it, and the reply is shown first
(`>> Seller: …`) together with how the seller read the note.

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

Start the market first (`node demo/market/server.mts`), then ask: *"Use the buy_for_me prompt: get me Monkey #3, budget 90."*

## Test

```sh
node mcp/test.mts                                     # starts the real market as a child (PORT 4095, SCENARIO=0)
MARKET_URL=http://localhost:4022 node mcp/test.mts    # against a market that is already running
```

The test starts `demo/market/server.mts`, waits for `GET /api/state`, and seeds two negotiable unique items
(ask 100, floor 60, `mechanism: "offers"`) and a physical item through `POST /api/control/list`. It then drives
the MCP server over stdio with the SDK `Client`: tools and prompt, list → get → over-limit offer/bid rejection →
a lowball offer that gets declined followed by an accept that must be refused (the ask is above `OWNER_MAX`,
nothing captured) → offer (counter) → offer with a note → offer again → accept → physical `buy_now` → `reclaim`
(refunded) → `my_holds`. It asserts that superseded offers were released, the winning hold captured, the
physical purchase refunded, and that no hold is left dangling.

## Sample transcript (from `node mcp/test.mts`)

```
> make_offer({"id":"decline-test","amount":30})
SELLER DECLINES (asks 100 USD)
>> Seller: 30 is too low for me. Your hold is released. The asking price is 100.

You offered 30 USD on Decline Test.
- hold auth_2 (offer on decline-test): RELEASED 30 USD (authorization voided, never charged)
Your offer was declined and your hold released (nothing charged). The seller's price for you is now the ask,
100 USD, above your owner's limit: offer again up to 90 or walk away.

> respond_to_counter({"id":"decline-test","action":"accept"})  [isError]
Refused: accepting the seller's price of 100 USD is above your owner's limit of 90 USD (OWNER_MAX). You may not
commit more than 90 USD on any item. Try an amount ≤ 90, or walk away.

> make_offer({"id":"bargain-test","amount":82})
SELLER COUNTERS at 87 USD
>> Seller: Meeting you partway: 87 USD.

You offered 82 USD on Bargain Test.
- hold auth_5 (offer on bargain-test): HELD 82 USD on your card (authorized, not charged yet)
Next: make_offer again with a higher amount to keep bargaining, respond_to_counter(accept) to buy at 87 USD,
or respond_to_counter(walk_away) to release your hold.

> respond_to_counter({"id":"bargain-test","action":"accept"})
>> Seller: Deal at 87 USD. It's yours.

You accepted the seller's price on Bargain Test.
- hold auth_6 (offer on bargain-test): CHARGED 87 USD (captured)
You own Bargain Test: charged 87 USD.

> buy_now({"id":"physical-test"})
Bought Physical Test.
- hold auth_7 (buy on physical-test): CHARGED 40 USD (captured), refundable until 2026-10-27T22:36:12.702Z
Refund guarantee: reclaim("auth_7") before 2026-10-27T22:36:12.702Z for your money back, no seller approval needed.

> reclaim({"hold_id":"auth_7"})
Refunded to your card.
- hold auth_7 (buy on physical-test): REFUNDED 40 USD back to your card

> my_holds({})
Claude, paying with Demo card •••• 7838
available credit: 213 USD | currently on hold: 0 USD | owner limit: 90 USD
- hold auth_2 (offer on decline-test): RELEASED 30 USD (authorization voided, never charged)
- hold auth_3 (offer on bargain-test): RELEASED 75 USD (authorization voided, never charged)
- hold auth_5 (offer on bargain-test): RELEASED 82 USD (authorization voided, never charged)
- hold auth_6 (offer on bargain-test): CHARGED 87 USD (captured)
- hold auth_7 (buy on physical-test): REFUNDED 40 USD back to your card
```
