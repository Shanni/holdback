# Known issues (crypto version)

From a code review on 2026-10-13, after the Crypto World's Fair submission. This branch is archived; none of these are fixed.


Solana program (`programs/holdback/src/lib.rs`):
- **Dust griefing locks funds.** `settle` pays out `payment.amount` and then closes the vault. Anyone can send 1 base
  unit of the mint to the vault PDA, `close_account` then fails on a non-zero balance, and every settle path
  (capture, refund, reclaim, release) reverts permanently. Fix: pay the buyer `vault.amount - released`, not
  `payment.amount - released`, or sweep the residual to the buyer before closing.
- **Merchant can capture a guarantee or pay-if-useful payment early.** `capture` checks only merchant, status, amount
  and window, so a merchant can capture a 7-day guarantee at t=0 and the buyer's reclaim is gone. Fix: only allow
  `capture` when `policy.refund_if_uncaptured` (bids/offers), or when there is no buyer reclaim or judge.
- **Fee-bearing Token-2022 mints lock funds.** `TokenInterface` accepts Token-2022, but with a transfer-fee extension
  the vault receives less than `amount`, so every payout overdraws. Fix: record the vault balance after transfer as
  the held amount, or reject mints with transfer-fee/hook extensions.
- **"A bid can't be auto-released" is client-enforced.** `authorize` doesn't require `refund_if_uncaptured` when
  `policy.listing` is set; only the SDK preset does. Enforce it on-chain.
- **The "floor reverts on-chain" claim has a hole.** The seller key can `delist` and re-`list_item` with a lower
  reserve. That's fine if a human holds the seller key, but not if the agent does. Either separate the reserve
  authority from the agent's signing key, or soften the claim.
- Payment accounts are never closed (rent stays locked). Minor.

Market server and MCP (`demo/market/`, `mcp/`):
- **The owner's spending limit can be bypassed (reproduced).** `Buyer.max` is stored but never checked by the
  server. After a decline the server sets the counter price to the ask, and the MCP guard only inspects "counter"
  turns, so offering 20 and then accepting captured 120 with `OWNER_MAX=90`. The pitch line "the buyer's limit is
  checked before any money moves" is false today. Fix: enforce `max` server-side on every hold, and in v2 put it in
  the payment credential.
- **The "hidden floor" is public.** The floor is written as the listing's on-chain `reserve`, which anyone can read
  from the listing account. The pitch says both "floor hidden" and "floor enforced on-chain", and only one can be
  true. Fix: put a public reserve on-chain (≤ floor) and keep the real floor off-chain, or commit to a hash of the
  floor and reveal it at settlement.
- **No auth, custodial keys.** The server generates and signs for every buyer. Buyer ids are public, and
  re-registering a name returns the existing buyer, so anyone can accept, walk away or reclaim as anyone else.
  `/api/control/*` is open and CORS is `*`.
- **Faucet drain.** Each `POST /api/buyers` mints 300 dUSDC and, on devnet, sends 0.05 SOL from the dev wallet.
  The widget registers a new buyer per visitor. Rate-limit this, or gate it behind the demo.
- **Mechanism trust.** The second-price rule is only as honest as the server (the seller could capture the winner's
  full max). Shill bidding is free. A `GET` registers a watcher, and three watchers force an auction.
- Buyers can grind the price to the floor with repeated floor offers. Auction ties go by first-insert, not the
  latest raise. `respond accept` still works after the mechanism switches to Dutch/buy-now.
- Physical goods: the buyer can reclaim for 14 days after shipping, with no seller dispute path.
- `demo/public/mock-server.mjs` makes up devnet signatures and labels Solana "live". Disclose that in the README or
  drop it.
- In-flight work: the gitignored `store/extension/assets/holdback.js` means a fresh clone ships a broken Shopify
  extension. `seed-store.mts` is unreferenced. API.md is missing `kind: "physical"`, `guaranteeDays` and
  `description`.

EVM escrow (`tempo/src/HoldbackEscrow.sol`). No theft path was found; access control and expiry boundaries are correct.
- **Payment ids are global and can be front-run.** Anyone can claim a buyer's `paymentId` from the mempool, and the
  buyer's `authorize` then reverts. The demo id (`keccak(...:<unix seconds>)`) is also guessable. Fix: key payments
  on `keccak(msg.sender, paymentId)`.
- **Fake tokens produce real-looking holds.** The token check only accepts "has code + empty return", so a dummy
  token yields an `Authorized` payment with nothing behind it. Integrators must verify token, amount and payer, not
  just status. Consider a token allowlist per deployment.
- **Fee-on-transfer and rebasing tokens let one hold drain another.** The contract records `amount`, not the
  balance delta, and all holds of a token share one balance. Measure the balance delta, or enforce the README's
  "unsupported" rule on-chain.
- A payer who gets blacklisted or paused blocks void, reclaim and partial capture, because the refund goes straight
  to them. Consider pull-based refunds.
- `authorizationExpiry` has no upper bound, so funds can be locked forever.
- Test gaps: two simultaneous holds of one token (the key invariant), behaviour one second before expiry,
  no-return/false-return/fee tokens, stranger access, invariant fuzzing.
- `tempo/README.md` overstates two things: "unguessable id" and "tolerates no-bool tokens" (untested). Re-running
  `deploy.sh` overwrites the documented address.

