// Holdback market server: the contract in demo/API.md.
//
//   node demo/market/server.mts          (server + scripted buyer agents, http://localhost:4022)
//
// One seller agent sells NFTs. It picks the sales mechanism from demand (watchers, time,
// goal), negotiates with a hidden floor, runs proxy and Dutch auctions, and every offer,
// bid and purchase is an on-chain hold: captured with delivery when a deal clears,
// refunded otherwise. Buyers (scripted agents, humans on the page, MCP clients) all go
// through the same HTTP API.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { Chain, holds, presets, chainError, type Policy } from "./chain.mts";
import { chooseMechanism, settleAuction, dutchPrice } from "../mechanism.mts";
import { sellerReply, type Goal } from "./negotiation.mts";
import { createScenario } from "./scenario.mts";

const PORT = Number(process.env.PORT ?? 4022);
const AUCTION_SECS = Number(process.env.AUCTION_SECS ?? 45);
const DUTCH_STEP_SECS = Number(process.env.DUTCH_STEP_SECS ?? 6);
const STALE_SECS = Number(process.env.STALE_SECS ?? 20);
const BUYER_USD = Number(process.env.BUYER_USD ?? 300);
const GUARANTEE_SECS = 7 * 86400;
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

// ------------------------------------------------------------------ public types (demo/API.md)
type Mechanism = "buy-now" | "offers" | "auction" | "dutch";
type HoldStatus = "held" | "captured" | "refunded";
type Hold = {
  id: string; itemId: string; buyer: string; kind: "offer" | "bid" | "buy";
  amount: number; captured?: number; status: HoldStatus; tx: string; settleTx?: string;
};
type Turn = {
  from: "buyer" | "seller"; buyer: string; amount: number;
  action: "offer" | "counter" | "accept" | "decline" | "walk_away"; message: string; at: string;
};
type Item = {
  id: string; name: string; hue: number; image?: string;
  mechanism: Mechanism; reason: string;
  goal: Goal;
  ask: number;
  price?: number;
  status: "listed" | "sold" | "unsold";
  soldTo?: string; soldFor?: number; saleTx?: string;
  watchers: string[];
  auction?: { endsAt: string; bids: number; leader?: string; reserveMet: boolean; price?: number; closed?: boolean };
  negotiations: Record<string, Turn[]>;
  holds: Hold[];
  // extensions
  kind: "nft" | "digital";
  guarantee?: string;
  listing?: string;
  nft?: string;
};
type Buyer = { id: string; name: string; kind: "human" | "agent" | "mcp"; max?: number; wallet: string; balance: number };

// ------------------------------------------------------------------ internal state
type Lot = {
  item: Item;
  floor: number;
  listing?: PublicKey;
  nft?: PublicKey;
  listedAt: number;
  staleSecs: number;
  openToOffers: boolean;                                    // no watchers yet: offers instead of buy-now
  offers: Map<string, string>;                              // buyerId -> held offer hold id
  counters: Map<string, number>;                            // buyerId -> seller's standing price for them
  bids: Map<string, { max: number; holdId: string }>;       // buyerId -> proxy bid
  dutch?: { start: number; step: number; startedAt: number };
  endsAt?: number;
  settling?: boolean;
};
type HoldRec = { pub: Hold; payment: PublicKey; buyerId: string; lot: Lot; policy: "offer" | "bid" | "guarantee" };
type BuyerRec = { pub: Buyer; kp: Keypair };

const chain = new Chain();
const lots: Lot[] = [];
const lotById = new Map<string, Lot>();
const buyers = new Map<string, BuyerRec>();
const holdById = new Map<string, HoldRec>();
const log: { t: string; who: string; text: string; tx?: string }[] = [];
let sellerBalance = 0;
let scenario: ReturnType<typeof createScenario> | undefined;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const bad = (m: string) => new HttpError(400, m);

