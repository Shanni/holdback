# Holdback on EVM: `HoldbackEscrow.sol`

The EVM rail for Holdback: the same auth-capture lifecycle as the Solana program
(`../programs/holdback`), as one small Solidity contract that works with any ERC-20.
That includes TIP-20 stablecoins on **Tempo** and tokenized stocks on **Robinhood Chain**.

Tempo's MPP has `charge`, `session` and `subscription` intents, but nothing for holding funds
and settling them later. There is no auth-capture, void or buyer reclaim. This contract adds
those as a plain contract, with no protocol changes.

```
authorize(paymentId, receiver, token, amount, authorizationExpiry, payerCanReclaimBeforeExpiry)
    payer -> escrow   (transferFrom: approve the escrow first)
capture(paymentId, captureAmount)   receiver only, before expiry, 0 < captureAmount <= held
    escrow -> receiver captureAmount;  escrow -> payer (held - captureAmount)
void(paymentId)                     receiver only, any time while held
    escrow -> payer everything
reclaim(paymentId)                  payer only
    before expiry: only if payerCanReclaimBeforeExpiry;  at/after expiry: always
```

Each payment settles exactly once (`Authorized -> Captured | Voided | Reclaimed`). Events:
`Authorized`, `Captured(capturedAmount, refundedAmount)`, `Voided`, `Reclaimed`.
Field names follow the x402 / commerce-payments auth-capture vocabulary: `payer`,
`receiver`, `token`, `authorizationExpiry`, `capture`, `void`, `reclaim`.

**Storage:** each payment uses 3 packed slots:
`payer|expiry|status|flag`, `receiver|uint96 amount`, `token`. On Tempo a new slot costs
250k gas, so `authorize` is the expensive call (about 3 × 250k). Settling only rewrites
existing slots.

## Layout

| Path | What |
|---|---|
| `src/HoldbackEscrow.sol` | the escrow (about 150 lines, no dependencies) |
| `test/HoldbackEscrow.t.sol` | Foundry tests plus a 6-decimal `MockUSD` |
| `chains.sh` | per-chain config: RPC, explorer, keys, demo tokens and amounts |
| `deploy.sh <chain>` | `forge create`, which writes `deployments/<chain>.env` |
| `demo.sh <chain>` | end-to-end run that prints explorer links and writes `deployments/<chain>-demo.log` |
| `.keys/` | throwaway testnet keys (gitignored) |

`<chain>` is `tempo`, `robinhood` or `local` (anvil dry run). `CHAIN=<chain> ./demo.sh`
also works. The scripts read `CHAIN` and then unset it, because Foundry itself treats
`$CHAIN` as `--chain`.

```bash
forge install foundry-rs/forge-std --no-git   # lib/ is gitignored
forge test
./deploy.sh tempo && ./demo.sh tempo
./deploy.sh robinhood && ./demo.sh robinhood
```

## Tests

`forge test` passes 18/18:

- `authorize` pulls funds; it rejects a duplicate id and bad params
- partial capture (96 of 100) refunds the remaining 4; full capture works
- capturing zero or more than is held reverts
- capture by a stranger or by the payer reverts (`Unauthorized`)
- capture at or after expiry reverts
- `void` refunds everything, and only the receiver can call it
- `reclaim` before expiry works when allowed and reverts (`ReclaimNotAllowed`) when not
- `reclaim` after expiry always works; only the payer can call it
- double settlement reverts: capture then capture, void or reclaim; void then reclaim
- fuzz: for any capture amount, merchant + buyer balances add up and the escrow ends empty

## Tempo (Moderato testnet, chain 42431)

**Status: not deployed. The testnet faucet is down.**

`tempo_fundAddress` (and the HTTPS faucet `POST tempo.xyz/developers/api/faucet`, which
calls the same method) returned
`{"code":-32600,"message":"request too large"}` (HTTP 413) for every address and every
request shape I tried. Retries ran for about 28 minutes on 2026-10-12 (18:43 to 19:11 local, about 150 attempts). Other RPC methods on
the same endpoint work. Tempo has no native gas token, so an unfunded key cannot even pay
for the deploy.

Once the faucet works again, the three throwaway keys in `.keys/` (`deployer`, `buyer`,
`merchant`) need funding:

```bash
for a in 0x00d3eb2d40FEE580ceF3549B83c2E1149a1CA5B5 0x236c86392F78896e91E2006171E412204C50b028 0x9F106c4C5d6Fa7D4028eCfC24e6fe9C363BEF931; do
  cast rpc tempo_fundAddress $a --rpc-url https://rpc.moderato.tempo.xyz; done
./deploy.sh tempo && ./demo.sh tempo
```

The demo uses AlphaUSD (`0x20c0…0001`, 6 decimals). On the winning bid the buyer holds
100 AlphaUSD, the merchant captures 96 (second price) and the buyer gets 4 back. A second
50 AlphaUSD hold is voided.

**Fee token:** the installed Foundry (0.3.1-nightly, January 2025) has no `--tempo.*` flags.
Its transactions are plain EVM transactions, and Tempo's fee-token cascade covers them:
transaction field → account `setUserToken` → TIP-20 `transfer` target → pathUSD fallback.
So every signer pays fees in **pathUSD**, which the faucet hands out. A newer `foundryup`
would let you pass `--tempo.fee-token 0x20c0…0001` instead.

Explorer: https://explore.testnet.tempo.xyz

## Robinhood Chain (testnet, chain 46630)

Arbitrum Orbit, with ETH as gas. The contract and scripts are the same as on Tempo.

**Status: deployed and demoed live on Oct 12, 2026.**

