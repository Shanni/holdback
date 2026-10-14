# Holdback Market API (shared contract)

One market server (`demo/market/server.mts`, default `http://localhost:4022`, `PORT` env) serves
the Gallery page, the demo store, the scripted buyer agents, and the MCP server. All amounts are whole USD
(numbers). Every offer, bid and purchase is a payment **hold** (a card authorization): captured when the deal
clears, released otherwise. Payments go through a `HoldProvider` (`demo/market/payments.mts`); the default is an
in-memory fake card processor. Errors: HTTP 4xx `{ "error": "message" }`.

## Types
```ts
type Mechanism = "buy-now" | "offers" | "auction" | "dutch";
type HoldStatus = "held"        // authorized on the buyer's card, nothing charged yet
                | "captured"    // charged (all or part of the authorization; the rest is released)
                | "released"    // authorization voided: declined/withdrawn offer, losing bid. Never charged
                | "refunded";   // charged, then money returned (guarantee refund)
type Hold = { id: string; itemId: string; buyer: string; kind: "offer" | "bid" | "buy";
              amount: number; captured?: number; refunded?: number; status: HoldStatus;
              ref: string;                  // payment processor reference
              refundableUntil?: string;     // guarantee purchases
              at: string; settledAt?: string };
type Turn = { from: "buyer" | "seller"; buyer: string; amount: number;
              action: "offer" | "counter" | "accept" | "decline" | "walk_away"; message: string; at: string;
              read?: Intent[] };                 // seller turns: what the seller agent picked up from the buyer's message
type Intent = "hardship" | "enthusiasm" | "bundle" | "first_purchase" | "rude" | "question";
type Item = {
  id: string; name: string; hue: number; image?: string; description?: string;
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
               card: string;                     // payment method label
               balance: number };                // available credit on that card
```

## Endpoints
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/items` | | `Item[]` |
| GET | `/api/items/:id?buyerId=` | | `Item` (also registers the buyer as a watcher → may change the mechanism) |
| POST | `/api/buyers` | `{ name, kind, max? }` | `Buyer` (server creates a demo card with `BUYER_USD`, default 300, available) |
| GET | `/api/buyers/:buyerId` | | `Buyer & { holds: Hold[] }` |
| POST | `/api/items/:id/offer` | `{ buyerId, amount, message? }` | `{ hold, reply: Turn, item }` (seller replies at once: accept → captured; counter; decline → hold released). A new offer replaces the buyer's previous held offer on that item (old hold released). |
| POST | `/api/items/:id/respond` | `{ buyerId, action: "accept" \| "walk_away", message? }` | `{ hold?, reply: Turn, item }` accept = buy at the seller's standing price for this buyer (new hold at that price, old one released, captured). walk_away = release. |
| POST | `/api/items/:id/bid` | `{ buyerId, max }` | `{ hold, item }` (proxy bid: holds `max`; winner pays 2nd max + 1, at least the floor, by partial capture; losers released at close) |
| POST | `/api/items/:id/buy` | `{ buyerId }` | `{ hold, item }` (buy-now, current Dutch price, or a fixed-price item; captured immediately) |
| POST | `/api/holds/:holdId/reclaim` | `{ buyerId }` | `{ hold }` held offer → released; guarantee purchase inside the window → refunded; bids → 400 (binding until the auction closes) |
| POST | `/api/control/goal` | `{ itemId, goal }` | `Item` (re-runs mechanism choice) |
| POST | `/api/control/next` | | `{ step: string }` advances the scripted scenario one scene (step mode) |
| GET | `/events` | | Server-Sent Events: full snapshot `{ provider, items, buyers, log, seller, scenario }` on every change |

`log` entries: `{ t, who, text }`. `provider`: `{ id, name, capabilities: { maxHoldSecs, partialCapture, multiCapture, incrementalAuth } }`.

Any hold above the buyer's `max` is rejected with 400, whatever path led to it (offer, accept, bid, buy).

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
