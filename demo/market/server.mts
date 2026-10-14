// Holdback market server: the contract in demo/API.md.
//
//   npm start            (http://localhost:4022; needs Stripe test keys in .env, see .env.example)
//
// One seller agent sells the merchant's products. It picks the sales mechanism from demand
// (watchers, time, goal), negotiates with a hidden floor, runs proxy and Dutch auctions, and
// every offer, bid and purchase is a payment hold (a card authorization): captured when a
// deal clears, released otherwise. Buyers (humans on the page or store, MCP agents) all go
// through the same HTTP API with a buyer token; the merchant lists products from /admin/.
// Payments go through a HoldProvider (payments.mts); state persists in SQLite (db.mts).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { paymentsFromEnv, PaymentError, type HoldProvider } from "./payments.mts";
import { Store } from "./db.mts";
import { chooseMechanism, settleAuction, dutchPrice } from "../mechanism.mts";
import { sellerReply, sellerNote, dayForm, type Goal } from "./negotiation.mts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
try { process.loadEnvFile(path.join(ROOT, ".env")); } catch {}

const PORT = Number(process.env.PORT ?? 4022);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const AUCTION_SECS = Number(process.env.AUCTION_SECS ?? 45);
const DUTCH_STEP_SECS = Number(process.env.DUTCH_STEP_SECS ?? 6);
const STALE_SECS = Number(process.env.STALE_SECS ?? 20);
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR ?? "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const CARD_SETUP_SECS = 30 * 60;
const SIGNUPS_PER_HOUR = Number(process.env.SIGNUPS_PER_HOUR ?? 20);

// ------------------------------------------------------------------ public types (demo/API.md)
type Mechanism = "buy-now" | "offers" | "auction" | "dutch";
type HoldStatus = "held" | "captured" | "released" | "refunded";   // released: authorization voided, never charged
type Hold = {
  id: string; itemId: string; buyer: string; kind: "offer" | "bid" | "buy";
  amount: number; captured?: number; refunded?: number; status: HoldStatus;
  ref: string;                // payment processor reference (Stripe PaymentIntent id)
  refundableUntil?: string;   // guarantee purchases: buyer can get a refund until then
  at: string; settledAt?: string;
};
type Turn = {
  from: "buyer" | "seller"; buyer: string; amount: number;
  action: "offer" | "counter" | "accept" | "decline" | "walk_away"; message: string; at: string;
  read?: string[];   // seller turns: intents the seller agent picked up from the buyer's message
};
type Item = {
  id: string; name: string; hue: number; image?: string; description?: string;
  kind: "unique" | "digital" | "physical";   // unique: one of a kind, negotiable. digital / physical: fixed price + guarantee
  mechanism: Mechanism; reason: string;
  goal: Goal;
  ask: number;
  price?: number;
  guarantee?: string;
  status: "listed" | "sold" | "unsold";
  soldTo?: string; soldFor?: number;
  watchers: string[];
  auction?: { endsAt: string; bids: number; leader?: string; reserveMet: boolean; price?: number; closed?: boolean };
  negotiations: Record<string, Turn[]>;
  holds: Hold[];
};
type Buyer = { id: string; name: string; kind: "human" | "agent" | "mcp"; max?: number; hasCard: boolean };
type Me = Buyer & { card?: string; holds: Hold[] };

// ------------------------------------------------------------------ internal state
type Lot = {
  item: Item;
  floor: number;   // private to the seller agent; never sent to buyers
  listedAt: number;
  staleSecs: number;
  guaranteeSecs: number;                                    // digital / physical: how long the buyer can get a refund
  openToOffers: boolean;                                    // no watchers yet: offers instead of buy-now
  offers: Map<string, string>;                              // buyerId -> held offer hold id
  counters: Map<string, number>;                            // buyerId -> seller's standing price for them
  bids: Map<string, { max: number; holdId: string }>;       // buyerId -> proxy bid
  dutch?: { start: number; step: number; startedAt: number };
  endsAt?: number;
  settling?: boolean;
};
type HoldRec = { pub: Hold; authId: string; buyerId: string; lot: Lot; policy: "offer" | "bid" | "guarantee"; refundableUntil?: number };
type BuyerRec = { pub: Buyer; customer: string; paymentMethod?: string; card?: string; tokenHash: string };

let payments: HoldProvider;
const store = new Store(DATA_DIR);
const lots: Lot[] = [];
const lotById = new Map<string, Lot>();
const buyers = new Map<string, BuyerRec>();
const buyerByToken = new Map<string, BuyerRec>();
const holdById = new Map<string, HoldRec>();
const cardSetups = new Map<string, { buyerId: string; setupIntent: string; clientSecret: string; expires: number }>();
const log: { t: string; who: string; text: string }[] = [];
let adminToken = "";

