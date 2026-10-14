# Holdback

**Flexible pricing on ordinary card payments. Every offer, bid and purchase is a hold, captured only when the deal clears.**

> The crypto version (Solana program + EVM escrow, the Crypto World's Fair submission) is archived on the
> [`crypto`](../../tree/crypto) branch. `main` moves to card and other non-crypto payments; see
> [docs/v2-plan.md](docs/v2-plan.md).

Software and small shops mostly sell one way: a fixed price, take it or leave it. Real markets bargain, run
auctions, discount slow stock and offer money-back guarantees, and now AI agents can do that bargaining for
people. Card networks already have the primitive that makes it safe: **authorize now, capture later, capture
less than you authorized, or release it**. Holdback turns that primitive into sales mechanisms:

> Auctions, offers, discounts and guarantees are all the same thing: **rules about how much of a held payment to capture.**

| Mechanism | Hold | Capture | Back to the buyer |
|---|---|---|---|
| Make an offer / bargain | each offer | when the seller accepts | declined, withdrawn or replaced → released, never charged |
| Proxy auction (second price) | each bidder's max | winner pays 2nd max + 1 (partial capture) | the rest of the winner's hold, every losing bid |
| Dutch auction (price falls) | current price | immediately | — |
| Buy now + money-back guarantee | price | at purchase | refunded on request inside the window |

A **seller agent** picks the mechanism from demand (one watcher → offers, three → auction, none → Dutch) and
switches as demand changes. It negotiates against a private floor. **Buyer agents** bargain within their owner's
limit, which the server enforces on every hold. Humans join through the web page or the store widget, and any
MCP-capable agent (Claude Desktop, Claude Code) joins through the `holdback-market` MCP server.

## How it fits together

```
 People: Gallery page, store widget          Agents: Claude via MCP, scripted buyer agents
              │                                          │
              └────────────► Holdback market server ◄────┘
                    seller agent (mechanism choice) + negotiation engine
                                    │  every offer / bid / purchase = HOLD
                                    ▼
                         HoldProvider (payments.mts)
                 FakeCardProvider today · Stripe (manual capture) next
```

## Run it

Requirements: Node 22.18+ (runs `.mts` files directly), npm or pnpm.

```bash
pnpm install
npm test                          # mechanism, negotiation and payment-provider tests
npm run test:mcp                  # MCP server end to end against a real market
npm start                         # market server + scripted buyers, open http://localhost:4022
npm run seed:store                # add handmade goods, then open http://localhost:4022/store/
```

No external services are needed: payments run on an in-memory card processor with real card rules
(authorizations reserve credit, partial capture, 7-day expiry, refunds only after capture).

## Add it to a store

The plugin is one script and one mount point. It renders in Shadow DOM, so the store's CSS can't break it,
and it fires `holdback:hold`, `holdback:purchase`, `holdback:release` (hold voided, never charged) and
`holdback:refund` (charged, then refunded) events for the store to react to.

```html
<script src="https://YOUR-MARKET/holdback.js" defer></script>
<div data-holdback-item="monkey-3"></div>
```

On Shopify it ships as a theme app extension (`demo/public/store/extension/`): the merchant adds the
**Holdback offers & bids** block under Buy it now in the theme editor. Run `npm run shopify:assets` to copy the
widget into the extension before deploying it.

## Repository

| Path | What |
|---|---|
| `demo/mechanism.mts` | Seller agent: mechanism choice, offer response, second-price settlement, Dutch schedule |
| `demo/market/server.mts` | Market server: the HTTP API in `demo/API.md`, SSE, holds, auctions |
| `demo/market/payments.mts` | `HoldProvider` interface and `FakeCardProvider` |
| `demo/market/negotiation.mts` | Negotiation engine: counters, buyer-message intents, scripted buyer logic |
| `demo/market/scenario.mts` | Scripted buyer agents (Ada, Bo, Cy) acting only through the HTTP API |
| `demo/public/` | Gallery page, embeddable widget (`holdback.js`), demo store + Shopify extension (`store/`) |
| `mcp/` | `holdback-market` MCP server for Claude and other agents |
| `docs/v2-plan.md` | Plan for card payments and real merchants |

## Status and next steps

- Done: mechanisms, negotiation, MCP server, widget and Shopify block, all on a fake card processor.
- Next (see `docs/v2-plan.md`): a persisted ledger and authentication, then a Stripe provider (PaymentIntents with
  manual capture) in test mode, then a first live merchant (Auspice).

## License

MIT. See [LICENSE](LICENSE).
