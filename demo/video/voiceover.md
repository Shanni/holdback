# Demo video voice-over (2:15)

Video: `demo/video/holdback-demo-silent.mp4` (1920×1080, silent, live product only, as the form asks). Read at a normal pace (~150 words per minute); each block fits its window. Two stretches are sped up: the auction countdown (0:47–0:59) and Claude Code starting (1:13–1:21).

| Time | On screen | Say |
|---|---|---|
| 0:00–0:14 | Gallery, then two listings appear | This is Holdback, auth-capture escrow on Solana, running live on a local validator. The totals show money held, paid to the seller, and returned. The seller lists two NFTs; each moves into program escrow, with the seller's floor stored on-chain as the reserve. |
| 0:14–0:30 | Bo haggles on Monkey #1 | Bo is a buyer agent capped at 60. Every offer he makes is a real hold, and when he raises, the previous hold is refunded. The seller counters but never goes below its floor, so Bo walks away with his money back. |
| 0:30–0:45 | Auction badge, bids | Two more buyers start watching, so the seller agent switches to a second-price auction. Each bidder's maximum is held on-chain. |
| 0:45–1:07 | Countdown (sped up), sale | When it closes, Ada had the highest max, 120, but pays 96: the second-highest bid plus one. One capture_sale transaction moves the NFT to Ada, 96 to the seller and 24 back to her, and the losing holds are voided. |
| 1:07–1:13 | Totals | The totals update as each hold settles. |
| 1:13–1:39 | Claude negotiates on Monkey #3 | Now Claude. I asked Claude Code to get Monkey #3 with a limit of 90. Through our MCP server it opens at 60, below the floor, so that hold is released. It raises to 75, then 80, and the seller accepts 83. The owner's limit is checked before any money moves. |
| 1:39–1:55 | Hi-res print, Cy buys and reclaims | Every pricing model is a capture rule. This print sells with a 7-day money-back window: the payment stays held, and Cy takes it back inside the window without asking the seller. |
| 1:55–2:15 | Solana Explorer | Here is a capture_sale on Solana Explorer: the NFT leaves escrow for the buyer and the payment goes to the seller in one atomic transaction, for a fraction of a cent. The agent negotiates; the program enforces the floor. Holdback is open source on GitHub. |

## Adding the voice-over

- **iMovie:** new project → drag in the MP4 → Record Voiceover (microphone icon under the viewer) → read each block as the timecode passes → Share → File, 1080p.
- **ffmpeg** (if you record `voice.m4a` separately): `ffmpeg -i holdback-demo-silent.mp4 -i voice.m4a -c:v copy -c:a aac -shortest holdback-demo.mp4`
- Upload to YouTube (Unlisted), Loom or Vimeo; the form only takes links.