class HttpError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) { super(message); this.status = status; this.extra = extra; }
}
const bad = (m: string) => new HttpError(400, m);

// ------------------------------------------------------------------ persistence
function saveAll() {
  store.save({
    products: lots.map((l) => ({
      id: l.item.id, item: { ...l.item, holds: [] }, floor: l.floor, listedAt: l.listedAt, staleSecs: l.staleSecs,
      guaranteeSecs: l.guaranteeSecs, openToOffers: l.openToOffers, offers: [...l.offers], counters: [...l.counters],
      bids: [...l.bids], dutch: l.dutch, endsAt: l.endsAt,
    })),
    buyers: [...buyers.values()].map((b) => ({ id: b.pub.id, pub: b.pub, customer: b.customer, paymentMethod: b.paymentMethod, card: b.card, tokenHash: b.tokenHash })),
    holds: [...holdById.values()].map((h) => ({ id: h.pub.id, pub: h.pub, authId: h.authId, buyerId: h.buyerId, lotId: h.lot.item.id, policy: h.policy, refundableUntil: h.refundableUntil })),
  });
}

function loadAll() {
  for (const r of store.all<any>("products")) {
    const lot: Lot = { ...r, offers: new Map(r.offers), counters: new Map(r.counters), bids: new Map(r.bids) };
    lots.push(lot); lotById.set(lot.item.id, lot);
  }
  for (const r of store.all<any>("buyers")) {
    const b: BuyerRec = { pub: r.pub, customer: r.customer, paymentMethod: r.paymentMethod, card: r.card, tokenHash: r.tokenHash };
    buyers.set(b.pub.id, b); buyerByToken.set(b.tokenHash, b);
  }
  for (const r of store.all<any>("holds")) {
    const lot = lotById.get(r.lotId);
    if (!lot) continue;
    const h: HoldRec = { pub: r.pub, authId: r.authId, buyerId: r.buyerId, lot, policy: r.policy, refundableUntil: r.refundableUntil };
    holdById.set(h.pub.id, h);
    lot.item.holds.push(h.pub);
  }
}

/** Holds still open after a restart: ask the processor what happened to them meanwhile. */
async function reconcile() {
  for (const h of holdById.values()) {
    if (h.pub.status !== "held") continue;
    try {
      const a = await payments.get(h.authId);
      if (a.status === "voided" || a.status === "expired") { settled(h, "released"); say("Market", `${h.pub.buyer}'s ${h.pub.amount} USD hold on ${h.lot.item.name} is no longer authorized (${a.status})`); }
      else if (a.status === "captured") { settled(h, "captured"); h.pub.captured = a.captured; }
    } catch (e) { console.error(`reconcile ${h.authId}: ${errMsg(e)}`); }
  }
  saveAll();
}

