# Holdback Market API (shared contract)

One market server (`demo/market/server.mts`, default `http://localhost:4022`) serves the Gallery page, the store
widget, the merchant admin page, the card-setup page and the MCP server. All amounts are USD (numbers).
Every offer, bid and purchase is a payment **hold**: a Stripe card authorization (PaymentIntent with manual
capture), captured when the deal clears, released otherwise. Products, buyers and holds persist in SQLite.
Errors: HTTP 4xx/5xx `{ "error": "message", ...extra }`.

## Auth

- **Buyer token.** `POST /api/buyers` returns a `token` once. Every buyer action sends
  `Authorization: Bearer <token>`; the buyer is whoever the token belongs to (a `buyerId` in the body must match it).
  Clients keep the token (the page and widget in `localStorage`, the MCP server in memory).
- **Admin token.** `/api/admin/*` needs `Authorization: Bearer <ADMIN_TOKEN>` (env, or generated into
  `data/admin-token` on first start).
- CORS is open (`*`) because the widget runs on store domains; tokens are bearer headers, never cookies.

## Types
```ts
type Mechanism = "buy-now" | "offers" | "auction" | "dutch";
type HoldStatus = "held"        // authorized on the buyer's card, nothing charged yet
                | "captured"    // charged (all or part of the authorization; the rest is released)
                | "released"    // authorization voided: declined/withdrawn offer, losing bid. Never charged
                | "refunded";   // charged, then money returned (guarantee refund)
type Hold = { id: string; itemId: string; buyer: string; kind: "offer" | "bid" | "buy";
              amount: number; captured?: number; refunded?: number; status: HoldStatus;
              ref: string;                  // Stripe PaymentIntent id
              refundableUntil?: string;     // guarantee purchases
              at: string; settledAt?: string };
type Turn = { from: "buyer" | "seller"; buyer: string; amount: number;
              action: "offer" | "counter" | "accept" | "decline" | "walk_away"; message: string; at: string;
              read?: Intent[] };                 // seller turns: what the seller agent picked up from the buyer's message
type Intent = "hardship" | "enthusiasm" | "bundle" | "first_purchase" | "rude" | "question";
type Item = {
  id: string; name: string; image?: string; description?: string;
  hue: number;                                   // stable colour for a placeholder when there is no image
  kind: "unique" | "digital" | "physical";      // unique: one of a kind, negotiable; digital/physical: fixed price + guarantee
  mechanism: Mechanism; reason: string;          // seller agent's one-line explanation
  goal: "best-price" | "quick-sale";
  ask: number;                                   // list/target price shown to buyers (floor is never exposed)
  price?: number;                                // current Dutch price, or buy-now price
  guarantee?: string;                            // e.g. "14 days"
  status: "listed" | "sold" | "unsold";
  soldTo?: string; soldFor?: number;
  watchers: string[];
  auction?: { endsAt: string; bids: number; leader?: string; reserveMet: boolean; price?: number; closed?: boolean };
  negotiations: Record<string, Turn[]>;          // keyed by buyer name
  holds: Hold[];
};
type Buyer = { id: string; name: string; kind: "human" | "agent" | "mcp";
               max?: number;                     // owner's limit, enforced by the server on every hold
               hasCard: boolean };
type Me = Buyer & { card?: string; holds: Hold[] };   // card: "Visa •••• 4242"
type AdminProduct = Item & { floor: number; staleSecs: number };
```

## Endpoints

Public:
| Method | Path | Returns |
|---|---|---|
| GET | `/api/config` | `{ provider: { id, name, mode: "test" \| "live", capabilities }, publishableKey }` |
| GET | `/api/items` | `Item[]` |
| GET | `/api/items/:id` | `Item` (with a buyer token, also registers that buyer as a watcher → may change the mechanism) |
| GET | `/api/state` | snapshot `{ provider, items, buyers: Buyer[], log, seller: { name, balance } }` |
| GET | `/events` | Server-Sent Events: the snapshot on every change |
| GET | `/api/buyers` | `Buyer[]` |