Contract: [`0xED594057c6350D622d95a19e7FE96f0565E1E7dF`](https://explorer.testnet.chain.robinhood.com/address/0xED594057c6350D622d95a19e7FE96f0565E1E7dF) ([deploy tx](https://explorer.testnet.chain.robinhood.com/tx/0xf2f2876080ff4d460544a2040f187289e437523f2bf74a6c8cac9efa45956f37))

| Step | Transaction |
|---|---|
| Winning bid: approve 3 TSLA | [tx](https://explorer.testnet.chain.robinhood.com/tx/0xdfd1c7ac1ddc489ea74a64bc9f92be228803f5c379a210c3685bcfb3bd061b7d) |
| authorize (hold) 3 TSLA | [tx](https://explorer.testnet.chain.robinhood.com/tx/0xaded4af1a2e3de5b8f91313fa7511d523d9078d08c357b2e5c460a6d6cd835b3) |
| capture 2.5 TSLA (second price), 0.5 back to the buyer | [tx](https://explorer.testnet.chain.robinhood.com/tx/0x302aa8b488588df0e1c192a6c71d42f205822df97491296bcd91c3a41cd94d66) |
| Losing bid: approve 1 AMZN | [tx](https://explorer.testnet.chain.robinhood.com/tx/0xc2976976af046de1c9cf1c21d53cbe601592650240d0ffb70851638dc1eb34ac) |
| authorize (hold) 1 AMZN | [tx](https://explorer.testnet.chain.robinhood.com/tx/0xc1e10c175b82cb529854e9746cf146b1e51bd89ca2b1fd0d86f74bd5a326279c) |
| void (full refund) | [tx](https://explorer.testnet.chain.robinhood.com/tx/0xbcfe2a1a55ff6047a945672e94c18007cbb1a1a496c9f742c93418c0f5d0bbd3) |

Before the live run, the full flow was simulated on an
`anvil --fork-url https://rpc.testnet.chain.robinhood.com` fork, impersonating the real
deployer `0x0682f914B558ee3f7bd3d8827852E08E5F9E0759` and the real TSLA and AMZN tokens:

| Step | Result | Gas |
|---|---|---|
| deploy | ok | about 650k |
| approve 3 TSLA | ok | 60.6k |
| authorize 3 TSLA | ok | 155.8k |
| capture 2.5 TSLA | buyer 5 → 2.5, merchant 0 → 2.5 (0.5 refunded) | 106.7k |
| approve + authorize 1 AMZN | ok | |
| void | buyer AMZN back to 5 | 70.5k |

At the observed gas price of 0.01 gwei, the whole run costs about 1e-5 ETH, plus the
0.001 ETH gas top-up to the merchant.

The demo buyer is the existing funded deployer, `../.keys/robinhood-deployer.json`, which
`chains.sh` reads at runtime and never prints. The merchant is a new throwaway key,
`.keys/robinhood-merchant` (`0x5489F79e72C7143CabAdba9Ab3c7707A457894bc`). To run it again:

```bash
./deploy.sh robinhood && ./demo.sh robinhood
```

Explorer: https://explorer.testnet.chain.robinhood.com

## Mapping to the Solana program

| Solana (`programs/holdback`) | EVM (`HoldbackEscrow`) |
|---|---|
| `authorize(amount, policy)` creates the `Payment` PDA and vault | `authorize(...)` stores the `payments[paymentId]` struct; the escrow contract holds the tokens |
| `Payment.buyer / merchant / mint / amount` | `payer / receiver / token / amount` |
| `policy.window_secs` → `release_at` | `authorizationExpiry` (absolute timestamp) |
| `policy.buyer_can_reclaim` | `payerCanReclaimBeforeExpiry` |
| `capture(amount)`: merchant, before `release_at`, remainder refunded | `capture(paymentId, captureAmount)`: same rule |
| `refund` (merchant void) | `void(paymentId)` |
| `reclaim`: in window if allowed, after window if `refund_if_uncaptured` | `reclaim`: in window if allowed, after expiry **always** (EVM only has the auth-capture "refund if uncaptured" mode) |
| `Settled { status, refunded, to_merchant }` | `Captured` / `Voided` / `Reclaimed` events |

## Not ported (Solana only)

- **Disputes and verifier/judge:** `dispute`, `resolve(refund_bps)`, `expire_dispute`, and
  `policy.judge` with `dispute_timeout_secs`.
- **Release-after-window mode:** `release` for policies where an unchallenged hold pays the
  merchant automatically (`refund_if_uncaptured = false`).
- **Splits:** `policy.splits` (bps payouts to multiple recipients on settlement).
- **NFT DvP:** `list_item`, `capture_sale` (atomic item ↔ payment swap) and `delist`. On EVM the
  "NFT bid" in the demo is only a narrative; delivery of the item is not enforced.
- **Presets:** `policy.preset`.
- **Permit2 / EIP-3009 gasless authorize** (x402's signature-based `authorize`). This
  contract uses plain `approve` + `transferFrom`.

## Caveats and assumptions

- `paymentId` is first come, first served and global. Someone could front-run the same id to
  grief an `authorize`. Use an unguessable id (the demo uses
  `keccak("holdback:<chain>:<kind>:<timestamp>")`); a production version would key on
  `(payer, paymentId)`.
- `amount` is capped at `uint96` (about 7.9e28 base units), which is fine for 6- and
  18-decimal tokens.
- Transfers tolerate tokens that return no bool. Fee-on-transfer and rebasing tokens are not
  supported.
- TIP-20 precompiles have 1-byte code (`0xef`), so the `code.length` check passes. TIP-403
  transfer policies and receive policies could block a transfer into or out of the escrow.
  This was not verified on Tempo because of the faucet outage.
- Compiled with solc 0.8.28 and `evm_version = cancun`. Tempo targets Osaka, and the
  Robinhood fork ran it fine.