// ------------------------------------------------------------------ live updates
const clients = new Set<http.ServerResponse>();
const sellerBalance = () => [...holdById.values()].reduce((s, h) => s + (h.pub.captured ?? 0) - (h.pub.refunded ?? 0), 0);
const snapshot = () => ({
  provider: { id: payments.id, name: payments.name, mode: payments.mode, capabilities: payments.capabilities },
  items: lots.map((l) => l.item),
  buyers: [...buyers.values()].map((b) => b.pub),
  log,
  seller: { name: "Seller agent", balance: sellerBalance() },
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
function say(who: string, text: string) {
  log.unshift({ t: new Date().toISOString().slice(11, 19), who, text });
  if (log.length > 300) log.length = 300;
  console.log(`${who.padEnd(13)} ${text}`);
  push();
}
const errMsg = (e: any): string => e?.message ?? String(e);

/** Every mutating step runs here, one at a time, so payment order matches the story; state is saved after each. */
let queue: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  const after = () => { try { saveAll(); } catch (e) { console.error("save failed:", e); } push(); };
  queue = run.then(after, after).catch(() => {});
  return run;
}

// ------------------------------------------------------------------ helpers
const now = () => new Date().toISOString();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
function lotOr404(id: string) {
  const l = lotById.get(id);
  if (!l) throw new HttpError(404, `no item ${id}`);
  return l;
}
function bearer(req: http.IncomingMessage) {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}
/** The buyer this request acts for, from its `Authorization: Bearer <buyer token>` header. */
function buyerOr401(req: http.IncomingMessage, body?: any) {
  const t = bearer(req);
  const b = t ? buyerByToken.get(sha(t)) : undefined;
  if (!b) throw new HttpError(401, "missing or unknown buyer token: register with POST /api/buyers and send Authorization: Bearer <token>");
  if (body?.buyerId !== undefined && body.buyerId !== b.pub.id) throw new HttpError(403, "buyerId does not match the token");
  return b;
}
function adminOr401(req: http.IncomingMessage) {
  const ok = crypto.timingSafeEqual(Buffer.from(sha(bearer(req) ?? ""), "hex"), Buffer.from(sha(adminToken), "hex"));
  if (!ok) throw new HttpError(401, "admin token required");
}
function amountOr400(v: unknown, what = "amount") {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw bad(`${what} must be a positive number of USD`);
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
const me = (b: BuyerRec): Me => ({ ...b.pub, card: b.card, holds: [...holdById.values()].filter((h) => h.buyerId === b.pub.id).map((h) => h.pub) });

function cardOr402(b: BuyerRec) {
  if (!b.paymentMethod) throw new HttpError(402, `${b.pub.name} has no card yet: add one first (POST /api/me/card-setup)`, { needsCard: true });
}

async function newHold(b: BuyerRec, lot: Lot, kind: Hold["kind"], amount: number, pol: HoldRec["policy"]) {
  // The owner's limit is enforced here, on every hold, whatever the client checked.
  if (b.pub.max !== undefined && amount > b.pub.max) throw bad(`${amount} USD is above ${b.pub.name}'s owner's limit of ${b.pub.max} USD`);
  cardOr402(b);
  let auth;
  try {
    auth = await payments.authorize({
      customer: b.customer, paymentMethod: b.paymentMethod, amount, idempotencyKey: crypto.randomUUID(),
      description: `Holdback ${kind}: ${lot.item.name}`, metadata: { itemId: lot.item.id, buyerId: b.pub.id, kind },
    });
  } catch (e) {
    if (e instanceof PaymentError) throw new HttpError(402, `hold failed: ${e.message}`);
    throw e;
  }
  const pub: Hold = { id: auth.id, itemId: lot.item.id, buyer: b.pub.name, kind, amount, status: "held", ref: auth.id, at: now() };
  const rec: HoldRec = { pub, authId: auth.id, buyerId: b.pub.id, lot, policy: pol };
  holdById.set(pub.id, rec);
  lot.item.holds.push(pub);
  const label = { offer: "offer", bid: "max bid", buy: "purchase" }[kind];
  say(b.pub.name, `${label} ${amount} USD on ${lot.item.name} → card authorized${pol === "guarantee" ? "" : ", nothing charged until the deal clears"}`);
  return rec;
}

function settled(h: HoldRec, status: HoldStatus) {
  h.pub.status = status;
  h.pub.settledAt = now();
  if (h.lot.offers.get(h.buyerId) === h.pub.id) h.lot.offers.delete(h.buyerId);
}

/** Seller releases a hold: the authorization is voided and the buyer is never charged. */
async function voidHold(h: HoldRec, why: string) {
  if (h.pub.status !== "held") return;
  await payments.void(h.authId);
  settled(h, "released");
  say("Seller agent", `releases ${h.pub.buyer}'s ${h.pub.amount} USD hold (${why})`);
}

/** Captures `price` from the winning hold (the rest of the authorization is released) and delivers the item. */
async function sell(lot: Lot, h: HoldRec, price: number, othersWhy: string) {
  const b = buyers.get(h.buyerId)!;
  await payments.capture(h.authId, price);
  settled(h, "captured");
  h.pub.captured = price;
  Object.assign(lot.item, { status: "sold", soldTo: b.pub.name, soldFor: price, price: undefined });
  lot.dutch = undefined;
  const back = h.pub.amount - price;
  say("Seller agent", `SOLD ${lot.item.name} to ${b.pub.name} for ${price} USD${back > 0 ? ` (held ${h.pub.amount}, captured ${price}, ${back} released)` : ""}`);
  for (const other of holdById.values()) {
    if (other.lot === lot && other.pub.status === "held" && other !== h) await voidHold(other, othersWhy);
  }
}

// ------------------------------------------------------------------ seller agent: mechanism
async function decide(lot: Lot, trigger: string, force = false) {
  const it = lot.item;
  if (it.status !== "listed" || it.kind !== "unique") return;
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
    say("Seller agent", `${it.name}: auction closed with ${bids.length ? "no bid at the reserve" : "no bids"}; every hold is released`);
    for (const b of bids) await voidHold(holdById.get(b.holdId)!, "reserve not met");
    it.status = "unsold";
    it.reason = "auction closed below the reserve";
  }
  push();
}

// timers: Dutch price ticks, staleness checks, auction close
function tick() {
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
    if (it.mechanism === "buy-now" && it.kind === "unique" && lot.staleSecs > 0 && (Date.now() - lot.listedAt) / 1000 > lot.staleSecs && !lot.settling) {
      lot.settling = true;
      locked(() => decide(lot, "no interest")).catch((e) => say("Market", `error: ${errMsg(e)}`)).finally(() => (lot.settling = false));
    }
    if (it.mechanism === "auction" && lot.endsAt && Date.now() >= lot.endsAt && !it.auction?.closed && !lot.settling) {
      lot.settling = true;
      locked(() => closeAuction(lot)).catch((e) => say("Market", `auction settle error: ${errMsg(e)}`)).finally(() => (lot.settling = false));
    }
  }
}

