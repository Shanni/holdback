// Holdback Gallery: a seller agent sells monkey NFTs to buyer agents. It picks the
// sales mechanism from demand, and every payment (offer, bid, purchase) is an
// auth-capture hold on Solana: captured when the deal is fair, refunded otherwise.
//
//   RPC=http://127.0.0.1:8899 node demo/store.mts     then open http://localhost:4022
//   PACE=0.3 speeds up the scenario; RPC=https://api.devnet.solana.com for devnet.
import * as anchorNs from "@coral-xyz/anchor";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import http from "node:http";
import fs from "node:fs";
import {
  presets, holds, paymentPda, listingPda, itemVaultPda, settleAccounts, BN, type Policy,
} from "../sdk/holdback.ts";
import { chooseMechanism, respondToOffer, settleAuction, dutchPrice, type Goal } from "./mechanism.mts";

const anchor: any = (anchorNs as any).default ?? anchorNs;
const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
const DEVNET = RPC.includes("devnet");
const PORT = Number(process.env.PORT ?? 4022);
const PACE = Number(process.env.PACE ?? 1);
const USD = 1_000_000; // dUSDC has 6 decimals

const idl = JSON.parse(fs.readFileSync(new URL("../target/idl/holdback.json", import.meta.url), "utf8"));
const conn = new Connection(RPC, "confirmed");
const funder = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(new URL("../.keys/dev-wallet.json", import.meta.url), "utf8"))),
);
const programFor = (kp: Keypair) =>
  new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * PACE));
const explorer = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=${DEVNET ? "devnet" : "custom&customUrl=" + encodeURIComponent(RPC)}`;

// ------------------------------------------------------------------ live state for the page
type Hold = { agent: string; kind: string; amount: number; captured?: number; status: "held" | "captured" | "refunded"; payment: string };
type Listing = {
  id: string; name: string; hue: number; goal: Goal; mechanism: string; reason: string; price: string;
  status: "listed" | "sold" | "unsold"; holds: Hold[]; buyer?: string; paid?: number;
};
const state = { cluster: DEVNET ? "devnet" : "localnet", program: idl.address as string, listings: [] as Listing[], wallets: {} as Record<string, number>, log: [] as any[] };
const clients = new Set<http.ServerResponse>();
function push() {
  const msg = `data: ${JSON.stringify(state)}\n\n`;
  for (const c of clients) c.write(msg);
}
function log(who: string, text: string, sig?: string) {
  state.log.unshift({ t: new Date().toISOString().slice(11, 19), who, text, tx: sig && explorer(sig) });
  console.log(`${who.padEnd(12)} ${text}${sig ? "  " + sig.slice(0, 10) + "…" : ""}`);
  push();
}

// ------------------------------------------------------------------ chain helpers
let dollar: PublicKey;
const ata = async (mint: PublicKey, owner: PublicKey) => (await getOrCreateAssociatedTokenAccount(conn, funder, mint, owner)).address;

async function fund(to: PublicKey, sol: number) {
  if (DEVNET) {
    await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) }),
    ), [funder]);
  } else {
    await conn.confirmTransaction(await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL));
  }
}

class Party {
  kp = Keypair.generate();
  name: string;
  constructor(name: string) { this.name = name; }
  get pk() { return this.kp.publicKey; }
  program() { return programFor(this.kp); }
}

class Buyer extends Party {
  max: number;
  style: string;
  allowed: string[];
  nextId = Date.now();
  constructor(name: string, style: string, max: number, allowed: string[]) {
    super(name); this.style = style; this.max = max; this.allowed = allowed;
  }

  /** Authorize a hold: nothing reaches the seller until the seller captures it. */
  async hold(seller: Party, policy: Policy, amount: number, kind: string, listing: Listing) {
    const id = new BN(this.nextId++);
    const payment = paymentPda(new PublicKey(idl.address), this.pk, id);
    const sig = await this.program().methods
      .authorize(id, new BN(amount * USD), policy)
      .accounts({ buyer: this.pk, merchant: seller.pk, mint: dollar, buyerToken: await ata(dollar, this.pk), tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    const h: Hold = { agent: this.name, kind, amount, status: "held", payment: payment.toBase58() };
    listing.holds.push(h);
    log(this.name, `${kind} ${amount} dUSDC → held in escrow`, sig);
    return h;
  }

  async reclaim(h: Hold, reason: string) {
    const program = this.program();
    const { accounts, remaining } = await settleAccounts(program, new PublicKey(h.payment), this.pk);
    const sig = await program.methods.reclaim().accounts(accounts).remainingAccounts(remaining).rpc();
    h.status = "refunded";
    log(this.name, `reclaims ${h.amount} dUSDC (${reason})`, sig);
  }
}

class SellerAgent extends Party {
  monkeys = new Map<string, { nft: PublicKey; listing: PublicKey }>();
  seq = 1;

  async listMonkey(name: string, hue: number, goal: Goal): Promise<Listing> {
    const nft = await createMint(conn, funder, funder.publicKey, null, 0);
    const mine = await ata(nft, this.pk);
    await mintTo(conn, funder, nft, mine, funder, 1);
    const id = new BN(this.seq++);
    const listing = listingPda(new PublicKey(idl.address), this.pk, id);
    const sig = await this.program().methods
      .listItem(id, new BN(goal.floor * USD))
      .accounts({ seller: this.pk, itemMint: nft, sellerItemToken: mine, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    this.monkeys.set(listing.toBase58(), { nft, listing });
    const l: Listing = { id: listing.toBase58(), name, hue, goal, mechanism: "", reason: "", price: "", status: "listed", holds: [] };
    state.listings.push(l);
    log("Seller agent", `lists ${name}: NFT moved into escrow, reserve ${goal.floor}`, sig);
    return l;
  }

  decide(l: Listing, watchers: number, secondsListed: number) {
    const { mechanism, reason } = chooseMechanism({ watchers, offers: l.holds.filter((h) => h.status === "held").length, secondsListed, urgent: false }, l.goal);
    if (mechanism !== l.mechanism) {
      l.mechanism = mechanism; l.reason = reason;
      log("Seller agent", `${l.name}: ${mechanism.toUpperCase()}: ${reason}`);
    }
    return mechanism;
  }

  async void(h: Hold, why: string) {
    const program = this.program();
    const { accounts, remaining } = await settleAccounts(program, new PublicKey(h.payment), this.pk);
    const sig = await program.methods.refund().accounts(accounts).remainingAccounts(remaining).rpc();
    h.status = "refunded";
    log("Seller agent", `releases ${h.agent}'s ${h.amount} back (${why})`, sig);
  }

  /** Delivery versus payment: NFT to the buyer and `amount` to the seller in one transaction. */
  async sell(l: Listing, h: Hold, buyer: Buyer, amount: number) {
    const { nft, listing } = this.monkeys.get(l.id)!;
    const program = this.program();
    const { accounts, remaining } = await settleAccounts(program, new PublicKey(h.payment), this.pk);
    const sig = await program.methods
      .captureSale(new BN(amount * USD))
      .accounts({ settle: accounts, listing, itemMint: nft, itemVault: itemVaultPda(program.programId, listing), buyerItemToken: await ata(nft, buyer.pk) })
      .remainingAccounts(remaining)
      .rpc();
    h.status = "captured";
    h.captured = amount;
    l.status = "sold"; l.buyer = buyer.name; l.paid = amount;
    log("Seller agent", `SOLD ${l.name} to ${buyer.name} for ${amount}${amount < h.amount ? ` (held ${h.amount}, ${h.amount - amount} refunded)` : ""}: NFT and payment swapped atomically`, sig);
  }
}

