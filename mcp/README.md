# holdback-market MCP server

A stdio MCP server that lets Claude (Desktop or Code) shop on the Holdback market and haggle for
items live. Each offer, bid and purchase is a **hold** on the owner's card (a Stripe card authorization, in USD):
the amount is reserved but not charged, **captured** (charged) if the deal clears and **released**
(authorization voided, never charged) if it doesn't. Fixed-price digital / physical items are charged at
once and can be **refunded** within their guarantee window.

The server is a thin HTTP client of the market server (`demo/market/server.mts`, see `demo/API.md`).
On the first tool call that needs a buyer it registers one (`POST /api/buyers`, kind `mcp`, `max` = `OWNER_MAX`)
and keeps the returned buyer token in memory, sending it as `Authorization: Bearer <token>` on every buyer call.
Set `HOLDBACK_TOKEN` to reuse an existing buyer (and its saved card) instead; on registration the server prints
the new token to stderr so you can do that. It uses plain Node 22 type stripping, so there's no build step.

## Setup

1. The market needs Stripe keys. Copy `.env.example` to `.env` and fill in **test-mode** keys
   (`STRIPE_SECRET_KEY=sk_test_...`, `STRIPE_PUBLISHABLE_KEY=pk_test_...` from dashboard.stripe.com/test/apikeys).
2. Start the market and list some products from the merchant page (`/admin/`, admin token in `data/admin-token`
   or `ADMIN_TOKEN`) or with `POST /api/admin/products`. The market starts empty: there are no seeded items.
   ```sh
   node demo/market/server.mts   # http://localhost:4022
   ```
3. Add the MCP server to Claude (see Install). Claude starts `node mcp/server.mts` itself.
4. **The owner adds a card.** A new buyer has no card, and every hold is refused (`402 needsCard`) until one is
   saved. Claude calls `add_card` (or hits a hold that needs a card) and gets a setup link
   (`POST /api/me/card-setup` → `setupUrl`, valid 30 minutes). The owner opens it in a browser and saves a card
   with Stripe; saving charges nothing, and money is only captured when a deal clears. In test mode use
   4242 4242 4242 4242, any future expiry, any CVC. Card setup is always the owner's action: the MCP server never
   attaches a card by itself. To keep that card across Claude restarts, set `HOLDBACK_TOKEN`.

| Env | Default | Meaning |
|---|---|---|
| `MARKET_URL` | `http://localhost:4022` | Market server base URL |
| `BUYER_NAME` | `Claude` | Name of the buyer registered on first use (shown in the gallery / negotiation log). Ignored with `HOLDBACK_TOKEN` |
| `OWNER_MAX` | `90` | The owner's hard spending limit (USD). Sent to the market on registration (it enforces it on every hold) and also checked client-side |
| `HOLDBACK_TOKEN` | – | Buyer token of an existing buyer (from `POST /api/buyers`, or the one printed to stderr on registration). Reuses that buyer and its card; its limit is the one it was registered with |

## Tools

| Tool | Args | What it does |
|---|---|---|
| `list_items` | – | All items with kind (unique / digital / physical), mechanism (offers / auction / dutch / buy-now), ask and status, plus whether a card is saved |
| `get_item` | `id` | Details, the seller's reasoning, auction state, your negotiation and holds. Viewing registers you as a watcher, which can change the mechanism |
| `add_card` | – | A card-setup link (`setupUrl`) for the owner to open and save a card. Needed before any offer, bid or purchase; also replaces a card |
| `make_offer` | `id, amount, message?` | Places an offer as a **hold** on your card. The seller replies at once with accept (captured: you bought it), counter (hold stays held) or decline (released). To counter, call it again with a new amount; the previous hold is released |
| `respond_to_counter` | `id, action: accept \| walk_away, message?` | `accept` buys at the seller's standing price for you (the last counter, or the ask after a decline): a new hold at that price is captured at once and the old one released. `walk_away` releases the hold |
| `place_bid` | `id, max` | Proxy bid that holds `max`. The winner is charged the 2nd-highest max + 1, never more than `max`; the rest is released. Losers' holds are released. Bids are binding until the auction closes |
| `buy_now` | `id` | Buys at the buy-now price or the current Dutch price, captured right away. Digital / physical items show a `refundableUntil` time |
| `my_holds` | – | The saved card (e.g. `Visa •••• 4242`, or "no card yet"), the amount on hold, and every hold (held / captured / released / refunded) with its Stripe PaymentIntent reference |
| `reclaim` | `hold_id` | Withdraws a held offer (released, nothing charged) or refunds a guarantee purchase before `refundableUntil`. Bids can't be reclaimed |

**Prompt:** `buy_for_me(item, budget)` gives Claude a bargaining strategy: make sure a card is saved (else
`add_card` and wait for the owner), open at about 60–65% of the ask, raise in shrinking steps, accept once the
counter is within budget, and walk away otherwise. For auctions it places one proxy bid at the budget.