// ------------------------------------------------------------------ buyers and cards
const signups = new Map<string, number[]>();
async function createBuyer(req: http.IncomingMessage, body: any) {
  const ip = req.socket.remoteAddress ?? "?";
  const recent = (signups.get(ip) ?? []).filter((t) => t > Date.now() - 3600_000);
  if (recent.length >= SIGNUPS_PER_HOUR) throw new HttpError(429, "too many new buyers from this address; try again later");
  const asked = String(body?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!asked) throw bad("name required");
  // Names label negotiation threads, holds and auction leaders, so each buyer gets a unique one.
  const taken = new Set([...buyers.values()].map((x) => x.pub.name.toLowerCase()));
  let name = asked;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${asked} ${n}`;
  const kind = (["human", "agent", "mcp"].includes(body?.kind) ? body.kind : "human") as Buyer["kind"];
  const max = body?.max === undefined || body?.max === null ? undefined : amountOr400(body.max, "max");
  let id = slug(name);
  while (buyers.has(id)) id = `${slug(name)}-${crypto.randomBytes(2).toString("hex")}`;
  const customer = await payments.createCustomer(name, { buyerId: id, kind });
  const token = crypto.randomBytes(24).toString("base64url");
  const b: BuyerRec = { pub: { id, name, kind, max, hasCard: false }, customer, tokenHash: sha(token) };
  buyers.set(id, b); buyerByToken.set(b.tokenHash, b);
  signups.set(ip, [...recent, Date.now()]);
  say("Market", `${name} (${kind}${max ? `, owner's limit ${max}` : ""}) joins`);
  return { ...me(b), token };
}

function cardSaved(b: BuyerRec, card: { paymentMethod: string; label: string }) {
  b.paymentMethod = card.paymentMethod;
  b.card = card.label;
  b.pub.hasCard = true;
  say("Market", `${b.pub.name} added a card`);
  return { card: card.label };
}

async function startCardSetup(b: BuyerRec) {
  const s = await payments.startCardSetup(b.customer);
  const code = crypto.randomBytes(12).toString("base64url");
  cardSetups.set(code, { buyerId: b.pub.id, ...s, expires: Date.now() + CARD_SETUP_SECS * 1000 });
  return { code, setupUrl: `${PUBLIC_URL}/card/?code=${code}`, expiresInSecs: CARD_SETUP_SECS };
}
function setupOr404(code: string) {
  const s = cardSetups.get(code);
  if (!s || s.expires < Date.now()) throw new HttpError(404, "this card link has expired; ask for a new one");
  return s;
}

// ------------------------------------------------------------------ buyer actions
/** Optional free-text note from the buyer (≤280 chars). Read locally by the seller agent; never sent anywhere. */
function buyerMessage(body: any): string | undefined {
  const m = body?.message;
  if (m === undefined || m === null) return undefined;
  const t = String(m).replace(/\s+/g, " ").trim().slice(0, 280);
  return t || undefined;
}
const facts = (it: Item) => ({ name: it.name, kind: it.kind, guarantee: it.guarantee, description: it.description });

async function offer(lot: Lot, b: BuyerRec, body: any) {
  const amount = amountOr400(body?.amount);
  listedOr400(lot);
  if (lot.item.kind !== "unique") throw bad(`${lot.item.name} is fixed price (${lot.item.ask}): use buy`);
  cardOr402(b);
  await watch(lot, b);
  const it = lot.item;
  if (it.mechanism === "auction") throw bad(`${it.name} is in a proxy auction until ${it.auction?.endsAt}: place a bid instead`);
  if (it.mechanism === "dutch") throw bad(`${it.name} is in a Dutch auction at ${it.price} USD right now: use buy`);
  const prev = lot.offers.get(b.pub.id);
  const h = await newHold(b, lot, "offer", amount, "offer");   // before releasing the old offer, so a declined card keeps it
  if (prev) await voidHold(holdById.get(prev)!, "replaced by a new offer");
  lot.offers.set(b.pub.id, h.pub.id);
  const said = buyerMessage(body);
  turn(lot, { from: "buyer", buyer: b.pub.name, amount, action: "offer", message: said ?? `I offer ${amount} USD (held on my card).` });
  const round = turns(lot, b.pub.name).filter((t) => t.from === "buyer" && t.action === "offer").length;
  const r = sellerReply({ offer: amount, ask: it.ask, floor: lot.floor, goal: it.goal, round, lastCounter: lot.counters.get(b.pub.id), message: said, item: facts(it) });
  const reply = turn(lot, { from: "seller", buyer: b.pub.name, amount: r.amount, action: r.action, message: r.message, ...(r.read ? { read: r.read } : {}) });
  say("Seller agent", `→ ${b.pub.name} (round ${round}${r.read ? `, read: ${r.read.join(", ")}` : ""}): ${r.message}`);
  if (r.action === "accept") await sell(lot, h, r.amount, `sold to ${b.pub.name}`);
  else if (r.action === "decline") { lot.counters.set(b.pub.id, it.ask); await voidHold(h, "offer below what the seller will take"); }
  else lot.counters.set(b.pub.id, r.amount);
  return { hold: h.pub, reply, item: it };
}

async function respond(lot: Lot, b: BuyerRec, body: any) {
  const action = body?.action;
  if (action !== "accept" && action !== "walk_away") throw bad(`action must be "accept" or "walk_away"`);
  listedOr400(lot);
  const it = lot.item;
  const prevId = lot.offers.get(b.pub.id);
  const prev = prevId ? holdById.get(prevId) : undefined;
  if (action === "walk_away") {
    const said = buyerMessage(body);
    turn(lot, { from: "buyer", buyer: b.pub.name, amount: prev?.pub.amount ?? 0, action: "walk_away", message: said ?? "I'll pass." });
    if (prev && prev.pub.status === "held") {
      await payments.void(prev.authId);
      settled(prev, "released");
      say(b.pub.name, `walks away from ${it.name}; the ${prev.pub.amount} USD offer hold is released`);
    } else say(b.pub.name, `walks away from ${it.name}`);
    const standing = lot.counters.get(b.pub.id) ?? it.ask;
    const n = sellerNote(said, "walk_away", standing, facts(it));
    const reply = turn(lot, { from: "seller", buyer: b.pub.name, amount: standing, action: "counter", message: n.message, ...(n.read.length ? { read: n.read } : {}) });
    return { hold: prev?.pub, reply, item: it };
  }
  if (it.mechanism !== "offers") throw bad(`${it.name} is now ${it.mechanism === "auction" ? "in an auction: place a bid" : `${it.mechanism}: use buy`}`);
  const price = lot.counters.get(b.pub.id);
  if (price === undefined) throw bad(`no counter-offer from the seller to accept yet: make an offer first`);
  const h = await newHold(b, lot, "offer", price, "offer");
  if (prev) await voidHold(prev, "replaced by the accepted price");
  const said = buyerMessage(body);
  turn(lot, { from: "buyer", buyer: b.pub.name, amount: price, action: "accept", message: said ?? `Deal at ${price}.` });
  const n = sellerNote(said, "accept", price, facts(it));
  const reply = turn(lot, { from: "seller", buyer: b.pub.name, amount: price, action: "accept", message: n.message, ...(n.read.length ? { read: n.read } : {}) });
  await sell(lot, h, price, `sold to ${b.pub.name}`);
  return { hold: h.pub, reply, item: it };
}

async function bid(lot: Lot, b: BuyerRec, body: any) {
  const max = amountOr400(body?.max, "max");
  listedOr400(lot);
  cardOr402(b);
  await watch(lot, b);
  const it = lot.item;
  if (it.mechanism !== "auction" || !it.auction || it.auction.closed) throw bad(`${it.name} is not in an auction (mechanism: ${it.mechanism})`);
  if (Date.now() >= lot.endsAt!) throw bad("auction already closed");
  const prev = lot.bids.get(b.pub.id);
  if (prev && prev.max >= max) throw bad(`your max bid is already ${prev.max}: raise it to bid again`);
  const h = await newHold(b, lot, "bid", max, "bid");
  if (prev) await voidHold(holdById.get(prev.holdId)!, "replaced by a higher max bid");
  lot.bids.set(b.pub.id, { max, holdId: h.pub.id });
  updateAuction(lot);
  say("Seller agent", `${it.name}: ${it.auction.bids} bidder${it.auction.bids > 1 ? "s" : ""}, leader ${it.auction.leader}, current price ${it.auction.price ?? "below reserve"}`);
  return { hold: h.pub, item: it };
}

async function buy(lot: Lot, b: BuyerRec) {
  listedOr400(lot);
  const it = lot.item;
  if (it.kind !== "unique") {
    // Guarantee on a card: captured now (an authorization would expire before the window ends);
    // the merchant refunds on request inside the window.
    const h = await newHold(b, lot, "buy", it.ask, "guarantee");
    await payments.capture(h.authId, it.ask);
    settled(h, "captured");
    h.pub.captured = it.ask;
    h.refundableUntil = Date.now() + lot.guaranteeSecs * 1000;
    h.pub.refundableUntil = new Date(h.refundableUntil).toISOString();
    Object.assign(it, { status: "sold", soldTo: b.pub.name, soldFor: it.ask });
    say("Seller agent", it.kind === "physical"
      ? `ships ${it.name} to ${b.pub.name}, charged ${it.ask} USD. Refundable for ${it.guarantee} (lost, damaged, not as described)`
      : `delivers ${it.name} to ${b.pub.name}, charged ${it.ask} USD. Money back on request for ${it.guarantee}`);
    return { hold: h.pub, item: it };
  }
  if (it.mechanism === "auction") throw bad(`${it.name} is in a proxy auction: place a bid instead`);
  const price = it.mechanism === "dutch" ? it.price! : it.mechanism === "offers" ? it.ask : (it.price ?? it.ask);
  const h = await newHold(b, lot, "buy", price, "bid");
  await sell(lot, h, price, `sold to ${b.pub.name}`);
  return { hold: h.pub, item: it };
}

/** Buyer takes money back: withdraws an offer (void), or asks for a refund inside a guarantee window. */
async function reclaim(h: HoldRec, b: BuyerRec) {
  if (h.buyerId !== b.pub.id) throw new HttpError(403, "not your hold");
  const lot = h.lot, it = lot.item;
  if (h.policy === "guarantee") {
    if (h.pub.status !== "captured") throw bad(`payment is already ${h.pub.status}`);
    if (Date.now() > h.refundableUntil!) throw bad(`the ${it.guarantee} guarantee ended ${h.pub.refundableUntil}`);
    const r = await payments.refund(h.authId);
    settled(h, "refunded");
    h.pub.refunded = r.refunded;
    if (it.soldTo === b.pub.name) Object.assign(it, { status: "listed", soldTo: undefined, soldFor: undefined });
    say(b.pub.name, `gets ${r.refunded} USD back for ${it.name} inside the ${dayForm(it.guarantee!)} guarantee, no seller approval needed`);
    return { hold: h.pub };
  }
  if (h.pub.status !== "held") throw bad(`hold is already ${h.pub.status}`);
  if (h.policy === "bid") throw bad("bids are binding until the auction closes");
  await payments.void(h.authId);
  settled(h, "released");
  turn(lot, { from: "buyer", buyer: b.pub.name, amount: h.pub.amount, action: "walk_away", message: "Withdrawing my offer." });
  say(b.pub.name, `withdraws the ${h.pub.amount} USD offer on ${it.name}; the hold is released`);
  return { hold: h.pub };
}

// ------------------------------------------------------------------ merchant (admin)
const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
/** An uploaded image (data: URL) is saved under data/uploads; an http(s) URL is kept as is. */
function imageOr400(v: unknown, id: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v);
  const m = s.match(/^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/);
  if (m) {
    const ext = IMAGE_TYPES[m[1]];
    if (!ext) throw bad("image must be PNG, JPEG, WebP or GIF");
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 4_000_000) throw bad("image must be under 4 MB");
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const file = `${id}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, file), buf);
    return `/uploads/${file}`;
  }
  if (/^https?:\/\/\S+$/.test(s) || /^\/[\w./-]+$/.test(s)) return s;
  throw bad("image must be an uploaded file or an http(s) URL");
}

