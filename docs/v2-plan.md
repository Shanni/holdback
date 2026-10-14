# Holdback v2: holds on real payment rails

Status: draft, 2026-10-13. The crypto version (Solana program, EVM escrow) is archived on the `crypto` branch with
its open bugs in `docs/known-issues.md`. v2 drops crypto.

## Goal

Keep v1's idea that every pricing mechanism is a rule about how much of a held payment to capture, and run it on
the payments people already use: cards first. A merchant installs one widget (or Shopify block, or MCP endpoint).
Buyers, whether people or agents, can make offers, bid, or buy with a guarantee, and Holdback places, captures and
releases card authorizations for them.

## Target scenarios (to confirm)

Each one needs a real merchant, or a stand-in, before we build for it.

| Scenario | Mechanism | Example merchant |
|---|---|---|
| Digital service with a money-back window | buy now + 7-day guarantee | Auspice readings |
| Pay if useful (consulting, reports) | capture after window unless disputed; judge rules partial refund | Auspice premium |
| Shopify store, make-an-offer on slow stock | offers / bargaining | demo store (`demo/public/store`) |
| Limited items, high interest | proxy auction | art / drops |
| Clearance | Dutch (falling price) | any store |
| Referral / affiliate | commission split on capture | creator referrals |
| Agent shopping on a user's behalf | any of the above, within a delegated limit | MCP buyers |

## What carries over

| Keeps | Changes |
|---|---|
| Mechanism choice and negotiation (`demo/mechanism.mts`, `demo/market/negotiation.mts`) | `Chain` (`demo/market/chain.mts`) is replaced by a `HoldProvider` |
| Market API shape (`Hold`, `Item`, `Turn`) | `Hold` gains `provider`, `providerRef`, `expiresAt`, a richer status set; amounts in minor units + currency |
| Widget (`holdback.js`), demo store, Shopify extension, MCP server | Real buyer identity and payment methods replace server-generated wallets |
| | In-memory state becomes a persisted ledger |

Removed from `main`: `programs/`, `tempo/`, `sdk/`, `tests/holdback.ts`, `migrations/`, `Anchor.toml`, Cargo and
Rust files, the Solana/Anchor dependencies, the devnet faucet logic and `mock-server.mjs`'s fake signatures.

## The core abstraction

```ts
type HoldStatus = "pending" | "held" | "captured" | "partially_captured"
                | "voided" | "refunded" | "partially_refunded" | "expired" | "disputed" | "failed";

interface HoldProvider {
  id: "stripe" | "fake";                    // later: "paypal", "adyen"
  capabilities: ProviderCapabilities;
  authorize(req: { buyer; merchant; amount; currency; paymentMethod; idempotencyKey; metadata }): Promise<Hold>;
  capture(holdId, amount, opts?: { splits? }): Promise<Hold>;   // amount ≤ authorized
  void(holdId): Promise<Hold>;                                  // release an uncaptured auth
  refund(holdId, amount?): Promise<Hold>;                       // after capture, full or partial
  sync(holdId): Promise<Hold>;                                  // reconcile from the provider
}

type ProviderCapabilities = {
  maxHoldSecs: number;        // card-not-present auths last about 7 days; verify per provider/network
  partialCapture: boolean;
  multiCapture: boolean;
  incrementalAuth: boolean;   // raise an auth instead of stacking a new one
  splits: "connect" | "none";
};
```

A `FakeCardProvider` (an in-memory state machine with a controllable clock) runs the demo and tests without network
access. `StripeProvider` uses PaymentIntents with `capture_method: manual`, plus Connect for splits. Check the
current limits (auth validity, extended authorization, multicapture, incremental auth) before relying on them.

## Mechanisms on cards

| Mechanism | How it runs | Constraint to design around |
|---|---|---|
| Offer / bargain | auth at the offer; capture on accept; void on decline/walk-away | Each new auth shows as a pending charge, so raise one auth (incremental auth) instead of stacking |
| Proxy auction | auth each bidder's max; partial capture at 2nd price + 1; void losers | The auction must close inside auth validity; long auctions need a "confirm and authorize at close" fallback |
| Dutch / buy now | automatic capture | none |
| 7-day guarantee | capture at purchase; refund on request within the window | Merchant-backed, not escrow: the merchant holds the funds. Say so in UI and docs |
| Pay if useful | auth, capture at window end unless disputed; or capture now + judge-triggered partial refund | Window over 7 days means capture-then-refund |
| Commission | Connect transfer to the referrer on capture, reversed on refund | Transfer timing vs refund window |

