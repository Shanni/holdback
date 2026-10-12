# Demo video (max 3:00)

Setup before recording: validator + `STEP=1 node demo/market/server.mts`, Gallery open at http://localhost:4022, Claude Code (or Desktop) connected to the holdback-market MCP server with OWNER_MAX=90, Solana Explorer tab ready. Press **Next scene ▶** (or Space) to advance.

| Time | Do | Say |
|---|---|---|
| 0:00 | Gallery, idle | "This is Holdback Gallery. A seller agent is selling monkey NFTs, and every payment here is a hold on Solana: captured only when the deal clears." |
| 0:15 | Next → items listed | "Each NFT is moved into escrow when it's listed. The seller only sets a floor and a goal; the agent picks how to sell." |
| 0:30 | Next → Bo negotiates on Monkey #1 | "Bo is a buyer agent whose owner capped him at 60. Each offer is held on-chain. When he raises, the previous hold is refunded." |
| 0:55 | Next → Ada & Cy watch → AUCTION | "Two more buyers show up, so the seller agent switches to a second-price auction. Each agent holds its maximum." |
| 1:15 | Auction settles; click the sale tx ↗ | "Ada bid up to 120 but pays 96: second price plus one. In one transaction the NFT goes to Ada, 96 to the seller, 24 back to Ada. Losing bids are refunded." |
| 1:40 | Switch to Claude, Monkey #3 | Prompt: "Get me Monkey #3, my limit is 90." "Now Claude bargains through our MCP server." (let it run: offer → counter → offer → deal) |
| 2:15 | Back to Gallery | "Every round Claude made was a real hold; the NFT is now Claude's wallet's." |
| 2:25 | Next → Monkey #2 Dutch → buy | "No interest in Monkey #2, so the price falls until a buyer's limit is met." |
| 2:40 | Robinhood explorer tab | "The same auth-capture contract runs on Robinhood Chain, here an agent bids with tokenized TSLA, and on Tempo." |
| 2:50 | Gallery | "Holdback: every pricing mechanism is just how much to capture." |