async function balances(parties: Party[]) {
  for (const p of parties) state.wallets[p.name] = Number((await getAccount(conn, await ata(dollar, p.pk))).amount) / USD;
  push();
}

// ------------------------------------------------------------------ the scenario
async function scenario() {
  log("Gallery", `cluster ${state.cluster}, program ${idl.address.slice(0, 8)}…`);
  if (!DEVNET && (await conn.getBalance(funder.publicKey)) < 5 * LAMPORTS_PER_SOL) await fund(funder.publicKey, 20);
  dollar = await createMint(conn, funder, funder.publicKey, null, 6);

  const seller = new SellerAgent("Seller agent");
  const ada = new Buyer("Ada", "collector · will pay up to 120", 120, ["offers", "auction", "dutch", "buy-now"]);
  const bo = new Buyer("Bo", "bargain hunter · max 60, offers & falling prices only", 60, ["offers", "auction", "dutch"]);
  const cy = new Buyer("Cy", "fan · max 95", 95, ["offers", "auction", "dutch", "buy-now"]);
  const everyone = [seller, ada, bo, cy];
  for (const p of everyone) await fund(p.pk, DEVNET ? 0.08 : 2);
  for (const b of [ada, bo, cy]) await mintTo(conn, funder, dollar, await ata(dollar, b.pk), funder, 300 * USD);
  await ata(dollar, seller.pk);
  await balances(everyone);
  log("Gallery", "Owners gave their agents 300 dUSDC each and a spending rule. Every payment is a hold until the seller captures it.");

  // ---- Monkey #1: offers, then an auction once demand shows up
  const m1 = await seller.listMonkey("Monkey #1", 28, { floor: 50, target: 100 });
  seller.decide(m1, 0, 0);
  await sleep(2500);
  log("Bo", "watching Monkey #1");
  seller.decide(m1, 1, 5);
  await sleep(1500);
  const low = await bo.hold(seller, holds.offer(new PublicKey(m1.id), 120), 45, "offer", m1);
  await sleep(1500);
  const r1 = respondToOffer(45, m1.goal);
  await seller.void(low, `offer below the floor: ${r1.action}`);
  await sleep(1500);
  const standing = await bo.hold(seller, holds.offer(new PublicKey(m1.id), 120), 60, "offer", m1);
  const r2 = respondToOffer(60, m1.goal);
  log("Seller agent", `counters Bo's 60 with ${r2.counter}. Bo's owner caps him at 60, so his offer stays held`);
  await sleep(2500);

  log("Ada", "watching Monkey #1");
  log("Cy", "watching Monkey #1");
  if (seller.decide(m1, 3, 15) === "auction") {
    m1.price = "proxy auction · reserve 50 · +1 increment";
    await bo.reclaim(standing, "offer withdrawn, joining the auction instead");
    await sleep(1000);
    const bids = [
      { buyer: ada, h: await ada.hold(seller, holds.bid(new PublicKey(m1.id), 120), 120, "bid (max)", m1) },
      { buyer: cy, h: await cy.hold(seller, holds.bid(new PublicKey(m1.id), 120), 95, "bid (max)", m1) },
      { buyer: bo, h: await bo.hold(seller, holds.bid(new PublicKey(m1.id), 120), 60, "bid (max)", m1) },
    ].map((b) => ({ ...b, max: b.h.amount }));
    await balances(everyone);
    await sleep(3000);
    const result = settleAuction(bids, m1.goal.floor, 1);
    log("Seller agent", `auction closes: highest max ${result.winner!.max}, second ${result.losers[0].max} → winner pays ${result.price}`);
    await seller.sell(m1, result.winner!.h, result.winner!.buyer, result.price);
    for (const l of result.losers) await seller.void(l.h, "outbid");
  }
  await balances(everyone);
  await sleep(2500);

  // ---- Monkey #2: nobody watching, so a Dutch auction finds the price
  const m2 = await seller.listMonkey("Monkey #2", 200, { floor: 40, target: 90 });
  seller.decide(m2, 0, 0);
  m2.price = "buy now 90 · 7-day guarantee";
  await sleep(2500);
  seller.decide(m2, 0, 25);
  for (let t = 0; ; t += 4) {
    const price = dutchPrice(90, m2.goal.floor, 10, 4, t);
    m2.price = `dutch auction · now ${price} · floor 40`;
    push();
    const taker = [bo, cy, ada].find((b) => b.allowed.includes("dutch") && b.max >= price && b !== ada && b !== cy);
    if (taker) {
      log(taker.name, `price ${price} is within my owner's limit → buy`);
      const h = await taker.hold(seller, holds.bid(new PublicKey(m2.id), 60), price, "buy at current price", m2);
      await seller.sell(m2, h, taker, price);
      break;
    }
    await sleep(1200);
  }
  await balances(everyone);
  await sleep(2500);

  // ---- A digital print: fixed price with a 7-day satisfaction guarantee
  const print: Listing = { id: "print", name: "Monkey #1 · hi-res print file", hue: 28, goal: { floor: 5, target: 5 }, mechanism: "buy-now", reason: "digital download → fixed price with a 7-day money-back guarantee", price: "5 dUSDC · reclaim within 7 days", status: "listed", holds: [] };
  state.listings.push(print);
  log("Seller agent", `${print.name}: BUY-NOW: ${print.reason}`);
  const p = await cy.hold(seller, presets.guarantee(7 * 86400), 5, "purchase (7-day guarantee)", print);
  await sleep(2500);
  await cy.reclaim(p, "file was the wrong resolution, money back inside the window, no seller approval needed");
  print.status = "unsold";
  await balances(everyone);
  log("Gallery", "Done. Every dollar either reached the seller with a delivered item, or went back to the buyer.");
}

// ------------------------------------------------------------------ web page
const page = fs.readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
http.createServer((req, res) => {
  if (req.url === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    clients.add(res);
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.url === "/state") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state));
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
}).listen(PORT, () => {
  console.log(`Holdback Gallery on http://localhost:${PORT}`);
  const start = () => scenario().catch((e) => { console.error(e); log("Gallery", `error: ${e.message}`); });
  if (process.env.WAIT) setTimeout(start, Number(process.env.WAIT) * 1000); else start();
});
