# Holdback Market API (shared contract)

One market server (`demo/market/server.mts`, default `http://localhost:4022`, `PORT` env) serves
the Gallery page, the scripted buyer agents, and the MCP server. All amounts are whole dUSDC
(numbers, 6-decimal token on-chain). Every offer, bid and purchase is an on-chain **hold**:
captured when the deal clears, refunded otherwise. Errors: HTTP 4xx `{ "error": "message" }`.

## Types
```ts
type Mechanism = "buy-now" | "offers" | "auction" | "dutch";
type HoldStatus = "held" | "captured" | "refunded";
type Hold = { id: string; itemId: string; buyer: string; kind: "offer" | "bid" | "buy";
              amount: number; captured?: number; status: HoldStatus; tx: string; settleTx?: string };
type Turn = { from: "buyer" | "seller"; buyer: string; amount: number;
              action: "offer" | "counter" | "accept" | "decline" | "walk_away"; message: string; at: string;
              read?: Intent[] };                 // seller turns: what the seller agent picked up from the buyer's message
type Intent = "hardship" | "enthusiasm" | "bundle" | "first_purchase" | "rude" | "question";
type Item = {
  id: string; name: string; hue: number; image?: string;
  mechanism: Mechanism; reason: string;          // seller agent's one-line explanation
  goal: "best-price" | "quick-sale";
  ask: number;                                   // list/target price shown to buyers (floor is never exposed)
  price?: number;                                // current Dutch price, or buy-now price
  status: "listed" | "sold" | "unsold";
  soldTo?: string; soldFor?: number; saleTx?: string;
  watchers: string[];
  auction?: { endsAt: string; bids: number; leader?: string; reserveMet: boolean };
  negotiations: Record<string, Turn[]>;          // keyed by buyer name
  holds: Hold[];
};
type Buyer = { id: string; name: string; kind: "human" | "agent" | "mcp"; max?: number;
               wallet: string; balance: number };
```

## Endpoints
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/items` | | `Item[]` |
| GET | `/api/items/:id?buyerId=` | | `Item` (also registers the buyer as a watcher → may change the mechanism) |
| POST | `/api/buyers` | `{ name, kind, max? }` | `Buyer` (server creates + funds a demo wallet: SOL for fees, 300 dUSDC) |
| GET | `/api/buyers/:buyerId` | | `Buyer & { holds: Hold[] }` |
| POST | `/api/items/:id/offer` | `{ buyerId, amount, message? }` | `{ hold, reply: Turn, item }` (seller replies at once: accept → sale captured; counter; decline → hold refunded). A new offer replaces the buyer's previous held offer on that item (old hold refunded). |
| POST | `/api/items/:id/respond` | `{ buyerId, action: "accept" \| "walk_away", message? }` | `{ hold?, reply: Turn, item }` accept = buy at the seller's last counter (new hold at that price, old one refunded, captured with NFT delivery in one tx). walk_away = refund. |
| POST | `/api/items/:id/bid` | `{ buyerId, max }` | `{ hold, item }` (proxy bid: holds `max`; winner pays 2nd max + 1, at least the reserve; losers refunded at close) |
| POST | `/api/items/:id/buy` | `{ buyerId }` | `{ hold, item }` (buy-now or current Dutch price; captured immediately with NFT delivery) |
| POST | `/api/holds/:holdId/reclaim` | `{ buyerId }` | `{ hold }` |
| POST | `/api/control/goal` | `{ itemId, goal }` | `Item` (re-runs mechanism choice) |
| POST | `/api/control/next` | | `{ step: string }` advances the scripted scenario one scene (step mode) |
| GET | `/events` | | Server-Sent Events: full snapshot `{ cluster, program, items, buyers, log }` on every change |

`log` entries: `{ t, who, text, tx? }` where `tx` is an explorer URL.

## Seller negotiation policy (server-side, floor hidden)
- offer ≥ ask → accept.  offer < floor → decline (refund) with a counter at ask.
- otherwise counter with shrinking concessions: round n counter = max(floor, ask − (ask − offer) × c_n), c = [0.3, 0.5, 0.7, 0.85]; after 4 rounds, final offer = max(floor, midpoint).
- quick-sale goal: concessions are faster (c = [0.5, 0.75, 0.9, 1]).

## Buyer messages
`message` (optional, string, ≤280 chars, trimmed) on offer / respond is stored as the buyer's turn text and read
by the seller agent with a local rule-based intent detector (`readMessage` in `demo/market/negotiation.mts`; no
LLM or network call, nothing written on-chain). The seller's reply (`reply.message`) answers it in 1–2 sentences,
still states the price, and lists the detected intents in `reply.read`. Effects never go below the hidden floor:
- hardship (student, budget, can't afford) → concession factor +0.15 this round
- enthusiasm (collector, fan, love this) → −0.1 (holds firmer)
- rude (insults) → no concession this round (counter stays at the standing price)
- question (who made, edition, rare, escrow, guarantee) → reply states item facts (1/1 edition, NFT in escrow, guarantee if any)
- bundle, first purchase → tone only