// ------------------------------------------------------------------ live updates
const clients = new Set<http.ServerResponse>();
const RAILS_FILE = fileURLToPath(new URL("./rails.json", import.meta.url));
function rails() {
  const solana = {
    id: "solana", name: "Solana", status: chain.cluster,
    explorer: `https://explorer.solana.com/address/${chain.programId.toBase58()}?cluster=${chain.devnet ? "devnet" : "custom&customUrl=" + encodeURIComponent(chain.rpc)}`,
    note: "holds, captureSale (NFT delivery vs payment), refunds and reclaims",
  };
  let extra: any[] = [];
  try { const r = JSON.parse(fs.readFileSync(RAILS_FILE, "utf8")); if (Array.isArray(r)) extra = r.filter((x) => x?.id !== "solana"); } catch {}
  return [solana, ...extra];
}
const snapshot = () => ({
  cluster: chain.cluster,
  rails: rails(),
  program: chain.programId.toBase58(),
  items: lots.map((l) => l.item),
  buyers: [...buyers.values()].map((b) => b.pub),
  log,
  seller: { name: "Seller agent", wallet: chain.seller.publicKey.toBase58(), balance: sellerBalance },
  scenario: scenario?.status(),
});
let pushTimer: NodeJS.Timeout | undefined;
function push() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const c of clients) c.write(msg);
  }, 40);
}
function say(who: string, text: string, sig?: string) {
  log.unshift({ t: new Date().toISOString().slice(11, 19), who, text, tx: sig && chain.explorer(sig) });
  if (log.length > 300) log.length = 300;
  console.log(`${who.padEnd(13)} ${text}${sig ? "  " + sig.slice(0, 12) + "…" : ""}`);
  push();
}

/** Every mutating step runs here, one at a time: chain order matches the story. */
let queue: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(refreshBalances, refreshBalances).catch(() => {});
  return run;
}
async function refreshBalances() {
  await Promise.all([
    ...[...buyers.values()].map(async (b) => { try { b.pub.balance = await chain.balance(b.kp.publicKey); } catch {} }),
    (async () => { try { sellerBalance = await chain.balance(chain.seller.publicKey); } catch {} })(),
  ]);
  push();
}

// ------------------------------------------------------------------ helpers
const now = () => new Date().toISOString();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
function lotOr404(id: string) {
  const l = lotById.get(id);
  if (!l) throw new HttpError(404, `no item ${id}`);
  return l;
}
function buyerOr400(id: unknown) {
  const b = typeof id === "string" ? buyers.get(id) : undefined;
  if (!b) throw bad(`unknown buyerId ${id}; register with POST /api/buyers`);
  return b;
}
function amountOr400(v: unknown, what = "amount") {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw bad(`${what} must be a positive number of dUSDC`);
  return Math.round(n * 100) / 100;
}
function listedOr400(lot: Lot) {
  if (lot.item.status !== "listed") throw bad(`${lot.item.name} is ${lot.item.status}${lot.item.soldTo ? ` (to ${lot.item.soldTo} for ${lot.item.soldFor})` : ""}`);
}
function turns(lot: Lot, name: string) {
  return (lot.item.negotiations[name] ??= []);
}
function turn(lot: Lot, t: Omit<Turn, "at">) {
  const full = { ...t, at: now() };
  turns(lot, t.buyer).push(full);
  return full;
}

async function newHold(b: BuyerRec, lot: Lot, kind: Hold["kind"], amount: number, policy: Policy, pol: HoldRec["policy"]) {
  if (b.pub.balance < amount) throw bad(`${b.pub.name} has ${b.pub.balance} dUSDC, not enough to hold ${amount}`);
  let r;
  try { r = await chain.hold(b.kp, policy, amount); } catch (e) { throw bad(`hold failed: ${chainError(e)}`); }
  b.pub.balance -= amount;
  const pub: Hold = { id: r.payment.toBase58(), itemId: lot.item.id, buyer: b.pub.name, kind, amount, status: "held", tx: chain.explorer(r.sig) };
  holdById.set(pub.id, { pub, payment: r.payment, buyerId: b.pub.id, lot, policy: pol });
  lot.item.holds.push(pub);
  const label = { offer: "offer", bid: "max bid", buy: "purchase" }[kind];
  say(b.pub.name, `${label} ${amount} dUSDC on ${lot.item.name} → held in escrow${pol === "guarantee" ? " (7-day money-back guarantee)" : ""}`, r.sig);
  return holdById.get(pub.id)!;
}

