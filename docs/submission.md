# Colosseum submission, v1 (fill in the bracketed parts)

**Product name:** Holdback

**One-liner:** Auth-capture escrow for Solana: agents and people bid, bargain and buy with payments that are held, not final, until the deal clears.

**Description (short):**
On-chain payments are final, so an agent can't safely bid, make an offer and walk away, or get its money back. Holdback brings the card-style auth-capture lifecycle to Solana: the buyer's money goes into a hold, the seller captures only what the deal says, and the rest returns automatically. With holds, every pricing model becomes a capture rule: a 7-day money-back window, pay-if-useful with a named judge, offers and counter-offers, second-price auctions, falling-price sales, and affiliate or pay-it-forward splits on release. A seller agent picks the mechanism from demand; buyer agents, including Claude through our MCP server, bargain within their owner's limit. The agent negotiates, but the contract enforces: the seller's floor is the listing's on-chain reserve, so a sale below it reverts however the agent was persuaded. NFTs sit in program escrow and are delivered in the same transaction as the payment.

**How it's built (technical summary):**
- Anchor program (`programs/holdback`): `authorize` (hold), `capture` / `capture_sale` (capture up to the hold; NFT, payment and change in one transaction), `reclaim` and `refund`, `dispute` / `resolve` / `expire_dispute` (a named judge rules a partial refund), `release` with basis-point splits, `list_item` / `delist` (NFT escrow with a reserve).
- Market server (TypeScript): the seller agent chooses offers, proxy auction, Dutch auction or buy-now from demand, keeps the floor hidden, and turns every offer, bid and purchase into a hold. Scripted buyer agents act only through the public HTTP API.
- `holdback-market` MCP server: lets Claude (Desktop or Code) shop and bargain; the owner's spending limit is enforced before any request is sent.
- The same escrow in Solidity (`tempo/`): deployed on Robinhood Chain testnet, where an agent bid 3 tokenized TSLA, 2.5 were captured and 0.5 refunded; the Tempo deploy is waiting on the testnet faucet.
- Tests: 12 Anchor tests, 18 Foundry tests, 25 TypeScript tests for the negotiation and auction logic, and an end-to-end MCP test against the live market.

**Chains / tools:** Solana (Anchor 0.32, SPL Token, x402 auth-capture semantics), Robinhood Chain testnet and Tempo (Solidity/Foundry), MCP (Model Context Protocol), TypeScript.

**Tracks:** Solana (primary). [Add Robinhood Chain or Tempo if the form allows more than one.]

**Team:** Shan Liu, founder of Auspice (auspiceoracle.com) and Project Sienna. [one line of background · location]

**GitHub:** https://github.com/Shanni/holdback (public, MIT)

**Pitch video (≤3 min):** [link]   **Technical demo video (2–3 min):** [link]

**Go-to-market:**
- First merchants are our own: Auspice (live, paying customers; a 7-day guarantee and pay-if-useful are the experiments its pricing research calls for) and the Gallery for digital art.
- Seller side first: a few lines turn an x402 402-response into a menu of plans; Project Sienna's x402 client and widget are the distribution path for existing x402 sellers.
- Buyer side: the MCP server makes any Claude/MCP agent a careful buyer; next, plan support in x402 clients.
- Revenue: a small fee on captured amounts; judge fees for pay-if-useful.

**Demand validation:** [Auspice numbers you are comfortable sharing: users, paying customers, refund requests]. x402 agent payments are already live on Solana, but every payment is final; EVM has auth-capture (Coinbase/Shopify Commerce Payments Protocol), Solana does not.

**Past development disclosure:**
All code in this repository was written during the hackathon (Sep 14 – Oct 12, 2026). Prior work by the same founder that informed it but is not part of this codebase: Auspice (live product, 2026), Project Sienna (2025: USDC payments and invoices on Solana, an x402 backend, the @projectsienna/x402-clients npm package, an x402 payment widget, and the Trusted Agent Protocol demo store), and true-solar-time-mcp (published MCP server). [If TAP or Sienna was submitted to an earlier hackathon, name it here.]