const adminView = (l: Lot) => ({ ...l.item, floor: l.floor, staleSecs: l.staleSecs });

async function createProduct(body: any) {
  const name = String(body?.name ?? "").trim().slice(0, 80);
  if (!name) throw bad("name required");
  const ask = amountOr400(body?.ask, "price");
  const kind: Item["kind"] = body?.kind === "digital" || body?.kind === "physical" ? body.kind : "unique";
  const floor = kind !== "unique" ? ask : body?.floor === undefined || body?.floor === "" ? Math.round(ask * 0.6) : amountOr400(body.floor, "floor");
  if (floor > ask) throw bad("the floor can't be above the price");
  const days = body?.guaranteeDays === undefined || body?.guaranteeDays === "" ? (kind === "physical" ? 14 : 7) : amountOr400(body.guaranteeDays, "guaranteeDays");
  const goal: Goal = body?.goal === "quick-sale" ? "quick-sale" : "best-price";
  let id = slug(name);
  while (lotById.has(id)) id = `${slug(name)}-${crypto.randomBytes(2).toString("hex")}`;
  const description = body?.description ? String(body.description).trim().slice(0, 600) : undefined;
  const lot: Lot = {
    item: {
      id, name, hue: Math.floor(Math.random() * 360), image: imageOr400(body?.image, id), description, mechanism: "" as Mechanism, reason: "", goal, ask,
      status: "listed", watchers: [], negotiations: {}, holds: [], kind,
    },
    floor, guaranteeSecs: days * 86400, listedAt: Date.now(),
    staleSecs: body?.staleSecs === undefined || body?.staleSecs === "" ? STALE_SECS : Number(body.staleSecs),
    openToOffers: kind === "unique" && body?.openToOffers !== false,
    offers: new Map(), counters: new Map(), bids: new Map(),
  };
  if (kind !== "unique") {
    const guarantee = `${days} days`;
    const reason = kind === "physical"
      ? `physical item → fixed price; refundable for ${guarantee} if it arrives lost, damaged or not as described`
      : `digital → fixed price with a ${dayForm(guarantee)} money-back guarantee`;
    Object.assign(lot.item, { mechanism: "buy-now", price: ask, guarantee, reason });
    lots.push(lot); lotById.set(id, lot);
    say("Seller agent", `lists ${name}: BUY-NOW at ${ask}: ${reason}`);
    return adminView(lot);
  }
  lots.push(lot); lotById.set(id, lot);
  say("Seller agent", `lists ${name} (ask ${ask}, goal ${goal}); the floor stays private to the seller agent`);
  await decide(lot, "new listing");
  return adminView(lot);
}