/** Seller voids a hold: the buyer gets everything back. */
async function voidHold(h: HoldRec, why: string) {
  if (h.pub.status !== "held") return;
  const sig = await chain.refund(h.payment);
  h.pub.status = "refunded";
  h.pub.settleTx = chain.explorer(sig);
  if (h.lot.offers.get(h.buyerId) === h.pub.id) h.lot.offers.delete(h.buyerId);
  say("Seller agent", `releases ${h.pub.buyer}'s ${h.pub.amount} dUSDC hold (${why})`, sig);
}

/** Delivery versus payment: NFT to the buyer, `price` to the seller, rest refunded, one tx. */
async function sell(lot: Lot, h: HoldRec, price: number, othersWhy: string) {
  const b = buyers.get(h.buyerId)!;
  const sig = await chain.captureSale(h.payment, lot.listing!, lot.nft!, b.kp.publicKey, price);
  h.pub.status = "captured";
  h.pub.captured = price;
  h.pub.settleTx = chain.explorer(sig);
  Object.assign(lot.item, { status: "sold", soldTo: b.pub.name, soldFor: price, saleTx: chain.explorer(sig), price: undefined });
  lot.dutch = undefined;
  lot.offers.delete(h.buyerId);
  const back = h.pub.amount - price;
  say("Seller agent", `SOLD ${lot.item.name} to ${b.pub.name} for ${price} dUSDC${back > 0 ? ` (held ${h.pub.amount}, ${back} refunded)` : ""}: NFT and payment swapped in one transaction`, sig);
  for (const other of holdById.values()) {
    if (other.lot === lot && other.pub.status === "held" && other !== h) await voidHold(other, othersWhy);
  }
}

// ------------------------------------------------------------------ seller agent: mechanism
async function decide(lot: Lot, trigger: string, force = false) {
  const it = lot.item;
  if (it.status !== "listed" || it.kind === "digital") return;
  if (it.mechanism === "auction" && it.auction && !it.auction.closed) {
    if (force) say("Seller agent", `${it.name}: auction running; goal "${it.goal}" applies after it closes`);
    return;
  }
  const choice = chooseMechanism(
    { watchers: it.watchers.length, offers: lot.offers.size, secondsListed: (Date.now() - lot.listedAt) / 1000, urgent: it.goal === "quick-sale", staleSecs: lot.staleSecs },
    { floor: lot.floor, target: it.ask },
  );
  let mechanism = choice.mechanism, reason = choice.reason;
  if (mechanism === "buy-now" && lot.openToOffers) {
    mechanism = "offers";
    reason = `open to offers from anyone; asking ${it.ask}, counters anything in between`;
  }
  if (mechanism === it.mechanism) {
    if (reason !== it.reason) { it.reason = reason; push(); }
    return;
  }
  // A running Dutch auction keeps going (anyone can buy at the current price) unless demand calls for an auction.
  if (it.mechanism === "dutch" && mechanism !== "auction" && !force) return;
  const from = it.mechanism;
  it.mechanism = mechanism;
  it.reason = reason;
  if (from === "dutch") lot.dutch = undefined;
  say("Seller agent", `${it.name}: ${from ? `${from} → ` : ""}${mechanism.toUpperCase()} (${trigger}): ${reason}`);
  if (mechanism === "buy-now") it.price = it.ask;
  else if (mechanism === "offers") it.price = undefined;
  else if (mechanism === "dutch") {
    const step = Math.max(1, Math.round((it.ask - lot.floor) / 5));
    lot.dutch = { start: it.ask, step, startedAt: Date.now() };
    it.price = it.ask;
    say("Seller agent", `${it.name}: Dutch auction starts at ${it.ask}, drops ${step} every ${DUTCH_STEP_SECS}s until someone buys`);
  } else if (mechanism === "auction") {
    it.price = undefined;
    lot.endsAt = Date.now() + AUCTION_SECS * 1000;
    lot.bids.clear();
    it.auction = { endsAt: new Date(lot.endsAt).toISOString(), bids: 0, reserveMet: false };
    say("Seller agent", `${it.name}: proxy auction open for ${AUCTION_SECS}s. Bid your max; the winner pays the 2nd-highest max + 1`);
    for (const id of [...lot.offers.values()]) {
      const h = holdById.get(id)!;
      await voidHold(h, "switching to an auction: bid instead");
      turn(lot, { from: "seller", buyer: h.pub.buyer, amount: 0, action: "decline", message: "Several buyers are interested, so this is going to auction. Your offer hold is released: place a bid instead." });
    }
  }
  push();
}

