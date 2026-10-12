// Mock of the Holdback market server (demo/API.md) for UI work. No deps.
//   node demo/public/mock-server.mjs        → http://localhost:4051
//   STEP=1 node demo/public/mock-server.mjs  → scenes only advance on POST /api/control/next
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4051);
const STEP = process.env.STEP === "1";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const sig = () => Array.from({ length: 87 }, () => B58[Math.floor(Math.random() * 58)]).join("");
const url = (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;
const now = () => new Date().toISOString();
let hid = 0;

const state = {
  cluster: "devnet",
  program: "HoLDbk7c9vQ3dKk1rUeQ1mJ8PzS4w2nYFh6tA5xVbE3",
  rails: [
    { id: "solana", name: "Solana", status: "live", explorer: "https://explorer.solana.com/address/HoLDbk7c9vQ3dKk1rUeQ1mJ8PzS4w2nYFh6tA5xVbE3?cluster=devnet" },
    { id: "tempo", name: "Tempo", status: "testnet", note: "testnet · stablecoin hold escrow", explorer: "https://explore.tempo.xyz/" },
    { id: "robinhood", name: "Robinhood Chain", status: "testnet", note: "testnet · TSLA stock-token holds" },
  ],
  buyers: [
    { id: "b-ape", name: "Ape-Agent", kind: "agent", max: 90, wallet: "Ape1…", balance: 300 },
    { id: "b-hag", name: "Haggler", kind: "agent", max: 75, wallet: "Hag1…", balance: 300 },
    { id: "b-mcp", name: "Claude (MCP)", kind: "mcp", max: 120, wallet: "Mcp1…", balance: 300 },
  ],
  items: [
    { id: "banana-baron", name: "Banana Baron", hue: 32, mechanism: "offers", goal: "best-price", ask: 80,
      reason: "Two buyers are watching but neither will pay ask, so I'm taking offers and countering.", status: "listed",
      watchers: ["Ape-Agent", "Haggler"], negotiations: {}, holds: [] },
    { id: "moonwalk-mandrill", name: "Moonwalk Mandrill", hue: 270, mechanism: "auction", goal: "best-price", ask: 100,
      reason: "Three buyers want this one, so an auction lets them bid it up.", status: "listed",
      watchers: ["Ape-Agent", "Haggler", "Claude (MCP)"], auction: { endsAt: new Date(Date.now() + 95_000).toISOString(), bids: 0, reserveMet: false },
      negotiations: {}, holds: [] },
    { id: "gold-gibbon", name: "Gold Gibbon", hue: 48, mechanism: "dutch", goal: "quick-sale", ask: 120, price: 120,
      reason: "Nobody's watching and you want a quick sale, so the price drops until someone bites.", status: "listed",
      watchers: [], negotiations: {}, holds: [] },
    { id: "quiet-capuchin", name: "Quiet Capuchin <script>", hue: 150, mechanism: "buy-now", goal: "best-price", ask: 45, price: 45,
      reason: "One steady buyer at a fair price, so a fixed buy-now price is simplest.", status: "listed",
      watchers: ["Claude (MCP)"], negotiations: {}, holds: [] },
    { id: "print-1", name: "Monkey #1 · hi-res print", hue: 28, kind: "digital", mechanism: "buy-now", goal: "best-price", ask: 5, price: 5, guarantee: "7 days",
      reason: "digital download → fixed price with a 7-day money-back guarantee", status: "listed", watchers: [], negotiations: {}, holds: [] },
  ],
  seller: { name: "Seller agent", wallet: "Se11…", balance: 0 },
  scenario: { mode: "step", scene: 0, total: 0, running: false },
  log: [],
};
const floors = { "banana-baron": 62, "moonwalk-mandrill": 85, "gold-gibbon": 70, "quiet-capuchin": 45 };
const rounds = {};

const clients = new Set();
function push() { const m = `data: ${JSON.stringify(state)}\n\n`; for (const c of clients) c.write(m); }
function log(who, text, s) { state.log.unshift({ t: now().slice(11, 19), who, text, tx: s && url(s) }); if (state.log.length > 200) state.log.pop(); }
const item = (id) => state.items.find((i) => i.id === id);
const buyer = (id) => state.buyers.find((b) => b.id === id || b.name === id);

function hold(it, b, kind, amount) {
  const h = { id: `h${++hid}`, itemId: it.id, buyer: b.name, kind, amount, status: "held", tx: sig() };
  b.balance -= amount; it.holds.push(h); return h;
}
function refund(h) { if (h.status !== "held") return; h.status = "refunded"; h.settleTx = sig(); buyer(h.buyer).balance += h.amount; }
function capture(h, amt = h.amount) {
  h.status = "captured"; h.settleTx = sig();
  if (amt < h.amount) { h.captured = amt; buyer(h.buyer).balance += h.amount - amt; }
}
function sell(it, b, price, h) {
  state.seller.balance += price;
  it.status = "sold"; it.soldTo = b.name; it.soldFor = price; it.saleTx = h.settleTx;
  for (const o of it.holds) if (o !== h && o.status === "held") refund(o);
  log("Seller", `sold ${it.name} to ${b.name} for ${price}`, h.settleTx);
}
function turn(it, b, from, action, amount, message) {
  (it.negotiations[b.name] ??= []).push({ from, buyer: b.name, amount, action, message, at: now() });
  return it.negotiations[b.name].at(-1);
}

function offer(it, b, amount) {
  if (it.status !== "listed") throw new Error("item is not for sale");
  if (it.mechanism !== "offers") throw new Error(`${it.name} is not taking offers (${it.mechanism})`);
  if (amount > b.balance) throw new Error("insufficient dUSDC for this hold");
  for (const o of it.holds) if (o.buyer === b.name && o.status === "held") refund(o);
  const h = hold(it, b, "offer", amount);
  turn(it, b, "buyer", "offer", amount, "");
  log(b.name, `offers ${amount} on ${it.name} (held)`, h.tx);
  const floor = floors[it.id], c = it.goal === "quick-sale" ? [0.5, 0.75, 0.9, 1] : [0.3, 0.5, 0.7, 0.85];
  const n = (rounds[it.id + b.name] = (rounds[it.id + b.name] ?? -1) + 1);
  let reply;
  if (amount >= it.ask) { capture(h); reply = turn(it, b, "seller", "accept", amount, "Deal."); sell(it, b, amount, h); }
  else if (amount < floor * 0.8) { refund(h); reply = turn(it, b, "seller", "decline", it.ask, "Too low, your hold is refunded. Ask stands."); log("Seller", `declines ${b.name}'s ${amount}; refunded`, h.settleTx); }
  else {
    const ci = c[Math.min(n, 3)];
    const ctr = Math.max(floor, Math.round(it.ask - (it.ask - amount) * ci));
    if (ctr <= amount) { capture(h); reply = turn(it, b, "seller", "accept", amount, "You've got it."); sell(it, b, amount, h); }
    else { reply = turn(it, b, "seller", "counter", ctr, n === 0 ? "Close, but I can come down a little." : "Meeting you partway again."); log("Seller", `counters ${b.name} at ${ctr}`); }
  }
  push(); return { hold: h, reply, item: it };
}
function respond(it, b, action) {
  if (it.status !== "listed") throw new Error("item is not for sale");
  const ts = it.negotiations[b.name] ?? [];
  const last = ts.at(-1);
  if (action === "walk_away") {
    for (const o of it.holds) if (o.buyer === b.name && o.status === "held") refund(o);
    turn(it, b, "buyer", "walk_away", 0, "");
    const reply = turn(it, b, "seller", "walk_away", 0, "No problem. Your hold is back in your wallet.");
    log(b.name, `walks away from ${it.name}; hold refunded`); push(); return { reply, item: it };
  }
  if (!last || last.from !== "seller" || last.action !== "counter") throw new Error("no counter to accept");
  for (const o of it.holds) if (o.buyer === b.name && o.status === "held") refund(o);
  const h = hold(it, b, "offer", last.amount); capture(h);
  turn(it, b, "buyer", "accept", last.amount, "");
  const reply = turn(it, b, "seller", "accept", last.amount, "Deal. NFT delivered.");
  sell(it, b, last.amount, h); push(); return { hold: h, reply, item: it };
}
function bid(it, b, max) {
  if (it.status !== "listed" || it.mechanism !== "auction") throw new Error("not an open auction");
  if (max > b.balance) throw new Error("insufficient dUSDC for this hold");
  for (const o of it.holds) if (o.buyer === b.name && o.status === "held") refund(o);
  const h = hold(it, b, "bid", max);
  const live = it.holds.filter((x) => x.kind === "bid" && x.status === "held").sort((a, z) => z.amount - a.amount);
  it.auction.bids++; it.auction.leader = live[0].buyer; it.auction.price = Math.max(floors[it.id], (live[1]?.amount ?? 0) + 1); it.auction.reserveMet = live[0].amount >= floors[it.id];
  log(b.name, `bids up to ${max} on ${it.name} (held)`, h.tx); push(); return { hold: h, item: it };
}
function closeAuction(it) {
  if (it.status !== "listed" || it.mechanism !== "auction") return;
  const live = it.holds.filter((x) => x.kind === "bid" && x.status === "held").sort((a, z) => z.amount - a.amount);
  it.auction.closed = true;
  if (!live.length || live[0].amount < floors[it.id]) { live.forEach(refund); it.status = "unsold"; log("Seller", `${it.name}: reserve not met, all bids refunded`); push(); return; }
  const price = Math.max(floors[it.id], (live[1]?.amount ?? 0) + 1);
  capture(live[0], price); sell(it, buyer(live[0].buyer), price, live[0]); push();
}
function buy(it, b) {
  if (it.status !== "listed" || it.mechanism === "auction") throw new Error("not available to buy now");
  const p = it.mechanism === "offers" ? it.ask : it.price ?? it.ask;
  if (p > b.balance) throw new Error("insufficient dUSDC");
  const h = hold(it, b, "buy", p);
  if (it.kind === "digital") { h.settleTx = undefined; it.status = "sold"; it.soldTo = b.name; it.soldFor = p; it.saleTx = h.tx; log("Seller", `delivers ${it.name} to ${b.name}; payment releases in 7 days unless reclaimed`, h.tx); push(); return { hold: h, item: it }; }
  capture(h); sell(it, b, p, h); push(); return { hold: h, item: it };
}

// ---------------------------------------------------------------- scripted scenes
const A = () => buyer("b-ape"), H = () => buyer("b-hag"), M = () => buyer("b-mcp");
const scenes = [
  ["Haggler lowballs Banana Baron", () => offer(item("banana-baron"), H(), 60)],
  ["Ape-Agent bids on the Mandrill", () => bid(item("moonwalk-mandrill"), A(), 105)],
  ["Haggler raises to 68", () => offer(item("banana-baron"), H(), 68)],
  ["Claude (MCP) outbids", () => bid(item("moonwalk-mandrill"), M(), 118)],
  ["Ape-Agent offers 72 on Banana Baron", () => offer(item("banana-baron"), A(), 72)],
  ["Haggler bids too low", () => bid(item("moonwalk-mandrill"), H(), 90)],
  ["Ape-Agent accepts the counter", () => respond(item("banana-baron"), A(), "accept")],
  ["Auction closes", () => closeAuction(item("moonwalk-mandrill"))],
  ["Claude (MCP) buys the Gibbon at the Dutch price", () => buy(item("gold-gibbon"), M())],
];
let sceneIx = 0;
function nextScene() {
  if (sceneIx >= scenes.length) return "scenario complete";
  const [name, fn] = scenes[sceneIx++];
  Object.assign(state.scenario, { scene: sceneIx, total: scenes.length, next: scenes[sceneIx]?.[0] });
  try { fn(); } catch (e) { log("mock", `scene failed: ${e.message}`); }
  push(); return name;
}
if (!STEP) setInterval(nextScene, 6000);
setInterval(() => { // dutch ticker + auction close
  const g = item("gold-gibbon");
  if (g.status === "listed" && g.mechanism === "dutch") { g.price = Math.max(floors[g.id], g.price - 2); push(); }
  const m = item("moonwalk-mandrill");
  if (m.status === "listed" && Date.parse(m.auction.endsAt) < Date.now()) closeAuction(m);
}, 3000);
Object.assign(state.scenario, { mode: STEP ? "step" : "auto", total: scenes.length, next: scenes[0][0] });
log("Seller", "listed 4 monkeys and a print, and picked a mechanism for each");

// ---------------------------------------------------------------- http
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch { r({}); } }); });
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  try {
    if (req.method === "GET" && (p === "/" || p === "/index.html")) { res.writeHead(200, { "content-type": "text/html" }); return res.end(fs.readFileSync(path.join(DIR, "index.html"))); }
    if (req.method === "GET" && p.startsWith("/public/")) {
      const f = path.join(DIR, path.normalize(p.slice(8)).replace(/^(\.\.[/\\])+/, ""));
      if (!f.startsWith(DIR) || !fs.existsSync(f)) return send(res, 404, { error: "not found" });
      return res.end(fs.readFileSync(f));
    }
    if (p === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify(state)}\n\n`); clients.add(res); req.on("close", () => clients.delete(res)); return;
    }
    if (req.method === "GET" && p === "/api/items") return send(res, 200, state.items);
    let m;
    if (req.method === "GET" && (m = p.match(/^\/api\/items\/([^/]+)$/))) {
      const it = item(m[1]); if (!it) return send(res, 404, { error: "unknown item" });
      const b = buyer(u.searchParams.get("buyerId") ?? ""); if (b && !it.watchers.includes(b.name)) { it.watchers.push(b.name); push(); }
      return send(res, 200, it);
    }
    if (req.method === "POST" && p === "/api/buyers") {
      const { name, kind, max } = await body(req);
      const b = { id: `b-${Math.random().toString(36).slice(2, 8)}`, name: name || "Buyer", kind: kind || "human", max, wallet: sig().slice(0, 44), balance: 300 };
      state.buyers.push(b); log(b.name, "joined with 300 dUSDC", sig()); push(); return send(res, 200, b);
    }
    if (req.method === "GET" && (m = p.match(/^\/api\/buyers\/([^/]+)$/))) {
      const b = state.buyers.find((x) => x.id === m[1]); if (!b) return send(res, 404, { error: "unknown buyer" });
      return send(res, 200, { ...b, holds: state.items.flatMap((i) => i.holds.filter((h) => h.buyer === b.name)) });
    }
    if (req.method === "POST" && (m = p.match(/^\/api\/items\/([^/]+)\/(offer|respond|bid|buy)$/))) {
      const it = item(m[1]); if (!it) return send(res, 404, { error: "unknown item" });
      const q = await body(req); const b = state.buyers.find((x) => x.id === q.buyerId);
      if (!b) return send(res, 404, { error: "unknown buyer" });
      const r = m[2] === "offer" ? offer(it, b, Number(q.amount)) : m[2] === "respond" ? respond(it, b, q.action)
        : m[2] === "bid" ? bid(it, b, Number(q.max)) : buy(it, b);
      return send(res, 200, r);
    }
    if (req.method === "POST" && (m = p.match(/^\/api\/holds\/([^/]+)\/reclaim$/))) {
      const h = state.items.flatMap((i) => i.holds).find((x) => x.id === m[1]); if (!h) return send(res, 404, { error: "unknown hold" });
      if (h.status !== "held") return send(res, 400, { error: "hold already settled" });
      if (h.kind === "bid" && item(h.itemId).auction?.leader === h.buyer) return send(res, 400, { error: "leading bid can't be reclaimed until the auction closes" });
      refund(h); log(h.buyer, `reclaimed ${h.amount}`, h.settleTx);
      const it = item(h.itemId); if (it.kind === "digital" && it.soldTo === h.buyer) Object.assign(it, { status: "listed", soldTo: undefined, soldFor: undefined, saleTx: undefined });
      push(); return send(res, 200, { hold: h });
    }
    if (req.method === "POST" && p === "/api/control/goal") {
      const { itemId, goal } = await body(req); const it = item(itemId); if (!it) return send(res, 404, { error: "unknown item" });
      it.goal = goal;
      it.reason = goal === "quick-sale" ? `You want a quick sale, so I'll concede faster (${it.mechanism}).` : `Holding out for the best price (${it.mechanism}).`;
      log("Seller", `${it.name}: goal → ${goal}`); push(); return send(res, 200, it);
    }
    if (req.method === "POST" && p === "/api/control/next") return send(res, 200, { step: nextScene() });
    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 400, { error: e.message }); }
}).listen(PORT, () => console.log(`mock market on http://localhost:${PORT}${STEP ? " (step mode)" : ""}`));
