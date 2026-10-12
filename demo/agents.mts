// Agents that pay only for what works.
//
// An AI research agent buys a true-solar-time correction (the BaZi engine behind
// Auspice, auspiceoracle.com) from a paid API using an x402-style 402 flow. Instead
// of a final transfer, the payment is an auth-capture hold on Solana (holdback):
//   1. good answer       -> nobody objects, window passes, anyone releases (seller 90%, marketplace 10%)
//   2. seller bug        -> buyer's check fails, it disputes, verifier recomputes, full refund
//   3. bad-faith buyer   -> buyer disputes a correct answer, verifier rules for the seller
//
// Run:  RPC=http://127.0.0.1:8899 node demo/agents.mts      (local validator)
//       RPC=https://api.devnet.solana.com node demo/agents.mts
import * as anchorNs from "@coral-xyz/anchor";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { toTrueSolarTime } from "true-solar-time-mcp";
import http from "node:http";
import fs from "node:fs";
import { presets, paymentPda, settleAccounts, reasonHash, BN, type Policy } from "../sdk/holdback.ts";

const anchor: any = (anchorNs as any).default ?? anchorNs;
const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
const DEVNET = RPC.includes("devnet");
const PORT = 4021;
const PRICE = 250_000; // 0.25 dUSDC (6 decimals)
const WINDOW_SECS = 8;
const DISPUTE_TIMEOUT_SECS = 30;
const MARKETPLACE_BPS = 1000;

const idl = JSON.parse(fs.readFileSync(new URL("../target/idl/holdback.json", import.meta.url), "utf8"));
const conn = new Connection(RPC, "confirmed");
const funder = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(new URL("../.keys/dev-wallet.json", import.meta.url), "utf8"))),
);
const programFor = (kp: Keypair) =>
  new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" }));

// ------------------------------------------------------------------ logging
const C = { seller: 35, buyer: 36, verifier: 33, crank: 90, chain: 32, demo: 1 } as const;
const log = (who: keyof typeof C, msg: string) =>
  console.log(`\x1b[${C[who]}m${who.padEnd(8)}\x1b[0m ${msg}`);
const short = (k: PublicKey | string) => String(k).slice(0, 4) + "…" + String(k).slice(-4);
const link = (sig: string) => (DEVNET ? ` https://explorer.solana.com/tx/${sig}?cluster=devnet` : ` tx ${sig.slice(0, 8)}…`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usdc = (n: number | bigint) => (Number(n) / 1e6).toFixed(4);

// ------------------------------------------------------------------ the check both agents trust
type Request = { year: number; month: number; day: number; hour: number; minute: number; timeZone: string; longitude: number };

/** Cheap self-consistency check the buyer can run without recomputing the answer. */
function consistent(req: Request, res: any): string | null {
  const parts = res.parts.dstMinutes + res.parts.longitudeMinutes + res.parts.equationOfTimeMinutes;
  if (parts !== res.correctionMinutes) return `parts sum to ${parts}, correction says ${res.correctionMinutes}`;
  const clock = Date.UTC(req.year, req.month - 1, req.day, req.hour, req.minute) + res.correctionMinutes * 60000;
  const d = new Date(clock);
  if (d.getUTCHours() !== res.hour || d.getUTCMinutes() !== res.minute)
    return `clock ${req.hour}:${req.minute} + ${res.correctionMinutes} min ≠ returned ${res.hour}:${res.minute}`;
  return null;
}

// ------------------------------------------------------------------ seller: paid API behind HTTP 402
class Seller {
  kp = Keypair.generate();
  faulty = false;
  used = new Set<string>();
  server?: http.Server;
  constructor(private mint: PublicKey, private verifier: PublicKey, private marketplace: PublicKey) {}

  requirements(resource: string) {
    return {
      x402Version: 1,
      error: "payment required",
      accepts: [{
        scheme: "auth-capture",
        network: DEVNET ? "solana-devnet" : "solana-localnet",
        maxAmountRequired: String(PRICE),
        asset: this.mint.toBase58(),
        payTo: this.kp.publicKey.toBase58(),
        resource,
        description: "True solar time correction for a BaZi chart (Auspice engine)",
        extra: {
          program: idl.address,
          policy: {
            preset: "payIfUseful",
            windowSecs: WINDOW_SECS,
            verifier: this.verifier.toBase58(),
            disputeTimeoutSecs: DISPUTE_TIMEOUT_SECS,
            splits: [{ recipient: this.marketplace.toBase58(), bps: MARKETPLACE_BPS }],
          },
        },
      }],
    };
  }

  /** The seller only serves once the hold is on-chain and matches its terms. */
  async verifyHold(paymentKey: string): Promise<string | null> {
    if (this.used.has(paymentKey)) return "payment already used";
    const p: any = await programFor(this.kp).account.payment.fetch(new PublicKey(paymentKey));
    if (!("held" in p.status)) return "payment not held";
    if (!p.merchant.equals(this.kp.publicKey)) return "wrong payee";
    if (!p.mint.equals(this.mint)) return "wrong asset";
    if (p.amount.toNumber() < PRICE) return "underpaid";
    if (!p.policy.judge.equals(this.verifier)) return "untrusted verifier";
    const split = p.policy.splits[0];
    if (!split || !split.recipient.equals(this.marketplace) || split.bps !== MARKETPLACE_BPS) return "marketplace split missing";
    this.used.add(paymentKey);
    return null;
  }

  listen() {
    this.server = http.createServer(async (req, res) => {
      const body = await new Promise<string>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
      const header = req.headers["x-payment"];
      if (!header) {
        log("seller", `402 Payment Required → hold ${usdc(PRICE)} dUSDC, ${WINDOW_SECS}s window, verifier ${short(this.verifier)}, marketplace 10%`);
        res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify(this.requirements(req.url!)));
        return;
      }
      const { payload } = JSON.parse(Buffer.from(String(header), "base64").toString());
      const problem = await this.verifyHold(payload.payment);
      if (problem) {
        log("seller", `rejecting payment ${short(payload.payment)}: ${problem}`);
        res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ error: problem }));
        return;
      }
      const q: Request = JSON.parse(body);
      const answer: any = toTrueSolarTime(q.year, q.month, q.day, q.hour, q.minute, q.timeZone, q.longitude);
      if (this.faulty) answer.hour = (answer.hour + 1) % 24; // a deploy that double-applies DST
      log("seller", `hold ${short(payload.payment)} verified on-chain → serving ${String(answer.hour).padStart(2, "0")}:${String(answer.minute).padStart(2, "0")} ${answer.hourBranch}时${this.faulty ? "  \x1b[31m(buggy build)\x1b[0m" : ""}`);
      const receipt = Buffer.from(JSON.stringify({ payment: payload.payment, status: "held" })).toString("base64");
      res.writeHead(200, { "content-type": "application/json", "x-payment-response": receipt }).end(JSON.stringify(answer));
    });
    return new Promise<void>((r) => this.server!.listen(PORT, r));
  }
}