## Trust model

Without a contract, enforcement is the processor's rules plus Holdback's own. The pitch line "the contract enforces"
goes away, and these come in its place:
- **The buyer's limit** is enforced server-side on every authorize and capture, and later by a scoped agent payment
  credential.
- **The floor** stays server-side and hidden (now actually hidden, because nothing publishes it).
- **Guarantees and judge rulings** are merchant obligations under Holdback's terms, with the card dispute system as
  the backstop.
- **Compliance:** use Stripe Connect so funds stay with the processor and Holdback never holds money. Get advice
  before pooling funds (pay-it-forward) or acting as the judge.

## Agent buyers

- The MCP server pays with a delegated, scoped credential: one of the agent-payment schemes from Stripe, Visa,
  Mastercard or Google AP2. Check which are generally available before choosing.
- The owner's `max` maps to the credential's amount/merchant scope, so the limit holds even if the agent misbehaves.
- Step-up (3DS or owner approval) above a threshold.

## Architecture

1. `HoldProvider` + `FakeProvider` + `StripeProvider`.
2. Persisted ledger (SQLite to start, Postgres later): holds, state transitions, provider events; idempotent,
   replay-safe transitions.
3. Stripe webhooks → `sync` → ledger → SSE to the gallery and widget.
4. Scheduler: auction close, auth-expiry warnings (capture or re-auth before validity runs out), guarantee window
   end, dispute timeout.
5. Auth: merchant API keys; buyer sessions; signed widget requests. No anonymous money-moving endpoints.
6. Checkout in the widget: Stripe Elements (card, wallets) to collect a payment method once, reused for later holds.

## Phases

**Phase 0: strip crypto from main. Done 2026-10-13.** On-chain code and dependencies removed; `Chain` replaced by
`HoldProvider` + `FakeCardProvider` (`demo/market/payments.mts`); guarantees are captured at purchase and refunded
on request; the owner's limit is enforced server-side; the MCP test runs against the real server instead of a mock.

**Phase 1 + 2: real payments, no mock data. Built 2026-10-13 (Stripe test-mode run pending keys).**
`StripeProvider` (PaymentIntents with manual capture, partial capture, cancel, refunds; live keys refused without
`ALLOW_LIVE=1`); SQLite persistence for products, buyers and holds with reconciliation on startup; buyer tokens and
an admin token; merchant admin page (`/admin/`) for products with photos; card setup page (`/card/`) used by people
and by MCP agent owners; scripted agents, seeded items and placeholder art removed.
Still to do here: Stripe webhooks (authorization expired/cancelled in the dashboard), buyer accounts by email
instead of browser-held tokens, an audit log of state transitions.

**Phase 3: splits and judge.** Connect transfers for commission; judge API for pay-if-useful.

**Phase 4: agent credentials.** The MCP buyer pays through a scoped agent credential.

**Phase 5: first live merchant.** Auspice: guarantee + pay-if-useful on real cards.

## Carry-overs from the v1 review that still apply

- ~~The owner's spending limit can be bypassed~~: fixed in Phase 0 (server checks `max` on every hold).
- ~~No auth~~: buyer tokens and an admin token (Phase 1). CORS stays `*` for the widget; tokens are bearer headers.
- ~~Free account creation~~: no free funds any more; new buyers are rate-limited per IP.
- **Mechanism trust.** Shill bidding is free. A `GET` registers a watcher, and three watchers force an auction.
  Watchers should be authenticated, distinct buyers.
- **Price grinding.** Repeated floor offers walk the counter down to the floor. Auction ties go by first-insert,
  not the latest raise. `respond accept` still works after a switch to Dutch/buy-now.
- **Physical goods.** The buyer can reclaim for 14 days after shipping, with no seller dispute path.
- **In-flight wiring.** `.gitignore` excludes `store/extension/assets/holdback.js`, so a fresh clone ships a broken
  Shopify extension. `seed-store.mts` is unreferenced. API.md is missing `kind: "physical"`, `guaranteeDays` and
  `description`.

## Open questions

- Which scenario first? Auspice (we own the merchant side) is the fastest path to a real payment.
- Stripe only, or also PayPal (it also does authorize/capture, with a different honour period)?
- Fee model on top of processor fees: per capture, or a SaaS fee per merchant?
- Who judges pay-if-useful: the merchant, Holdback, or a third-party verifier agent?
- Do we keep the gallery/NFT demo at all, or rebuild the demo around the Shopify store?
