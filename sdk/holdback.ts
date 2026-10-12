// Thin client for the holdback program: pricing-model presets + helpers that
// derive PDAs and build the settle accounts (including split recipients).
import * as anchor from "@coral-xyz/anchor";
import type { Program } from "@coral-xyz/anchor";
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { Holdback } from "../target/types/holdback";

// Under Node's native ESM loader anchor's CJS build only exposes BN on `default`.
export const BN: typeof anchor.BN = (anchor as any).BN ?? (anchor as any).default.BN;
export type BN = anchor.BN;

export const NO_JUDGE = PublicKey.default;
export const NO_LISTING = PublicKey.default;

export type Split = { recipient: PublicKey; bps: number };
export type Policy = {
  preset: number;
  windowSecs: BN;
  buyerCanReclaim: boolean;
  judge: PublicKey;
  disputeTimeoutSecs: BN;
  refundIfUncaptured: boolean;
  listing: PublicKey;
  splits: Split[];
};

const secs = (n: number) => new BN(n);

/** Pricing models as configuration. Windows are parameters so demos can use seconds. */
export const presets = {
  /** Buyer (human or agent) can take the money back inside the window, no questions asked. */
  guarantee: (windowSecs = 7 * 86400): Policy => ({
    preset: 1, windowSecs: secs(windowSecs), buyerCanReclaim: true,
    judge: NO_JUDGE, disputeTimeoutSecs: secs(0), refundIfUncaptured: false, listing: NO_LISTING, splits: [],
  }),
  /** Optimistic verification: released after the window unless the buyer disputes;
   *  a named verifier (human, oracle or checker agent) rules, possibly a partial refund. */
  payIfUseful: (verifier: PublicKey, windowSecs = 72 * 3600, disputeTimeoutSecs = 7 * 86400): Policy => ({
    preset: 2, windowSecs: secs(windowSecs), buyerCanReclaim: false,
    judge: verifier, disputeTimeoutSecs: secs(disputeTimeoutSecs), refundIfUncaptured: false, listing: NO_LISTING, splits: [],
  }),
  /** Referrer / marketplace commission, held until the refund window closes, voided on refund. */
  commission: (referrer: PublicKey, bps: number, windowSecs = 30 * 86400): Policy => ({
    preset: 3, windowSecs: secs(windowSecs), buyerCanReclaim: true,
    judge: NO_JUDGE, disputeTimeoutSecs: secs(0), refundIfUncaptured: false, listing: NO_LISTING, splits: [{ recipient: referrer, bps }],
  }),
  /** On release, a slice funds a pool that pays for someone else's purchase. */
  payItForward: (pool: PublicKey, bps: number, windowSecs = 7 * 86400): Policy => ({
    preset: 4, windowSecs: secs(windowSecs), buyerCanReclaim: true,
    judge: NO_JUDGE, disputeTimeoutSecs: secs(0), refundIfUncaptured: false, listing: NO_LISTING, splits: [{ recipient: pool, bps }],
  }),
};

/** Holds that only move if the seller captures them; otherwise the buyer takes them back. */
export const holds = {
  /** A bid on an escrowed item (auction, Dutch purchase): binding until the deadline. */
  bid: (listing: PublicKey, deadlineSecs: number): Policy => ({
    preset: 5, windowSecs: secs(deadlineSecs), buyerCanReclaim: false,
    judge: NO_JUDGE, disputeTimeoutSecs: secs(0), refundIfUncaptured: true, listing, splits: [],
  }),
  /** An offer the buyer may withdraw any time before the seller accepts. */
  offer: (listing: PublicKey, expirySecs: number): Policy => ({
    preset: 6, windowSecs: secs(expirySecs), buyerCanReclaim: true,
    judge: NO_JUDGE, disputeTimeoutSecs: secs(0), refundIfUncaptured: true, listing, splits: [],
  }),
};

export function listingPda(programId: PublicKey, seller: PublicKey, listingId: BN) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("listing"), seller.toBuffer(), listingId.toArrayLike(Buffer, "le", 8)],
    programId,
  )[0];
}

export function itemVaultPda(programId: PublicKey, listing: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("item"), listing.toBuffer()], programId)[0];
}

export function paymentPda(programId: PublicKey, buyer: PublicKey, paymentId: BN) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("payment"), buyer.toBuffer(), paymentId.toArrayLike(Buffer, "le", 8)],
    programId,
  )[0];
}

export function vaultPda(programId: PublicKey, payment: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), payment.toBuffer()], programId)[0];
}

/** Accounts + remaining accounts for reclaim / resolve / release / refund / expireDispute. */
export async function settleAccounts(program: Program<Holdback>, payment: PublicKey, actor: PublicKey) {
  const p = await program.account.payment.fetch(payment);
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(p.mint, owner, true);
  return {
    accounts: {
      actor,
      payment,
      vault: vaultPda(program.programId, payment),
      mint: p.mint,
      buyerToken: ata(p.buyer),
      merchantToken: ata(p.merchant),
      buyer: p.buyer,
      tokenProgram: TOKEN_PROGRAM_ID,
    },
    remaining: p.policy.splits.map((s) => ({ pubkey: ata(s.recipient), isWritable: true, isSigner: false })),
  };
}

export function reasonHash(text: string): number[] {
  return Array.from(createHash("sha256").update(text).digest());
}