async function updateProduct(lot: Lot, body: any) {
  const it = lot.item;
  if (body?.goal !== undefined) {
    if (body.goal !== "best-price" && body.goal !== "quick-sale") throw bad(`goal must be "best-price" or "quick-sale"`);
    if (it.goal !== body.goal) {
      it.goal = body.goal;
      say("Seller agent", `${it.name}: owner switched the goal to ${body.goal}`);
      await decide(lot, `goal ${body.goal}`, true);
    }
  }
  if (body?.description !== undefined) it.description = String(body.description).trim().slice(0, 600) || undefined;
  if (body?.image !== undefined) it.image = imageOr400(body.image, it.id);
  return adminView(lot);
}

async function delist(lot: Lot) {
  const it = lot.item;
  if (it.status !== "listed") throw bad(`${it.name} is ${it.status}`);
  for (const h of holdById.values()) if (h.lot === lot && h.pub.status === "held") await voidHold(h, "the seller took the item down");
  Object.assign(it, { status: "unsold", reason: "taken down by the seller", price: undefined });
  if (it.auction) it.auction.closed = true;
  lot.dutch = undefined;
  say("Seller agent", `takes down ${it.name}`);
  return adminView(lot);
}

// ------------------------------------------------------------------ HTTP
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".woff2": "font/woff2",
};
function serveFile(res: http.ServerResponse, dir: string, rel: string) {
  const file = path.normalize(path.join(dir, rel));
  if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(file).pipe(res);
  return true;
}
const CORS = { "access-control-allow-origin": "*" };
const json = (res: http.ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "content-type": "application/json", ...CORS }).end(JSON.stringify(body));
async function readBody(req: http.IncomingMessage, limit = 1e5) {
  let raw = "";
  for await (const c of req) { raw += c; if (raw.length > limit) throw new HttpError(413, "body too large"); }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw bad("body must be JSON"); }
}

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  const m = req.method ?? "GET";
  if (m === "OPTIONS") {
    return res.writeHead(204, { ...CORS, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type, authorization" }).end();
  }
  if (p === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...CORS });
    clients.add(res);
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  if (!p.startsWith("/api/")) {
    if (m === "GET" && !p.endsWith("/") && !path.extname(p) && fs.existsSync(path.join(PUBLIC_DIR, p, "index.html"))) {
      return res.writeHead(301, { location: `${p}/${url.search}` }).end();
    }
    if (m === "GET" && p.startsWith("/uploads/") && serveFile(res, UPLOADS_DIR + path.sep, decodeURIComponent(p.slice(9)))) return;
    if (m === "GET" && serveFile(res, PUBLIC_DIR, decodeURIComponent(p.slice(1)) + (p.endsWith("/") ? "index.html" : ""))) return;
    return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
  const parts = p.split("/").filter(Boolean).slice(1).map(decodeURIComponent); // after "api"
  const [a, id, verb, sub] = parts;
  const body = m === "POST" ? await readBody(req, a === "admin" ? 6e6 : 1e5) : {};

  // public
  if (m === "GET" && a === "config") return json(res, 200, { provider: snapshot().provider, publishableKey: payments.publishableKey });
  if (m === "GET" && a === "state") return json(res, 200, snapshot());
  if (m === "GET" && a === "items" && !id) return json(res, 200, lots.map((l) => l.item));
  if (m === "GET" && a === "items" && id && !verb) {
    const lot = lotOr404(id);
    if (bearer(req)) { const b = buyerOr401(req); await locked(() => watch(lot, b)); }
    return json(res, 200, lot.item);
  }
  if (m === "GET" && a === "buyers" && !id) return json(res, 200, [...buyers.values()].map((b) => b.pub));

  // buyers
  if (m === "POST" && a === "buyers" && !id) return json(res, 200, await locked(() => createBuyer(req, body)));
  if (m === "GET" && (a === "me" || (a === "buyers" && id)) && !verb) {
    const b = buyerOr401(req);
    if (a === "buyers" && id !== b.pub.id) throw new HttpError(403, "you can only read your own buyer record");
    return json(res, 200, me(b));
  }
  if (m === "POST" && a === "me" && id === "card-setup") { const b = buyerOr401(req); return json(res, 200, await startCardSetup(b)); }
  if (m === "POST" && a === "me" && id === "test-card") {
    const b = buyerOr401(req);
    return json(res, 200, await locked(async () => cardSaved(b, await payments.attachTestCard(b.customer))));
  }
  if (m === "GET" && a === "card-setup" && id && !verb) {
    const s = setupOr404(id);
    return json(res, 200, { buyer: buyers.get(s.buyerId)!.pub.name, clientSecret: s.clientSecret, publishableKey: payments.publishableKey, mode: payments.mode });
  }
  if (m === "POST" && a === "card-setup" && id && verb === "complete") {
    const s = setupOr404(id);
    const b = buyers.get(s.buyerId)!;
    return json(res, 200, await locked(async () => {
      const r = cardSaved(b, await payments.finishCardSetup(b.customer, s.setupIntent));
      cardSetups.delete(id);
      return r;
    }));
  }
  if (m === "POST" && a === "items" && id && verb) {
    const b = buyerOr401(req, body);
    const lot = lotOr404(id);
    if (verb === "offer") return json(res, 200, await locked(() => offer(lot, b, body)));
    if (verb === "respond") return json(res, 200, await locked(() => respond(lot, b, body)));
    if (verb === "bid") return json(res, 200, await locked(() => bid(lot, b, body)));
    if (verb === "buy") return json(res, 200, await locked(() => buy(lot, b)));
    throw new HttpError(404, `unknown action ${verb}`);
  }
  if (m === "POST" && a === "holds" && id && verb === "reclaim") {
    const b = buyerOr401(req, body);
    const h = holdById.get(id);
    if (!h) throw new HttpError(404, `no hold ${id}`);
    return json(res, 200, await locked(() => reclaim(h, b)));
  }

  // merchant
  if (a === "admin") {
    adminOr401(req);
    if (id === "products" && !verb && m === "GET") return json(res, 200, lots.map(adminView));
    if (id === "products" && !verb && m === "POST") return json(res, 200, await locked(() => createProduct(body)));
    if (id === "products" && verb && m === "POST") {
      const lot = lotOr404(verb);
      if (sub === "delist") return json(res, 200, await locked(() => delist(lot)));
      if (!sub) return json(res, 200, await locked(() => updateProduct(lot, body)));
    }
  }
  throw new HttpError(404, `no route ${m} ${p}`);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    const fromStripe = e?.type?.startsWith?.("Stripe") || e?.rawType !== undefined;
    const status = e instanceof HttpError ? e.status : e instanceof PaymentError ? 402 : fromStripe ? 502 : 500;
    if (status === 502) console.error(`payment provider error: ${errMsg(e)}`);
    else if (status === 500) console.error(e);
    if (!res.headersSent) json(res, status, { error: errMsg(e), ...(e instanceof HttpError ? e.extra : {}) });
  });
});

/** ADMIN_TOKEN from the environment, or one generated once and kept in data/admin-token. */
function loadAdminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  const file = path.join(DATA_DIR, "admin-token");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const t = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(file, t + "\n", { mode: 0o600 });
  return t;
}

async function main() {
  payments = paymentsFromEnv();
  adminToken = loadAdminToken();
  loadAll();
  await reconcile();
  setInterval(tick, 500);
  await new Promise<void>((r) => server.listen(PORT, r));
  say("Market", `payments: ${payments.name}; ${lots.length} products, ${buyers.size} buyers`);
  console.log(`Holdback market on ${PUBLIC_URL}`);
  console.log(`Merchant admin: ${PUBLIC_URL}/admin/  (token: ${process.env.ADMIN_TOKEN ? "ADMIN_TOKEN" : path.relative(ROOT, path.join(DATA_DIR, "admin-token"))})`);
}
main().catch((e) => { console.error(errMsg(e)); process.exit(1); });