// ------------------------------------------------------------------ verifier: rules on disputes
class Verifier {
  kp = Keypair.generate();
  /** Recomputes with the reference engine; refunds in full only if the seller was wrong. */
  async review(payment: PublicKey, req: Request, delivered: any) {
    const ref = toTrueSolarTime(req.year, req.month, req.day, req.hour, req.minute, req.timeZone, req.longitude);
    const correct = ref.hour === delivered.hour && ref.minute === delivered.minute && ref.correctionMinutes === delivered.correctionMinutes;
    const refundBps = correct ? 0 : 10_000;
    log("verifier", `recomputed ${ref.hour}:${String(ref.minute).padStart(2, "0")} vs delivered ${delivered.hour}:${String(delivered.minute).padStart(2, "0")} → ${correct ? "seller was right, release" : "seller was wrong, full refund"}`);
    const program = programFor(this.kp);
    const { accounts, remaining } = await settleAccounts(program, payment, this.kp.publicKey);
    const sig = await program.methods.resolve(refundBps).accounts(accounts).remainingAccounts(remaining).rpc();
    log("chain", `resolve(refund ${refundBps / 100}%)${link(sig)}`);
  }
}

// ------------------------------------------------------------------ buyer: an agent with a budget
class BuyerAgent {
  kp = Keypair.generate();
  dishonest = false;
  nextId = Date.now();
  constructor(private verifier: Verifier, private trustedVerifier: PublicKey) {}