async function watch(lot: Lot, b: BuyerRec) {
  if (lot.item.watchers.includes(b.pub.name)) return;
  lot.item.watchers.push(b.pub.name);
  say(b.pub.name, `watching ${lot.item.name}`);
  await decide(lot, `${lot.item.watchers.length} watching`);
}

function updateAuction(lot: Lot) {
  const it = lot.item;
  if (!it.auction) return;
  const bids = [...lot.bids.entries()].map(([buyerId, b]) => ({ buyerId, ...b }));
  const top = [...bids].sort((a, b) => b.max - a.max)[0];
  const r = settleAuction(bids, lot.floor, 1);
  it.auction.bids = bids.length;
  it.auction.leader = top ? buyers.get(top.buyerId)!.pub.name : undefined;
  it.auction.reserveMet = !!r.winner;
  it.auction.price = r.winner ? r.price : undefined;
}

async function closeAuction(lot: Lot) {
  const it = lot.item;
  if (!it.auction || it.auction.closed || it.status !== "listed") return;
  const bids = [...lot.bids.entries()].map(([buyerId, b]) => ({ buyerId, ...b }));
  const r = settleAuction(bids, lot.floor, 1);
  it.auction.closed = true;
  if (r.winner) {
    const name = buyers.get(r.winner.buyerId)!.pub.name;
    const second = r.losers[0]?.max;
    say("Seller agent", `${it.name}: auction closed. ${name} had the highest max; ${second !== undefined ? `second-highest max ${second}` : "no other bids"} → pays ${r.price}${second === undefined || r.price === lot.floor ? " (reserve)" : " (2nd price + 1)"}`);
    await sell(lot, holdById.get(r.winner.holdId)!, r.price, "outbid");
  } else {
    say("Seller agent", `${it.name}: auction closed with ${bids.length ? "no bid at the reserve" : "no bids"}; every hold goes back`);
    for (const b of bids) await voidHold(holdById.get(b.holdId)!, "reserve not met");
    it.status = "unsold";
    it.reason = "auction closed below the reserve";
  }
  push();
}

// timers: Dutch price ticks, staleness checks, auction close
setInterval(() => {
  for (const lot of lots) {
    const it = lot.item;
    if (it.status !== "listed") continue;
    if (it.mechanism === "dutch" && lot.dutch) {
      const p = dutchPrice(lot.dutch.start, lot.floor, lot.dutch.step, DUTCH_STEP_SECS, (Date.now() - lot.dutch.startedAt) / 1000);
      if (p !== it.price) {
        it.price = p;
        say("Seller agent", `${it.name}: Dutch price now ${p}${p === lot.floor ? " (lowest it goes)" : ""}`);
      }
    }
    if (it.mechanism === "buy-now" && lot.staleSecs > 0 && (Date.now() - lot.listedAt) / 1000 > lot.staleSecs && !lot.settling) {
      lot.settling = true;
      locked(() => decide(lot, "no interest")).catch((e) => say("Market", `error: ${chainError(e)}`)).finally(() => (lot.settling = false));
    }
    if (it.mechanism === "auction" && lot.endsAt && Date.now() >= lot.endsAt && !it.auction?.closed && !lot.settling) {
      lot.settling = true;
      locked(() => closeAuction(lot)).catch((e) => say("Market", `auction settle error: ${chainError(e)}`)).finally(() => (lot.settling = false));
    }
  }
}, 500);

