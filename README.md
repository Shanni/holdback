# Holdback

**Payment plans for the agent economy. Every offer, bid and purchase is a hold, captured only when the deal clears.**

AI agents are starting to buy things. But a crypto payment is final, so an agent can't safely bid, negotiate, or get its money back when something is wrong. Card networks solve this with authorizations, captures and chargebacks, but only for merchants big enough to carry the risk.

Holdback brings the **auth-capture** lifecycle (the x402 `auth-capture` scheme, standardized on EVM by the Coinbase/Shopify Commerce Payments Protocol) to **Solana**, and builds sales mechanisms on top of it:

> Auctions, offers, discounts and guarantees are all the same thing: **rules about how much of a held payment to capture.**

| Mechanism | Hold | Capture | Refund |
|---|---|---|---|
| Buy now + 7-day guarantee | price | after the window, unless reclaimed | buyer reclaims inside the window, no seller approval |
| Make an offer / bargain | each offer | when the seller accepts | declined, withdrawn, or replaced by a new offer |
| Proxy auction (second price) | each bidder's max | winner pays 2nd max + 1 | the winner's change, and every losing bid |
| Dutch auction (price falls) | current price | immediately | — |
| Pay if useful | price | after the window, unless disputed | verifier rules, including partial refunds |
| Commission / pay-it-forward | price | split on release (affiliate, pool) | splits are voided on refund |

A **seller agent** picks the mechanism from demand (one watcher → offers, three → auction, none → Dutch) and switches as demand changes. **Buyer agents** bargain within their owner's limits. Humans can join through the web page, and any MCP-capable agent (Claude Desktop, Claude Code) can join through the `holdback-market` MCP server.

## How it fits together

```
 People: Gallery web page            Agents: Claude via MCP, scripted buyer agents
              │                                   │
              └──────────► Holdback market server ◄┘
                           seller agent (mechanism choice) + negotiation engine
                                        │  every offer / bid / purchase = HOLD
             ┌──────────────────────────┼───────────────────────────┐
             ▼                          ▼                           ▼
      Solana program              Tempo testnet               Robinhood Chain testnet
      holdback (Anchor)           HoldbackEscrow.sol          HoldbackEscrow.sol (TSLA, AMZN…)
      + escrowed NFT, DvP
```

## The Solana program (`programs/holdback`)

| Instruction | Who | What |
|---|---|---|
| `authorize(id, amount, policy)` | buyer | Moves funds into a per-payment vault under a policy (window, reclaim rights, verifier, splits, refund-if-uncaptured, listing) |
| `capture(amount)` | merchant | Takes `amount ≤ held`; the rest goes back to the buyer |
| `list_item(id, reserve)` | seller | Moves the NFT into escrow |
| `capture_sale(amount)` | seller | **Delivery versus payment**: NFT to the buyer and `amount` to the seller in one transaction, change refunded |
| `reclaim` | buyer | Inside the window (guarantee, offers) or after the deadline if never captured (bids) |
| `refund` | merchant | Voids a hold at any time before settlement (declined offers, losing bids) |
| `release` | anyone | After the window with no objection (guarantee); never for bids and offers |
| `dispute` / `resolve(refund_bps)` / `expire_dispute` | buyer / verifier / anyone | Pay-if-useful: a named verifier rules (partial refunds allowed); a silent verifier means the buyer is refunded |
| `delist` | seller | Unsold NFT back out of escrow |

Safety checks covered by tests: a bid can't be auto-released to the seller; a listing bid can't be captured without delivering the item; captures below the reserve fail; the same NFT can't be sold twice; split accounts must belong to the policy's recipients; splits can't exceed 100%.

## Run it

Requirements: Solana CLI 2.3, Anchor 0.32.1, Node 22, pnpm.

```bash
pnpm install
npm run build          # program + IDL (IDL generation uses a nightly toolchain, see package.json)
anchor test --skip-build   # 12 tests on a local validator
node --test demo/mechanism.test.mts

# demo: local validator + market server + gallery
solana-test-validator --reset --bpf-program 63hjwfJZ8vHLL97WgGezNhuJenF6orxETi2yQGbMbygU target/deploy/holdback.so
node demo/market/server.mts      # open http://localhost:4022
```

## Repository

| Path | What |
|---|---|
| `programs/holdback` | Anchor program |
| `sdk/holdback.ts` | TS client: presets (guarantee, pay-if-useful, commission, pay-it-forward), bid/offer holds, PDAs |
| `tests/holdback.ts` | 12 end-to-end tests on a local validator |
| `demo/mechanism.mts` | Seller agent: mechanism choice, offer response, second-price settlement, Dutch schedule |
| `demo/market/` | Market server, negotiation engine, scripted buyer agents |
| `demo/public/` | Gallery web page |
| `mcp/` | `holdback-market` MCP server for Claude and other agents |
| `tempo/` | The same auth-capture escrow in Solidity, for Tempo and Robinhood Chain testnets |

## What was built during the hackathon, and what came before

Built during Crypto World's Fair (Sep 14 – Oct 12, 2026): everything in this repository: the Holdback program, SDK, tests, seller agent, negotiation engine, market server, gallery, MCP server, and the EVM escrow.

Prior work by the same founder, used as context and as the first merchants, not as code in this repo:
- **Auspice** (auspiceoracle.com), a live BaZi product with paying customers; its pricing research motivated the payment plans.
- **Project Sienna** (2025): USDC payments, invoices, an x402 backend, the `@projectsienna/x402-clients` npm package, an x402 payment widget, and the Trusted Agent Protocol demo store.
- **true-solar-time-mcp**, a published MCP server.

## Status and next steps
- Solana: 12 program tests on a local validator; devnet deployment pending funding.
- Robinhood Chain testnet: `HoldbackEscrow` [deployed](https://explorer.testnet.chain.robinhood.com/address/0xED594057c6350D622d95a19e7FE96f0565E1E7dF); a bid held 3 tokenized TSLA, [captured 2.5](https://explorer.testnet.chain.robinhood.com/tx/0x302aa8b488588df0e1c192a6c71d42f205822df97491296bcd91c3a41cd94d66) and refunded 0.5; a losing AMZN bid was [voided](https://explorer.testnet.chain.robinhood.com/tx/0xbcfe2a1a55ff6047a945672e94c18007cbb1a1a496c9f742c93418c0f5d0bbd3). See `tempo/README.md`.
- Tempo testnet: same contract, 18 Foundry tests; deployment waiting on the testnet faucet.
- Next: real NFT standards (Metaplex Core / pNFT transfer adapters), an on-chain auction book so the second-price rule is enforced by the program rather than the seller agent, Kora for gasless buyers, and a draft Solana binding for the x402 `auth-capture` scheme.