**No card:** when the market answers a hold with `402 needsCard`, the tool result says a card is needed and
includes a fresh setup link for the owner (nothing was held or charged). Other 402s (card declined, needs
authentication) are shown as is, with a hint to `add_card` if the owner wants a different card.

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
# add -e HOLDBACK_TOKEN=<token> to reuse a buyer (and its saved card) across restarts
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

Add `"HOLDBACK_TOKEN": "<token>"` to `env` to keep the same buyer and card across restarts.
Claude Desktop needs Node 22.6 or newer on its PATH. If `node` resolves to an older version, put the
absolute path to a Node 22 binary in `command`.

Start the market first (`node demo/market/server.mts`, with Stripe keys in `.env`) and list a product, then ask:
*"Use the buy_for_me prompt: get me the blue vase, budget 90."* The first time, Claude will hand you a card-setup
link: open it, save a card, and tell Claude to carry on.

## Test

```sh
node mcp/test.mts                                                  # starts the real market as a child
MARKET_URL=http://localhost:4022 ADMIN_TOKEN=... node mcp/test.mts # against a running test-mode market
```

The test needs Stripe **test** keys: it loads `.env` (or uses `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY`
from the environment) and, if there is no `sk_test_` key, prints `skipped: needs Stripe test keys in .env` and
exits 0 (unless `MARKET_URL` points at a running market). It refuses to run against a live-mode market.

It starts `demo/market/server.mts` on port 4095 (`TEST_PORT`) with a fresh temp `DATA_DIR` and its own
`ADMIN_TOKEN`, and seeds two negotiable unique items (ask 100, floor 60, open to offers) and a physical item
(ask 40) through `POST /api/admin/products`. Then, over stdio with the SDK `Client`:

- **No card:** an MCP server that registers its own buyer on first use. `list_items` says there is no card,
  `buy_now` returns "a card is needed" with a setup URL (the code is checked against `GET /api/card-setup/:code`
  and the page is fetched), `add_card` returns a `setupUrl`, `my_holds` says "no card yet", and no hold exists.
- **With a card:** the test registers a buyer itself (`max` 90, kind `mcp`), attaches Stripe's test Visa with
  `POST /api/me/test-card`, and starts a second MCP server with `HOLDBACK_TOKEN`. Tools and prompt, list → get →
  over-limit offer/bid rejection → a lowball offer that gets declined followed by an accept that must be refused
  (the ask is above `OWNER_MAX`, nothing captured) → offer (counter) → offer with a note → offer again → accept
  (or walk away if the seller stays above the limit) → physical `buy_now` → `reclaim` (refunded) → `my_holds`
  with the card label. It asserts that superseded offers were released, the deal captured, the physical purchase
  refunded, and that no hold is left dangling.

The child market and the temp directory are removed at the end. `VERBOSE=1` shows the market log and raw JSON.

## Sample output

```
> buy_now({"id":"mug"})  [isError]
A card is needed: your owner has not saved a card for you yet, so the market cannot place this hold (nothing was held or charged).
Ask your owner (the human you are buying for) to open this link in a browser and save a card:
  http://localhost:4022/card/?code=Qm9vb...
The link is valid for 30 minutes. Saving the card charges nothing: offers and bids are only authorized (held) on it, and money is captured only when a deal clears.
Card setup is the owner's action: do not try to enter card details yourself. Once they say it is saved, retry.
This market runs in Stripe TEST mode: the owner can use the test card 4242 4242 4242 4242 with any future expiry date and any CVC. No real money moves.

> make_offer({"id":"decline-test","amount":30})
SELLER DECLINES (asks 100 USD)
>> Seller: 30 is too low for me. Your hold is released. The asking price is 100.

You offered 30 USD on Decline Test.
- hold pi_3Q... (offer on decline-test): RELEASED 30 USD (authorization voided, never charged)
Your offer was declined and your hold released (nothing charged). The seller's price for you is now the ask,
100 USD, above your owner's limit: offer again up to 90 or walk away.

> respond_to_counter({"id":"decline-test","action":"accept"})  [isError]
Refused: accepting the seller's price of 100 USD is above your owner's limit of 90 USD (OWNER_MAX). You may not
commit more than 90 USD on any item. Try an amount ≤ 90, or walk away.

> my_holds({})
Claude, paying with Visa •••• 4242
currently on hold: 0 USD | owner limit: 90 USD
- hold pi_3Q... (offer on decline-test): RELEASED 30 USD (authorization voided, never charged)
- hold pi_3Q... (offer on bargain-test): CHARGED 87 USD (captured)
- hold pi_3Q... (buy on physical-test): REFUNDED 40 USD back to your card
```
