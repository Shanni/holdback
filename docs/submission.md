# Colosseum submission draft (fill in the bracketed parts)

**Product name:** Holdback

**One-liner:** Auth-capture for Solana: agents and people bid, bargain and buy with payments that are held, not final, until the deal clears.

**Description (short):**
Holdback brings the auth-capture payment lifecycle (authorize, capture any amount up to the hold, void, reclaim) to Solana, and turns pricing mechanisms into configuration: 7-day guarantees, pay-if-useful with a verifier, offers and counter-offers, second-price auctions, falling-price sales, and affiliate or pay-it-forward splits. A seller agent chooses the mechanism from demand; buyer agents, including Claude through an MCP server, bargain within their owners' limits. NFTs are escrowed and delivered in the same transaction as the payment.

**Chains / tools:** Solana (Anchor 0.32, SPL Token, x402 auth-capture semantics), Tempo testnet and Robinhood Chain testnet (Solidity/Foundry), MCP (Model Context Protocol), TypeScript.

**Tracks:** Solana (primary). Also integrates Tempo and Robinhood Chain [select if the form allows more than one].

**Team:** [Shan Liu, founder of Auspice (auspiceoracle.com) and Project Sienna; background …; location …]

**GitHub:** https://github.com/Shanni/holdback (public, MIT)

**Pitch video (2–3 min):** [link]   **Demo video (≤3 min):** [link]

**Go-to-market:**
- First merchants are our own: Auspice (live, paying customers; a 7-day guarantee and pay-if-useful are the experiments its pricing research calls for) and the Gallery for digital art.
- Seller side first: a few lines turn an x402 402-response into a menu of plans; Project Sienna's x402 client and widget are the distribution path for existing x402 sellers.
- Buyer side: the MCP server makes any Claude/MCP agent a careful buyer; next, plan support in x402 clients.
- Revenue: a small fee on captured amounts; verifier fees for pay-if-useful.

**Demand validation:** [Auspice numbers you are comfortable sharing: users, paying customers, refund requests]. x402 agent payments are already live on Solana (batch settlement on mainnet since Oct 7, 2026), but every payment is final; EVM has auth-capture (Coinbase/Shopify Commerce Payments Protocol), Solana and Tempo's MPP do not.

**Past development disclosure:**
All code in this repository was written during the hackathon (Sep 14 – Oct 12, 2026). Prior work by the same founder that informed it but is not part of this codebase: Auspice (live product, 2026), Project Sienna (2025: USDC payments and invoices on Solana, an x402 backend, the @projectsienna/x402-clients npm package, an x402 payment widget, and the Trusted Agent Protocol demo store), and true-solar-time-mcp (published MCP server). [If TAP or Sienna was submitted to an earlier hackathon, name it here.]
