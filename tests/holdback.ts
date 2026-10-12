import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount } from "@solana/spl-token";
import { assert } from "chai";
import { Holdback } from "../target/types/holdback";
import { presets, holds, paymentPda, vaultPda, listingPda, itemVaultPda, settleAccounts, reasonHash, Policy } from "../sdk/holdback";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("holdback", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.holdback as Program<Holdback>;
  const conn = provider.connection;

  const buyer = Keypair.generate();
  const merchant = Keypair.generate();
  const verifier = Keypair.generate();
  const referrer = Keypair.generate();
  const pool = Keypair.generate();
  const stranger = Keypair.generate();
  let mint: PublicKey;
  const ata: Record<string, PublicKey> = {};
  let nextId = 1;

  const bal = async (who: string) => Number((await getAccount(conn, ata[who])).amount);

  before(async () => {
    for (const kp of [buyer, merchant, verifier, stranger]) {
      await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL));
    }
    const payer = (provider.wallet as anchor.Wallet).payer;
    mint = await createMint(conn, payer, payer.publicKey, null, 6); // USDC-like
    for (const [name, kp] of Object.entries({ buyer, merchant, referrer, pool })) {
      ata[name] = (await getOrCreateAssociatedTokenAccount(conn, payer, mint, kp.publicKey)).address;
    }
    await mintTo(conn, payer, mint, ata.buyer, payer, 1_000_000_000);
  });

  async function authorize(policy: Policy, amount = 19_000_000, who: Keypair = buyer, whoToken = ata.buyer) {
    const id = new BN(nextId++);
    const payment = paymentPda(program.programId, who.publicKey, id);
    await program.methods
      .authorize(id, new BN(amount), policy)
      .accounts({
        buyer: who.publicKey,
        merchant: merchant.publicKey,
        mint,
        buyerToken: whoToken,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      } as any)
      .signers([who])
      .rpc();
    return payment;
  }

  async function call(ix: "reclaim" | "release" | "refund" | "expireDispute", payment: PublicKey, actor: Keypair) {
    const { accounts, remaining } = await settleAccounts(program, payment, actor.publicKey);
    return program.methods[ix]().accounts(accounts as any).remainingAccounts(remaining).signers([actor]).rpc();
  }

  async function expectError(p: Promise<unknown>, code: string) {
    try {
      await p;
      assert.fail(`expected ${code}`);
    } catch (e: any) {
      assert.include(String(e?.error?.errorCode?.code ?? e), code);
    }
  }

  it("guarantee: buyer reclaims inside the window", async () => {
    const before = await bal("buyer");
    const payment = await authorize(presets.guarantee(60));
    assert.equal(await bal("buyer"), before - 19_000_000);
    await call("reclaim", payment, buyer);
    assert.equal(await bal("buyer"), before);
    const p = await program.account.payment.fetch(payment);
    assert.deepEqual(p.status, { refunded: {} });
    assert.isNull(await conn.getAccountInfo(vaultPda(program.programId, payment)), "vault closed");
  });

  it("guarantee: cannot release early; anyone releases after the window; no reclaim after", async () => {
    const m0 = await bal("merchant");
    const payment = await authorize(presets.guarantee(2));
    await expectError(call("release", payment, stranger), "WindowOpen");
    await expectError(call("reclaim", payment, stranger), "Unauthorized");
    await sleep(3000);
    await expectError(call("reclaim", payment, buyer), "WindowClosed");
    await call("release", payment, stranger);
    assert.equal(await bal("merchant"), m0 + 19_000_000);
  });

  it("pay-if-useful: no reclaim; dispute; verifier rules a 50% partial refund", async () => {
    const b0 = await bal("buyer");
    const m0 = await bal("merchant");
    const payment = await authorize(presets.payIfUseful(verifier.publicKey, 60, 60));
    await expectError(call("reclaim", payment, buyer), "ReclaimNotAllowed");
    await program.methods
      .dispute(reasonHash("report contradicts the chart it was generated from"))
      .accounts({ buyer: buyer.publicKey, payment } as any)
      .signers([buyer])
      .rpc();
    const { accounts, remaining } = await settleAccounts(program, payment, stranger.publicKey);
    await expectError(
      program.methods.resolve(5000).accounts(accounts as any).remainingAccounts(remaining).signers([stranger]).rpc(),
      "Unauthorized",
    );
    const v = await settleAccounts(program, payment, verifier.publicKey);
    await program.methods.resolve(5000).accounts(v.accounts as any).remainingAccounts(v.remaining).signers([verifier]).rpc();
    assert.equal(await bal("buyer"), b0 - 9_500_000);
    assert.equal(await bal("merchant"), m0 + 9_500_000);
  });

  it("pay-if-useful: a silent verifier means the buyer is refunded after the timeout", async () => {
    const b0 = await bal("buyer");
    const payment = await authorize(presets.payIfUseful(verifier.publicKey, 60, 2));
    await program.methods.dispute(reasonHash("no response")).accounts({ buyer: buyer.publicKey, payment } as any).signers([buyer]).rpc();
    await expectError(call("expireDispute", payment, stranger), "WindowOpen");
    await sleep(3000);
    await call("expireDispute", payment, stranger);
    assert.equal(await bal("buyer"), b0);
  });

  it("guarantee presets cannot be disputed", async () => {
    const payment = await authorize(presets.guarantee(60));
    await expectError(
      program.methods.dispute(reasonHash("x")).accounts({ buyer: buyer.publicKey, payment } as any).signers([buyer]).rpc(),
      "NoJudge",
    );
    await call("reclaim", payment, buyer);
  });

  it("commission: referrer is paid on release and gets nothing on refund", async () => {
    const r0 = await bal("referrer");
    const m0 = await bal("merchant");
    const voided = await authorize(presets.commission(referrer.publicKey, 2000, 60));
    await call("refund", voided, merchant);
    assert.equal(await bal("referrer"), r0);

    const paid = await authorize(presets.commission(referrer.publicKey, 2000, 2));
    await sleep(3000);
    await call("release", paid, stranger);
    assert.equal(await bal("referrer"), r0 + 3_800_000);
    assert.equal(await bal("merchant"), m0 + 15_200_000);
  });

  it("pay-it-forward: 10% to the pool on release", async () => {
    const p0 = await bal("pool");
    const payment = await authorize(presets.payItForward(pool.publicKey, 1000, 2));
    await sleep(3000);
    await call("release", payment, stranger);
    assert.equal(await bal("pool"), p0 + 1_900_000);
  });

  it("rejects a split token account that does not belong to the recipient", async () => {
    const payment = await authorize(presets.commission(referrer.publicKey, 2000, 2));
    await sleep(3000);
    const { accounts } = await settleAccounts(program, payment, stranger.publicKey);
    await expectError(
      program.methods.release().accounts(accounts as any)
        .remainingAccounts([{ pubkey: ata.pool, isWritable: true, isSigner: false }])
        .signers([stranger]).rpc(),
      "SplitAccountsMismatch",
    );
    await call("release", payment, stranger);
  });

  it("rejects splits over 100%", async () => {
    const bad = presets.commission(referrer.publicKey, 10_001, 60);
    await expectError(authorize(bad), "SplitsExceedTotal");
  });

  // ------------------------------------------------------------ NFT sales

  describe("escrowed NFT sales", () => {
    const bidderB = Keypair.generate();
    const bidderC = Keypair.generate();
    const payer = () => (provider.wallet as anchor.Wallet).payer;
    let listingSeq = 1;

    async function mintMonkey() {
      const nft = await createMint(conn, payer(), payer().publicKey, null, 0);
      const sellerNft = (await getOrCreateAssociatedTokenAccount(conn, payer(), nft, merchant.publicKey)).address;
      await mintTo(conn, payer(), nft, sellerNft, payer(), 1);
      return { nft, sellerNft };
    }

    async function list(nft: PublicKey, sellerNft: PublicKey, reserve: number) {
      const id = new BN(listingSeq++);
      const listing = listingPda(program.programId, merchant.publicKey, id);
      await program.methods
        .listItem(id, new BN(reserve))
        .accounts({ seller: merchant.publicKey, itemMint: nft, sellerItemToken: sellerNft, tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID } as any)
        .signers([merchant])
        .rpc();
      return listing;
    }

    async function captureSale(payment: PublicKey, listing: PublicKey, nft: PublicKey, owner: PublicKey, amount: number, actor = merchant) {
      const { accounts, remaining } = await settleAccounts(program, payment, actor.publicKey);
      const buyerItemToken = (await getOrCreateAssociatedTokenAccount(conn, payer(), nft, owner)).address;
      return program.methods
        .captureSale(new BN(amount))
        .accounts({ settle: accounts, listing, itemMint: nft, itemVault: itemVaultPda(program.programId, listing), buyerItemToken } as any)
        .remainingAccounts(remaining)
        .signers([actor])
        .rpc();
    }

    const nftOwner = async (nft: PublicKey, owner: PublicKey) =>
      Number((await getAccount(conn, (await getOrCreateAssociatedTokenAccount(conn, payer(), nft, owner)).address)).amount);

    before(async () => {
      for (const [name, kp] of Object.entries({ bidderB, bidderC })) {
        await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL));
        ata[name] = (await getOrCreateAssociatedTokenAccount(conn, payer(), mint, kp.publicKey)).address;
        await mintTo(conn, payer(), mint, ata[name], payer(), 500_000_000);
      }
    });

    it("proxy auction: winner pays second price + increment, NFT and money swap atomically, losers refunded", async () => {
      const { nft, sellerNft } = await mintMonkey();
      const listing = await list(nft, sellerNft, 50_000_000);
      assert.equal(await nftOwner(nft, merchant.publicKey), 0, "NFT is in escrow");

      const [a0, b0, c0, m0] = [await bal("buyer"), await bal("bidderB"), await bal("bidderC"), await bal("merchant")];
      const bidA = await authorize(holds.bid(listing, 60), 120_000_000);                      // max 120
      const bidB = await authorize(holds.bid(listing, 60), 95_000_000, bidderB, ata.bidderB); // max 95
      const bidC = await authorize(holds.bid(listing, 60), 70_000_000, bidderC, ata.bidderC); // max 70

      await expectError(call("release", bidA, stranger), "CaptureRequired");
      const g = await settleAccounts(program, bidA, merchant.publicKey);
      await expectError(
        program.methods.capture(new BN(120_000_000)).accounts(g.accounts as any).remainingAccounts(g.remaining).signers([merchant]).rpc(),
        "WrongListing",
      );
      await expectError(captureSale(bidA, listing, nft, buyer.publicKey, 40_000_000), "BelowReserve");

      await captureSale(bidA, listing, nft, buyer.publicKey, 96_000_000); // second price 95 + 1 increment
      await call("refund", bidB, merchant);
      await call("refund", bidC, merchant);

      assert.equal(await nftOwner(nft, buyer.publicKey), 1, "winner owns the NFT");
      assert.equal(await bal("buyer"), a0 - 96_000_000);
      assert.equal(await bal("merchant"), m0 + 96_000_000);
      assert.equal(await bal("bidderB"), b0);
      assert.equal(await bal("bidderC"), c0);
      const l = await program.account.listing.fetch(listing);
      assert.deepEqual(l.status, { sold: {} });
      // The refunded bid's vault is closed, so a second sale cannot even load it.
      await expectError(captureSale(bidB, listing, nft, bidderB.publicKey, 96_000_000), "AccountNotInitialized");
    });

    it("make an offer: buyer can withdraw before acceptance; seller accepts a discounted offer", async () => {
      const { nft, sellerNft } = await mintMonkey();
      const listing = await list(nft, sellerNft, 30_000_000);
      const b0 = await bal("bidderB");
      const withdrawn = await authorize(holds.offer(listing, 60), 35_000_000, bidderB, ata.bidderB);
      await call("reclaim", withdrawn, bidderB);
      assert.equal(await bal("bidderB"), b0);

      const offer = await authorize(holds.offer(listing, 60), 40_000_000, bidderB, ata.bidderB);
      await captureSale(offer, listing, nft, bidderB.publicKey, 40_000_000);
      assert.equal(await nftOwner(nft, bidderB.publicKey), 1);
      assert.equal(await bal("bidderB"), b0 - 40_000_000);
    });

    it("an uncaptured bid goes back to the bidder after the deadline; seller delists", async () => {
      const { nft, sellerNft } = await mintMonkey();
      const listing = await list(nft, sellerNft, 80_000_000);
      const c0 = await bal("bidderC");
      const bid = await authorize(holds.bid(listing, 2), 60_000_000, bidderC, ata.bidderC);
      await expectError(call("reclaim", bid, bidderC), "ReclaimNotAllowed");
      await sleep(3000);
      await expectError(captureSale(bid, listing, nft, bidderC.publicKey, 60_000_000), "WindowClosed");
      await call("reclaim", bid, bidderC);
      assert.equal(await bal("bidderC"), c0);

      await program.methods
        .delist()
        .accounts({ seller: merchant.publicKey, listing, itemMint: nft, itemVault: itemVaultPda(program.programId, listing), sellerItemToken: sellerNft, tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID } as any)
        .signers([merchant])
        .rpc();
      assert.equal(await nftOwner(nft, merchant.publicKey), 1, "NFT back with the seller");
    });
  });
});