  async buy(req: Request): Promise<PublicKey> {
    const url = `http://127.0.0.1:${PORT}/v1/true-solar-time`;
    log("buyer", `GET true solar time for ${req.year}-${req.month}-${req.day} ${req.hour}:${String(req.minute).padStart(2, "0")} ${req.timeZone}`);
    const first = await fetch(url, { method: "POST", body: JSON.stringify(req) });
    const offer = (await first.json()).accepts[0];
    const pol = offer.extra.policy;
    if (pol.verifier !== this.trustedVerifier.toBase58()) throw new Error("seller wants a verifier I don't trust");

    const policy: Policy = {
      ...presets.payIfUseful(new PublicKey(pol.verifier), pol.windowSecs, pol.disputeTimeoutSecs),
      splits: pol.splits.map((s: any) => ({ recipient: new PublicKey(s.recipient), bps: s.bps })),
    };
    const id = new BN(this.nextId++);
    const payment = paymentPda(new PublicKey(idl.address), this.kp.publicKey, id);
    const program = programFor(this.kp);
    const mint = new PublicKey(offer.asset);
    const sig = await program.methods
      .authorize(id, new BN(offer.maxAmountRequired), policy)
      .accounts({
        buyer: this.kp.publicKey, merchant: new PublicKey(offer.payTo), mint,
        buyerToken: (await getOrCreateAssociatedTokenAccount(conn, funder, mint, this.kp.publicKey)).address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    log("chain", `authorize ${usdc(offer.maxAmountRequired)} dUSDC into escrow ${short(payment)}${link(sig)}`);

    const xPayment = Buffer.from(JSON.stringify({
      x402Version: 1, scheme: "auth-capture", network: offer.network, payload: { payment: payment.toBase58(), signature: sig },
    })).toString("base64");
    const paid = await fetch(url, { method: "POST", body: JSON.stringify(req), headers: { "x-payment": xPayment } });
    const answer = await paid.json();

    const problem = consistent(req, answer);
    if (problem || this.dishonest) {
      const claim = problem ?? "I don't like this answer";
      log("buyer", `\x1b[31mobjects:\x1b[0m ${claim} → dispute inside the window`);
      const d = await program.methods.dispute(reasonHash(claim)).accounts({ buyer: this.kp.publicKey, payment }).rpc();
      log("chain", `dispute${link(d)}`);
      await this.verifier.review(payment, req, answer);
    } else {
      log("buyer", `answer passes its checks (${answer.correctionMinutes} min correction, ${answer.hourBranch}时) → does nothing; money stays held until the window ends`);
    }
    return payment;
  }
}

// ------------------------------------------------------------------ crank: anyone can release after the window
async function crank(payment: PublicKey) {
  const kp = Keypair.generate();
  const program = programFor(funder);
  for (;;) {
    const p: any = await program.account.payment.fetch(payment);
    if (!("held" in p.status)) return;
    try {
      const { accounts, remaining } = await settleAccounts(program, payment, funder.publicKey);
      const sig = await program.methods.release().accounts(accounts).remainingAccounts(remaining).rpc();
      log("crank", `window over, no objection → release${link(sig)}`);
      return;
    } catch (e: any) {
      if (!String(e).includes("WindowOpen")) throw e;
      await sleep(1500);
    }
  }
  void kp;
}

// ------------------------------------------------------------------ setup + scenarios
async function fund(to: PublicKey, sol: number) {
  if (DEVNET) {
    await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports: sol * LAMPORTS_PER_SOL }),
    ), [funder]);
  } else {
    await conn.confirmTransaction(await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL));
  }
}

async function main() {
  log("demo", `cluster ${RPC}  program ${idl.address}`);
  if (!DEVNET && (await conn.getBalance(funder.publicKey)) < LAMPORTS_PER_SOL) await fund(funder.publicKey, 10);

  const mint = await createMint(conn, funder, funder.publicKey, null, 6);
  const marketplace = Keypair.generate();
  const verifier = new Verifier();
  const seller = new Seller(mint, verifier.kp.publicKey, marketplace.publicKey);
  const buyer = new BuyerAgent(verifier, verifier.kp.publicKey);
  for (const kp of [buyer.kp, verifier.kp]) await fund(kp.publicKey, DEVNET ? 0.05 : 1);
  const ata = async (k: PublicKey) => (await getOrCreateAssociatedTokenAccount(conn, funder, mint, k)).address;
  const accts = { buyer: await ata(buyer.kp.publicKey), seller: await ata(seller.kp.publicKey), marketplace: await ata(marketplace.publicKey) };
  await mintTo(conn, funder, mint, accts.buyer, funder, 5_000_000);
  await seller.listen();
  const balances = async () => Object.fromEntries(
    await Promise.all(Object.entries(accts).map(async ([k, a]) => [k, usdc((await getAccount(conn, a)).amount)])),
  );
  log("demo", `buyer agent budget 5 dUSDC. balances ${JSON.stringify(await balances())}`);

  const birth: Request = { year: 1990, month: 6, day: 15, hour: 14, minute: 30, timeZone: "Asia/Shanghai", longitude: 121.47 };

  console.log("\n\x1b[1m── 1. good answer ──\x1b[0m");
  const p1 = await buyer.buy(birth);
  await crank(p1);
  log("demo", `balances ${JSON.stringify(await balances())}`);

  console.log("\n\x1b[1m── 2. seller ships a bug ──\x1b[0m");
  seller.faulty = true;
  await buyer.buy(birth);
  seller.faulty = false;
  log("demo", `balances ${JSON.stringify(await balances())}`);

  console.log("\n\x1b[1m── 3. buyer disputes a correct answer ──\x1b[0m");
  buyer.dishonest = true;
  await buyer.buy(birth);
  log("demo", `balances ${JSON.stringify(await balances())}`);

  seller.server?.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