// ------------------------------------------------------------------ API handlers
async function createBuyer(body: any): Promise<Buyer> {
  const name = String(body?.name ?? "").trim().slice(0, 40);
  if (!name) throw bad("name required");
  const kind = (["human", "agent", "mcp"].includes(body?.kind) ? body.kind : "human") as Buyer["kind"];
  const existing = [...buyers.values()].find((b) => b.pub.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.pub;
  const pending = creating.get(name.toLowerCase());
  if (pending) return pending;
  const p = (async () => {
    const kp = await chain.newWallet(BUYER_USD);
    let id = slug(name);
    while (buyers.has(id)) id += "-x";
    const max = body?.max === undefined || body?.max === null ? undefined : amountOr400(body.max, "max");
    const pub: Buyer = { id, name, kind, max, wallet: kp.publicKey.toBase58(), balance: BUYER_USD };
    buyers.set(id, { pub, kp });
    say("Market", `${name} (${kind}${max ? `, owner's limit ${max}` : ""}) joins with a demo wallet: ${BUYER_USD} dUSDC + SOL for fees`);
    return pub;
  })();
  creating.set(name.toLowerCase(), p);
  try { return await p; } finally { creating.delete(name.toLowerCase()); }
}
const creating = new Map<string, Promise<Buyer>>();

async function offer(lot: Lot, body: any) {
  const b = buyerOr400(body?.buyerId);
  const amount = amountOr400(body?.amount);
  listedOr400(lot);
  if (lot.item.kind === "digital") throw bad(`${lot.item.name} is fixed price (${lot.item.ask}): use buy`);
  await watch(lot, b);
  const it = lot.item;
  if (it.mechanism === "auction") throw bad(`${it.name} is in a proxy auction until ${it.auction?.endsAt}: place a bid instead`);
  if (it.mechanism === "dutch") throw bad(`${it.name} is in a Dutch auction at ${it.price} dUSDC right now: use buy`);
  const prev = lot.offers.get(b.pub.id);
  if (prev) await voidHold(holdById.get(prev)!, "replaced by a new offer");
  const h = await newHold(b, lot, "offer", amount, holds.offer(lot.listing!, 86400), "offer");
  lot.offers.set(b.pub.id, h.pub.id);
  turn(lot, { from: "buyer", buyer: b.pub.name, amount, action: "offer", message: String(body?.message ?? `I offer ${amount} dUSDC (held in escrow).`).slice(0, 280) });
  const round = turns(lot, b.pub.name).filter((t) => t.from === "buyer" && t.action === "offer").length;
  const r = sellerReply({ offer: amount, ask: it.ask, floor: lot.floor, goal: it.goal, round, lastCounter: lot.counters.get(b.pub.id) });
  const reply = turn(lot, { from: "seller", buyer: b.pub.name, amount: r.amount, action: r.action, message: r.message });
  say("Seller agent", `→ ${b.pub.name} (round ${round}): ${r.message}`);
  if (r.action === "accept") await sell(lot, h, r.amount, `sold to ${b.pub.name}`);
  else if (r.action === "decline") { lot.counters.set(b.pub.id, it.ask); await voidHold(h, "offer below what the seller will take"); }
  else lot.counters.set(b.pub.id, r.amount);
  return { hold: h.pub, reply, item: it };
}

async function respond(lot: Lot, body: any) {
  const b = buyerOr400(body?.buyerId);
  const action = body?.action;
  if (action !== "accept" && action !== "walk_away") throw bad(`action must be "accept" or "walk_away"`);
  listedOr400(lot);
  const it = lot.item;
  const prevId = lot.offers.get(b.pub.id);
  const prev = prevId ? holdById.get(prevId) : undefined;
  if (action === "walk_away") {
    turn(lot, { from: "buyer", buyer: b.pub.name, amount: prev?.pub.amount ?? 0, action: "walk_away", message: String(body?.message ?? "I'll pass.").slice(0, 280) });
    if (prev) {
      const sig = await chain.reclaim(b.kp, prev.payment);
      prev.pub.status = "refunded";
      prev.pub.settleTx = chain.explorer(sig);
      lot.offers.delete(b.pub.id);
      say(b.pub.name, `walks away from ${it.name} and takes back the ${prev.pub.amount} dUSDC offer hold`, sig);
    } else say(b.pub.name, `walks away from ${it.name}`);
    const standing = lot.counters.get(b.pub.id) ?? it.ask;
    const reply = turn(lot, { from: "seller", buyer: b.pub.name, amount: standing, action: "counter", message: `No problem. ${standing} dUSDC stands if you change your mind.` });
    return { hold: prev?.pub, reply, item: it };
  }
  if (it.mechanism === "auction") throw bad(`${it.name} is in an auction now: place a bid instead`);
  const price = lot.counters.get(b.pub.id);
  if (price === undefined) throw bad(`no counter-offer from the seller to accept yet: make an offer first`);
  if (prev) await voidHold(prev, "replaced by the accepted price");
  const h = await newHold(b, lot, "offer", price, holds.offer(lot.listing!, 86400), "offer");
  turn(lot, { from: "buyer", buyer: b.pub.name, amount: price, action: "accept", message: String(body?.message ?? `Deal at ${price}.`).slice(0, 280) });
  const reply = turn(lot, { from: "seller", buyer: b.pub.name, amount: price, action: "accept", message: `Deal at ${price} dUSDC. The NFT is yours.` });
  await sell(lot, h, price, `sold to ${b.pub.name}`);
  return { hold: h.pub, reply, item: it };
}

async function bid(lot: Lot, body: any) {
  const b = buyerOr400(body?.buyerId);
  const max = amountOr400(body?.max, "max");
  listedOr400(lot);
  await watch(lot, b);
  const it = lot.item;
  if (it.mechanism !== "auction" || !it.auction || it.auction.closed) throw bad(`${it.name} is not in an auction (mechanism: ${it.mechanism})`);
  if (Date.now() >= lot.endsAt!) throw bad("auction already closed");
  const prev = lot.bids.get(b.pub.id);
  if (prev && prev.max >= max) throw bad(`your max bid is already ${prev.max}: raise it to bid again`);
  const deadline = Math.ceil((lot.endsAt! - Date.now()) / 1000) + 600;
  const h = await newHold(b, lot, "bid", max, holds.bid(lot.listing!, deadline), "bid");
  if (prev) await voidHold(holdById.get(prev.holdId)!, "replaced by a higher max bid");
  lot.bids.set(b.pub.id, { max, holdId: h.pub.id });
  updateAuction(lot);
  say("Seller agent", `${it.name}: ${it.auction.bids} bidder${it.auction.bids > 1 ? "s" : ""}, leader ${it.auction.leader}, current price ${it.auction.price ?? "below reserve"}`);
  return { hold: h.pub, item: it };
}

async function buy(lot: Lot, body: any) {
  const b = buyerOr400(body?.buyerId);
  listedOr400(lot);
  const it = lot.item;
  if (it.kind === "digital") {
    const h = await newHold(b, lot, "buy", it.ask, presets.guarantee(GUARANTEE_SECS), "guarantee");
    Object.assign(it, { status: "sold", soldTo: b.pub.name, soldFor: it.ask, saleTx: h.pub.tx });
    say("Seller agent", `delivers ${it.name} to ${b.pub.name}. Payment releases in 7 days unless ${b.pub.name} reclaims it`);
    return { hold: h.pub, item: it };
  }
  if (it.mechanism === "auction") throw bad(`${it.name} is in a proxy auction: place a bid instead`);
  const price = it.mechanism === "dutch" ? it.price! : it.mechanism === "offers" ? it.ask : (it.price ?? it.ask);
  const h = await newHold(b, lot, "buy", price, holds.bid(lot.listing!, 600), "bid");
  await sell(lot, h, price, `sold to ${b.pub.name}`);
  return { hold: h.pub, item: it };
}

async function reclaim(h: HoldRec, body: any) {
  const b = buyerOr400(body?.buyerId);
  if (h.buyerId !== b.pub.id) throw new HttpError(403, "not your hold");
  if (h.pub.status !== "held") throw bad(`hold is already ${h.pub.status}`);
  let sig: string;
  try { sig = await chain.reclaim(b.kp, h.payment); } catch (e) {
    throw bad(`cannot reclaim: ${chainError(e)}${h.policy === "bid" ? " (bids are binding until the auction deadline)" : ""}`);
  }
  h.pub.status = "refunded";
  h.pub.settleTx = chain.explorer(sig);
  const lot = h.lot, it = lot.item;
  if (lot.offers.get(b.pub.id) === h.pub.id) {
    lot.offers.delete(b.pub.id);
    turn(lot, { from: "buyer", buyer: b.pub.name, amount: h.pub.amount, action: "walk_away", message: "Withdrawing my offer." });
  }
  if (lot.bids.get(b.pub.id)?.holdId === h.pub.id) { lot.bids.delete(b.pub.id); updateAuction(lot); }
  if (h.policy === "guarantee" && it.soldTo === b.pub.name) {
    Object.assign(it, { status: "listed", soldTo: undefined, soldFor: undefined, saleTx: undefined });
    say(b.pub.name, `reclaims ${h.pub.amount} dUSDC for ${it.name} inside the 7-day guarantee, no seller approval needed`, sig);
  } else say(b.pub.name, `reclaims ${h.pub.amount} dUSDC (${h.pub.kind} on ${it.name})`, sig);
  return { hold: h.pub };
}

/** Extension: the seller lists an item. Used by the scenario; handy for live demos. */
async function listItem(body: any) {
  const name = String(body?.name ?? "").trim();
  if (!name) throw bad("name required");
  const ask = amountOr400(body?.ask, "ask");
  const floor = body?.floor === undefined ? Math.round(ask * 0.6) : amountOr400(body.floor, "floor");
  const kind: Item["kind"] = body?.kind === "digital" ? "digital" : "nft";
  const goal: Goal = body?.goal === "quick-sale" ? "quick-sale" : "best-price";
  let id = slug(name);
  while (lotById.has(id)) id += "-x";
  const lot: Lot = {
    item: {
      id, name, hue: Number(body?.hue ?? 30), image: body?.image, mechanism: "" as Mechanism, reason: "", goal, ask,
      status: "listed", watchers: [], negotiations: {}, holds: [], kind,
    },
    floor, listedAt: Date.now(), staleSecs: body?.staleSecs === undefined ? STALE_SECS : Number(body.staleSecs),
    openToOffers: body?.mechanism === "offers",
    offers: new Map(), counters: new Map(), bids: new Map(),
  };
  if (kind === "digital") {
    Object.assign(lot.item, { mechanism: "buy-now", price: ask, guarantee: "7 days", reason: "digital download → fixed price with a 7-day money-back guarantee" });
    lots.push(lot); lotById.set(id, lot);
    say("Seller agent", `lists ${name}: BUY-NOW at ${ask}: ${lot.item.reason}`);
    return lot.item;
  }
  const r = await chain.listNft(floor);
  Object.assign(lot, { listing: r.listing, nft: r.nft, listedAt: Date.now() });
  Object.assign(lot.item, { listing: r.listing.toBase58(), nft: r.nft.toBase58() });
  lots.push(lot); lotById.set(id, lot);
  say("Seller agent", `lists ${name} (ask ${ask}, goal ${goal}): NFT moved into escrow, reserve hidden`, r.sig);
  await decide(lot, "new listing");
  return lot.item;
}

// ------------------------------------------------------------------ HTTP
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".woff2": "font/woff2",
};
function serveFile(res: http.ServerResponse, rel: string) {
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(file).pipe(res);
  return true;
}
const json = (res: http.ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" }).end(JSON.stringify(body));
async function readBody(req: http.IncomingMessage) {
  let raw = "";
  for await (const c of req) { raw += c; if (raw.length > 1e5) throw bad("body too large"); }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw bad("body must be JSON"); }
}

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  const m = req.method ?? "GET";
  if (m === "OPTIONS") {
    return res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" }).end();
  }
  if (p === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    clients.add(res);
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  if (!p.startsWith("/api/")) {
    if (m === "GET" && (p === "/" || p === "/index.html")) { if (serveFile(res, "index.html")) return; }
    if (m === "GET" && p.startsWith("/public/") && serveFile(res, decodeURIComponent(p.slice(8)))) return;
    if (m === "GET" && serveFile(res, decodeURIComponent(p.slice(1)))) return;
    return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
  const parts = p.split("/").filter(Boolean).slice(1).map(decodeURIComponent); // after "api"
  const body = m === "POST" ? await readBody(req) : {};
  const [a, id, verb] = parts;

  if (m === "GET" && a === "items" && !id) return json(res, 200, lots.map((l) => l.item));
  if (m === "GET" && a === "items" && id && !verb) {
    const lot = lotOr404(id);
    const buyerId = url.searchParams.get("buyerId");
    if (buyerId) await locked(() => watch(lot, buyerOr400(buyerId)));
    return json(res, 200, lot.item);
  }
  if (m === "GET" && a === "state") return json(res, 200, snapshot());
  if (m === "POST" && a === "buyers" && !id) {
    const b = await createBuyer(body);
    await refreshBalances();
    return json(res, 200, b);
  }
  if (m === "GET" && a === "buyers" && !id) return json(res, 200, [...buyers.values()].map((b) => b.pub));
  if (m === "GET" && a === "buyers" && id) {
    const b = buyers.get(id);
    if (!b) throw new HttpError(404, `no buyer ${id}`);
    return json(res, 200, { ...b.pub, holds: [...holdById.values()].filter((h) => h.buyerId === id).map((h) => h.pub) });
  }
  if (m === "POST" && a === "items" && id && verb) {
    const lot = lotOr404(id);
    const handler = { offer, respond, bid, buy }[verb as "offer"];
    if (!handler) throw new HttpError(404, `unknown action ${verb}`);
    return json(res, 200, await locked(() => handler(lot, body)));
  }
  if (m === "POST" && a === "holds" && id && verb === "reclaim") {
    const h = holdById.get(id);
    if (!h) throw new HttpError(404, `no hold ${id}`);
    return json(res, 200, await locked(() => reclaim(h, body)));
  }
  if (m === "POST" && a === "control" && id === "goal") {
    const lot = lotOr404(String(body?.itemId));
    if (body?.goal !== "best-price" && body?.goal !== "quick-sale") throw bad(`goal must be "best-price" or "quick-sale"`);
    return json(res, 200, await locked(async () => {
      if (lot.item.goal !== body.goal) {
        lot.item.goal = body.goal;
        say("Seller agent", `${lot.item.name}: owner switched the goal to ${body.goal}`);
        await decide(lot, `goal ${body.goal}`, true);
      }
      return lot.item;
    }));
  }
  if (m === "POST" && a === "control" && id === "next") return json(res, 200, { step: scenario ? scenario.next() : "no scenario" });
  if (m === "POST" && a === "control" && id === "list") return json(res, 200, await locked(() => listItem(body)));
  throw new HttpError(404, `no route ${m} ${p}`);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    const status = e instanceof HttpError ? e.status : 400;
    const msg = e instanceof HttpError ? e.message : chainError(e);
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) json(res, status, { error: msg });
  });
});

async function main() {
  await chain.init();
  say("Market", `cluster ${chain.cluster}, program ${chain.programId.toBase58().slice(0, 8)}…, dUSDC mint ${chain.dollar.toBase58().slice(0, 8)}…`);
  await refreshBalances();
  await new Promise<void>((r) => server.listen(PORT, r));
  console.log(`Holdback market on http://localhost:${PORT}`);
  scenario = createScenario({
    base: `http://127.0.0.1:${PORT}`,
    pace: Number(process.env.PACE ?? 1),
    step: process.env.STEP === "1",
    enabled: process.env.SCENARIO !== "0",
    say,
    onChange: push,
  });
  scenario.start();
}
main().catch((e) => { console.error(e); process.exit(1); });