Buyer (Bearer buyer token, except `POST /api/buyers` and the card-setup code routes):
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/buyers` | `{ name, kind, max? }` | `Me & { token }` (new Stripe customer; no card yet). Rate-limited per IP |
| GET | `/api/me` (or `/api/buyers/:ownId`) | | `Me` |
| POST | `/api/me/card-setup` | | `{ code, setupUrl, expiresInSecs }`: open `setupUrl` (the `/card/` page) to add a card; valid 30 min |
| POST | `/api/me/test-card` | | `{ card }` test mode only: attaches Stripe's test Visa without a browser |
| GET | `/api/card-setup/:code` | | `{ buyer, clientSecret, publishableKey, mode }` (used by `/card/`) |
| POST | `/api/card-setup/:code/complete` | | `{ card }` after Stripe.js confirms the SetupIntent |
| POST | `/api/items/:id/offer` | `{ amount, message? }` | `{ hold, reply: Turn, item }` accept → captured; counter; decline → released. A new offer replaces the buyer's previous held offer |
| POST | `/api/items/:id/respond` | `{ action: "accept" \| "walk_away", message? }` | `{ hold?, reply, item }` accept = buy at the seller's standing price for this buyer (offers mode only). walk_away = release |
| POST | `/api/items/:id/bid` | `{ max }` | `{ hold, item }` proxy bid: holds `max`; winner pays 2nd max + 1 (at least the floor) by partial capture; losers released |
| POST | `/api/items/:id/buy` | | `{ hold, item }` buy-now, current Dutch price, or a fixed-price item (captured at once) |
| POST | `/api/holds/:holdId/reclaim` | | `{ hold }` held offer → released; guarantee purchase inside the window → refunded; bids → 400 |

A hold needs a card: without one the server answers **402** `{ error, needsCard: true }`. A declined card or one
that needs authentication is also 402. Any hold above the buyer's `max` is 400.

Merchant (Bearer admin token):
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/admin/products` | | `AdminProduct[]` |
| POST | `/api/admin/products` | `{ name, ask, kind?, floor?, guaranteeDays?, description?, image?, goal?, staleSecs?, openToOffers? }` | `AdminProduct`. `image` is a `data:image/...;base64,` upload (≤ 4 MB, served from `/uploads/`) or an http(s) URL. `floor` defaults to 60% of `ask` (unique only). `guaranteeDays` defaults to 14 (physical) / 7 (digital) |
| POST | `/api/admin/products/:id` | `{ goal?, description?, image? }` | `AdminProduct` (goal change re-runs the mechanism choice) |
| POST | `/api/admin/products/:id/delist` | | `AdminProduct` (takes it down; open holds are released) |

`log` entries: `{ t, who, text }`. `capabilities`: `{ maxHoldSecs, partialCapture, multiCapture, incrementalAuth }`.

## Seller negotiation policy (server-side, floor hidden)
- offer ≥ ask → accept.  offer < floor → decline (refund) with a counter at ask.
- otherwise counter with shrinking concessions: round n counter = max(floor, ask − (ask − offer) × c_n), c = [0.3, 0.5, 0.7, 0.85]; after 4 rounds, final offer = max(floor, midpoint).
- quick-sale goal: concessions are faster (c = [0.5, 0.75, 0.9, 1]).

## Buyer messages
`message` (optional, string, ≤280 chars, trimmed) on offer / respond is stored as the buyer's turn text and read
by the seller agent with a local rule-based intent detector (`readMessage` in `demo/market/negotiation.mts`; no
LLM or network call). The seller's reply (`reply.message`) answers it in 1–2 sentences,
still states the price, and lists the detected intents in `reply.read`. Effects never go below the hidden floor:
- hardship (student, budget, can't afford) → concession factor +0.15 this round
- enthusiasm (collector, fan, love this) → −0.1 (holds firmer)
- rude (insults) → no concession this round (counter stays at the standing price)
- question (who made, edition, rare, escrow, guarantee) → reply states item facts (1/1 edition, how the hold works, guarantee if any)
- bundle, first purchase → tone only
