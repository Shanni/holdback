// Chain layer for the Holdback market (extracted from demo/store.mts): a dUSDC mint,
// funded demo wallets, NFT listings in escrow, and holds that are captured with
// delivery (captureSale), voided by the seller (refund) or taken back by the buyer (reclaim).
//
// RPC env: default http://127.0.0.1:8899 (localnet, airdrops). If it contains "devnet",
// wallets are funded by SOL transfers from .keys/dev-wallet.json instead of airdrops.
import * as anchorNs from "@coral-xyz/anchor";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "node:fs";
import { holds, presets, paymentPda, listingPda, itemVaultPda, settleAccounts, BN, type Policy } from "../../sdk/holdback.ts";

const anchor: any = (anchorNs as any).default ?? anchorNs;
export const USD = 1_000_000; // dUSDC has 6 decimals
export { holds, presets, type Policy };

export class Chain {
  readonly rpc: string;
  readonly devnet: boolean;
  readonly cluster: "devnet" | "localnet";
  readonly conn: Connection;
  readonly idl: any;
  readonly programId: PublicKey;
  readonly funder: Keypair;
  readonly seller = Keypair.generate();
  dollar!: PublicKey;
  private listingSeq = 1;
  private paymentSeq = Date.now();
  private atas = new Map<string, PublicKey>();

  constructor(rpc = process.env.RPC ?? "http://127.0.0.1:8899") {
    this.rpc = rpc;
    this.devnet = rpc.includes("devnet");
    this.cluster = this.devnet ? "devnet" : "localnet";
    this.conn = new Connection(rpc, "confirmed");
    this.idl = JSON.parse(fs.readFileSync(new URL("../../target/idl/holdback.json", import.meta.url), "utf8"));
    this.programId = new PublicKey(this.idl.address);
    this.funder = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(new URL("../../.keys/dev-wallet.json", import.meta.url), "utf8"))),
    );
  }

  program(kp: Keypair) {
    return new anchor.Program(this.idl, new anchor.AnchorProvider(this.conn, new anchor.Wallet(kp), { commitment: "confirmed" }));
  }

  explorer(sig: string) {
    return `https://explorer.solana.com/tx/${sig}?cluster=${this.devnet ? "devnet" : "custom&customUrl=" + encodeURIComponent(this.rpc)}`;
  }

  async ata(mint: PublicKey, owner: PublicKey) {
    const key = mint.toBase58() + owner.toBase58();
    const hit = this.atas.get(key);
    if (hit) return hit;
    const a = (await getOrCreateAssociatedTokenAccount(this.conn, this.funder, mint, owner)).address;
    this.atas.set(key, a);
    return a;
  }

  /** SOL for fees and rent: airdrop on localnet, transfer from the dev wallet on devnet. */
  async fundSol(to: PublicKey, sol: number) {
    if (this.devnet) {
      await sendAndConfirmTransaction(this.conn, new Transaction().add(
        SystemProgram.transfer({ fromPubkey: this.funder.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) }),
      ), [this.funder]);
    } else {
      await this.conn.confirmTransaction(await this.conn.requestAirdrop(to, Math.round(sol * LAMPORTS_PER_SOL)));
    }
  }

  /** Fresh dUSDC mint and a funded seller wallet. */
  async init() {
    if (!this.devnet && (await this.conn.getBalance(this.funder.publicKey)) < 5 * LAMPORTS_PER_SOL) {
      await this.fundSol(this.funder.publicKey, 20);
    }
    this.dollar = await createMint(this.conn, this.funder, this.funder.publicKey, null, 6);
    await this.fundSol(this.seller.publicKey, this.devnet ? 0.05 : 2);
    await this.ata(this.dollar, this.seller.publicKey);
  }

  /** A new demo wallet with SOL for fees and `usd` dUSDC. */
  async newWallet(usd: number) {
    const kp = Keypair.generate();
    await this.fundSol(kp.publicKey, this.devnet ? 0.05 : 2);
    await mintTo(this.conn, this.funder, this.dollar, await this.ata(this.dollar, kp.publicKey), this.funder, Math.round(usd * USD));
    return kp;
  }

  async balance(owner: PublicKey): Promise<number> {
    const r = await this.conn.getTokenAccountBalance(await this.ata(this.dollar, owner));
    return Number(r.value.amount) / USD;
  }

  async nftBalance(nft: PublicKey, owner: PublicKey): Promise<number> {
    const r = await this.conn.getTokenAccountBalance(await this.ata(nft, owner));
    return Number(r.value.amount);
  }

  /** Mint a 1-of-1 NFT to the seller and move it into program escrow with a reserve. */
  async listNft(reserve: number) {
    const nft = await createMint(this.conn, this.funder, this.funder.publicKey, null, 0);
    const mine = await this.ata(nft, this.seller.publicKey);
    await mintTo(this.conn, this.funder, nft, mine, this.funder, 1);
    const id = new BN(this.listingSeq++);
    const listing = listingPda(this.programId, this.seller.publicKey, id);
    const sig = await this.program(this.seller).methods
      .listItem(id, new BN(Math.round(reserve * USD)))
      .accounts({ seller: this.seller.publicKey, itemMint: nft, sellerItemToken: mine, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    return { nft, listing, sig };
  }

  /** Buyer authorizes a hold to the seller: funds sit in a program vault until settled. */
  async hold(buyer: Keypair, policy: Policy, amount: number) {
    const id = new BN(this.paymentSeq++);
    const payment = paymentPda(this.programId, buyer.publicKey, id);
    const sig = await this.program(buyer).methods
      .authorize(id, new BN(Math.round(amount * USD)), policy)
      .accounts({
        buyer: buyer.publicKey, merchant: this.seller.publicKey, mint: this.dollar,
        buyerToken: await this.ata(this.dollar, buyer.publicKey), tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    return { payment, sig };
  }

  /** Delivery versus payment: `amount` to the seller, the rest back to the buyer, NFT to the buyer, one tx. */
  async captureSale(payment: PublicKey, listing: PublicKey, nft: PublicKey, buyer: PublicKey, amount: number) {
    const program = this.program(this.seller);
    const { accounts, remaining } = await settleAccounts(program, payment, this.seller.publicKey);
    return (await program.methods
      .captureSale(new BN(Math.round(amount * USD)))
      .accounts({ settle: accounts, listing, itemMint: nft, itemVault: itemVaultPda(this.programId, listing), buyerItemToken: await this.ata(nft, buyer) })
      .remainingAccounts(remaining)
      .rpc()) as string;
  }

  /** Seller voids a hold: everything back to the buyer. */
  async refund(payment: PublicKey) {
    const program = this.program(this.seller);
    const { accounts, remaining } = await settleAccounts(program, payment, this.seller.publicKey);
    return (await program.methods.refund().accounts(accounts).remainingAccounts(remaining).rpc()) as string;
  }

  /** Buyer takes a hold back (offers any time; guarantees inside the window; bids only after the deadline). */
  async reclaim(buyer: Keypair, payment: PublicKey) {
    const program = this.program(buyer);
    const { accounts, remaining } = await settleAccounts(program, payment, buyer.publicKey);
    return (await program.methods.reclaim().accounts(accounts).remainingAccounts(remaining).rpc()) as string;
  }
}

/** Short, human-readable message from an Anchor / web3 error. */
export function chainError(e: any): string {
  return e?.error?.errorMessage ?? e?.error?.errorCode?.code ?? e?.transactionMessage ?? e?.message ?? String(e);
}
