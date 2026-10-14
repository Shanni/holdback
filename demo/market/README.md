# Holdback market

A seller agent sells the merchant's products to people (Gallery page, store widget) and to AI agents (MCP).
Every offer, bid and purchase is a payment **hold**, a Stripe card authorization with manual capture: captured
when the deal clears (possibly for less than was held), released otherwise. API contract: `demo/API.md`.

| File | What |
|---|---|
| `server.mts` | HTTP API, SSE, seller agent loop, auctions, holds, buyer and admin auth |
| `payments.mts` | `HoldProvider` interface and `StripeProvider` (PaymentIntents, `capture_method: manual`) |
| `db.mts` | SQLite persistence (`node:sqlite`): products, buyers, holds |
| `negotiation.mts` | Seller replies, counters, buyer-message intents |
| `../mechanism.mts` | Mechanism choice, second-price settlement, Dutch schedule |

## Run

```sh
cp .env.example .env        # add Stripe test keys: https://dashboard.stripe.com/test/apikeys
npm start                   # http://localhost:4022
```

- Merchant: open `/admin/`, paste the admin token (`ADMIN_TOKEN`, or `data/admin-token` after the first start),
  and add products.
- Buyers: open `/` (Gallery) or `/store/`; the first offer, bid or purchase asks for a card, saved with Stripe on
  the `/card/` page (test card 4242 4242 4242 4242 in test mode).
- Agents: see `mcp/README.md`.

State lives in `data/holdback.db` (gitignored). On start the server asks Stripe about every hold that was still
open, so authorizations voided or expired while it was down are marked released.

Tests: `npm test` (mechanism, negotiation), `npm run test:stripe` (provider against Stripe test mode),
`npm run test:mcp` (MCP server end to end against a real market on Stripe test mode).

## Env

| var | default | |
|---|---|---|
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` | required | test keys; live keys are refused unless `ALLOW_LIVE=1` |
| `ADMIN_TOKEN` | generated into `data/admin-token` | merchant token for `/api/admin/*` |
| `PORT` | 4022 | HTTP port |
| `PUBLIC_URL` | `http://localhost:PORT` | base for card-setup links |
| `DATA_DIR` | `data` | SQLite database and uploaded images |
| `AUCTION_SECS` | 45 | proxy auction length |
| `DUTCH_STEP_SECS` | 6 | Dutch price drops every N seconds |
| `STALE_SECS` | 20 | default "no interest" time before a unique listing goes Dutch |
| `SIGNUPS_PER_HOUR` | 20 | new buyers per IP per hour |

## How the seller agent sells

- **Unique** items are negotiable: open to offers; 3 watchers → proxy auction (`AUCTION_SECS`); no interest
  for `staleSecs` → Dutch auction down to the floor. The floor never leaves the server.
- **Digital / physical** items are fixed price, charged at purchase and refundable on request inside the
  guarantee window (a card authorization would expire before a 7–14 day window ends).
- Offer bodies accept an optional `message` (≤280 chars) that the seller agent reads locally (rule-based, no LLM)
  and answers, nudging its concession within the floor.

## Known gaps (see docs/v2-plan.md)

- No Stripe webhooks yet: changes made in the Stripe dashboard are picked up only at restart.
- Auction length must stay well under the 7-day authorization window.
- Buyer tokens are bearer secrets in the browser's localStorage; there are no buyer accounts or emails yet.
