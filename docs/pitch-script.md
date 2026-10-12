# Pitch video (target 2:30, max 3:00)

Read at a normal pace; ~150 words per minute. Slides are suggestions; a face-cam over 4 simple slides is enough.

**[0:00 · Slide: "Every crypto payment is final."]**
AI agents are starting to buy things for us: API calls, data, digital goods. But on-chain, a payment is final. So an agent can't safely bid, can't make an offer and walk away, and can't get its money back when something is wrong. Card networks solved this decades ago with authorizations, captures and chargebacks, but only for merchants big enough to carry that risk.

**[0:30 · Slide: "Hold → capture what's fair → refund the rest"]**
Holdback is auth-capture for Solana. The buyer's money goes into a hold. The seller captures only what the deal says, and the rest goes back automatically. Once you have that, every pricing model becomes configuration: a 7-day guarantee, pay-if-useful with a verifier, bargaining, a second-price auction, a falling-price sale, affiliate commissions. They are all just rules about how much of a hold to capture.

**[1:00 · Slide: the Gallery screenshot]**
We built it around something people actually sell: digital art. A seller agent lists an NFT and picks how to sell it from demand. One interested buyer means offers. Three means an auction. Nobody means the price starts falling. Buyer agents, including Claude through our MCP server, bargain within their owner's limits. Every offer is held on-chain; the NFT and the payment swap in a single transaction.

**[1:40 · Slide: "Why us"]**
I run Auspice, a live product with paying customers, and my pricing research is what led here: people pay more when they can get their money back. Last year I built Project Sienna, with x402 payments, invoices and an npm client for agent payments on Solana. Holdback is the missing piece: payments that aren't final until they should be.

**[2:10 · Slide: "Solana · Tempo · Robinhood Chain"]**
The program is on Solana, with the same auth-capture contract running on Tempo and on Robinhood Chain, where an agent bids with tokenized stock. Next: an on-chain auction book, gasless buyers, and a Solana binding for the x402 auth-capture standard.
Holdback: every pricing mechanism is just how much to capture.
