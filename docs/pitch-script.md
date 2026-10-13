# Pitch video (≤2:00) — script for the Holdback pitch deck

Deck: https://claude.ai/artifact/AJQMHn3soDWiwyERzfqRhv (the same lines are its speaker notes). Read at a normal pace, about 150 words per minute. ElevenLabs version: `demo/video/pitch/tts.mjs` reads `demo/video/pitch/sections.json`.

**[0:00 · Slide 1: "Payments that wait for the deal."]**
Hi, I'm Shan, and this is Holdback. Software sells one way today: a subscription. One price, take it or leave it. Real markets never worked like that. You bargain. Students get a discount. Businesses buy in bulk. Now that agents can negotiate for us, pricing can be that flexible again.

**[0:20 · Slide 2: "Every crypto payment is final."]**
The catch: on-chain, a payment is final. A losing bid is already gone, and there's no money back when something's wrong. Cards fixed this with authorize and capture, but only for big merchants.

**[0:33 · Slide 3: "Hold, capture what's fair, refund the rest."]**
Holdback is auth-capture for Solana. The buyer's money goes into a hold. The seller captures only what the deal says, and the rest goes back automatically.

**[0:44 · Slide 4: "Every pricing model is a capture rule."]**
Once you have holds, every pricing model is just a rule: a money-back guarantee, pay-if-useful, offers, an auction, a falling price, affiliate splits.

**[0:53 · Slide 5: "A seller agent picks how to sell."]**
It works for people and agents. A seller agent picks how to sell from demand: one buyer means offers, three means an auction, nobody means the price falls. Buyers, a person on the page or Claude over MCP, bargain within their limits.

**[1:10 · Slide 6: "The agent negotiates. The contract enforces."]**
The agent negotiates; the contract enforces. A sale below the seller's floor reverts on-chain, and the buyer's limit is checked before any money moves.

**[1:19 · Slide 7: "What the demo settles on-chain."]**
In the demo, Ada bid up to 120 and paid 96, the second price plus one. Claude bargained four rounds and bought at 83.

**[1:29 · Slide 8: "Built from a live business."]**
I run Auspice, a live product with paying customers. Its pricing research led here: people pay more when they can get their money back. Before this I built Project Sienna, agent payments on Solana.

**[1:42 · Slide 9: "One escrow, three chains."]**
It runs on Solana, the same escrow is live on Robinhood Chain testnet, and Tempo is next. After that: presets for bulk and business deals, and an on-chain auction book.

**[1:54 · Slide 10: "Every pricing mechanism is just how much to capture."]**
Subscriptions were one way to pay. Holdback makes all the others possible. Thank you.
