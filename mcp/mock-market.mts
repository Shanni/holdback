// In-memory mock of the Holdback market API (demo/API.md) — no chain, fake tx URLs.
// Run: node mcp/mock-market.mts   (PORT env, default 4041)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type Hold = { id: string; itemId: string; buyer: string; kind: "offer" | "bid" | "buy"; amount: number;
  captured?: number; status: "held" | "captured" | "refunded"; tx: string; settleTx?: string };
type Turn = { from: "buyer" | "seller"; buyer: string; amount: number;
  action: "offer" | "counter" | "accept" | "decline" | "walk_away"; message: string; at: string };
type Item = { id: string; name: string; hue: number; mechanism: "buy-now" | "offers" | "auction" | "dutch";
  reason: string; goal: "best-price" | "quick-sale"; ask: number; price?: number;
  status: "listed" | "sold" | "unsold"; soldTo?: string; soldFor?: number; saleTx?: string; watchers: string[];
  auction?: { endsAt: string; bids: number; leader?: string; reserveMet: boolean };
  negotiations: Record<string, Turn[]>; holds: Hold[] };
type Buyer = { id: string; name: string; kind: string; max?: number; wallet: string; balance: number };

let seq = 0;
const tx = () => `https://explorer.solana.com/tx/MOCK${(++seq).toString(36).padStart(8, "0")}?cluster=devnet`;
const now = () => new Date().toISOString();

export function makeMarket() {
  const floors: Record<string, number> = { "golden-monkey": 65, "space-monkey": 50, "pixel-monkey": 40, "zen-monkey": 30 };
  const bidMax: Record<string, Record<string, number>> = {};
  const items: Item[] = [
    { id: "golden-monkey", name: "Golden Monkey", hue: 45, mechanism: "offers", reason: "One-of-a-kind; let buyers bargain.", goal: "best-price", ask: 95, status: "listed", watchers: [], negotiations: {}, holds: [] },
    { id: "space-monkey", name: "Space Monkey", hue: 220, mechanism: "auction", reason: "Several watchers — let them compete.", goal: "best-price", ask: 60, status: "listed", watchers: [], negotiations: {}, holds: [], auction: { endsAt: new Date(Date.now() + 3600e3).toISOString(), bids: 0, reserveMet: false } },
    { id: "pixel-monkey", name: "Pixel Monkey", hue: 300, mechanism: "dutch", reason: "Quick sale: price falls until someone bites.", goal: "quick-sale", ask: 80, price: 65, status: "listed", watchers: [], negotiations: {}, holds: [] },
    { id: "zen-monkey", name: "Zen Monkey", hue: 120, mechanism: "buy-now", reason: "Common edition, fixed price.", goal: "quick-sale", ask: 35, price: 35, status: "listed", watchers: [], negotiations: {}, holds: [] },
  ];
  const buyers: Buyer[] = [];
  const holds: Hold[] = [];
  const C = [0.3, 0.5, 0.7, 0.85];

  const refund = (h: Hold, b: Buyer) => { if (h.status === "held") { h.status = "refunded"; h.settleTx = tx(); b.balance += h.amount; } };
  const place = (it: Item, b: Buyer, kind: Hold["kind"], amount: number): Hold => {
    if (b.balance < amount) throw new Error(`insufficient balance (${b.balance} dUSDC)`);
    b.balance -= amount;
    const h: Hold = { id: `h${holds.length + 1}`, itemId: it.id, buyer: b.name, kind, amount, status: "held", tx: tx() };
    holds.push(h); it.holds.push(h);
    return h;
  };
  const capture = (it: Item, b: Buyer, h: Hold, price: number) => {
    h.status = "captured"; h.captured = price; h.settleTx = tx(); b.balance += h.amount - price;
    it.status = "sold"; it.soldTo = b.name; it.soldFor = price; it.saleTx = h.settleTx;
  };
  const item = (id: string) => { const it = items.find((i) => i.id === id); if (!it) throw new Error(`no item ${id}`); return it; };
  const buyer = (id: string) => { const b = buyers.find((x) => x.id === id); if (!b) throw new Error(`no buyer ${id}`); return b; };
  const listed = (it: Item) => { if (it.status !== "listed") throw new Error(`${it.name} is ${it.status}`); };
  // Optional buyer note (≤280 chars): the mock seller quotes it back in its reply.
  const note = (body: any) => (typeof body?.message === "string" && body.message.trim() ? body.message.trim().slice(0, 280) : undefined);
  const ack = (msg: string | undefined) => (msg ? `You said "${msg.length > 60 ? msg.slice(0, 57) + "..." : msg}", noted. ` : "");

  async function handle(method: string, path: string, q: URLSearchParams, body: any): Promise<unknown> {
    let m: RegExpMatchArray | null;
    if (method === "GET" && path === "/api/items") return items;
    if (method === "GET" && (m = path.match(/^\/api\/items\/([^/]+)$/))) {
      const it = item(m[1]);
      const bid = q.get("buyerId");
      if (bid) { const b = buyer(bid); if (!it.watchers.includes(b.name)) it.watchers.push(b.name); }
      return it;
    }
    if (method === "POST" && path === "/api/buyers") {
      const existing = buyers.find((b) => b.name === body.name);
      if (existing) return existing;
      const b: Buyer = { id: `b${buyers.length + 1}`, name: body.name, kind: body.kind, max: body.max, wallet: `MockWallet${buyers.length + 1}`, balance: 300 };
      buyers.push(b); return b;
    }
    if (method === "GET" && (m = path.match(/^\/api\/buyers\/([^/]+)$/))) {
      const b = buyer(m[1]); return { ...b, holds: holds.filter((h) => h.buyer === b.name) };
    }
    if (method === "POST" && (m = path.match(/^\/api\/items\/([^/]+)\/offer$/))) {
      const it = item(m[1]); listed(it); const b = buyer(body.buyerId); const amount = Number(body.amount);
      if (it.mechanism !== "offers") throw new Error(`${it.name} is sold by ${it.mechanism}, not offers`);
      it.holds.filter((h) => h.buyer === b.name && h.kind === "offer").forEach((h) => refund(h, b));
      const h = place(it, b, "offer", amount);
      const turns = (it.negotiations[b.name] ??= []);
      const msg = note(body);
      turns.push({ from: "buyer", buyer: b.name, amount, action: "offer", message: msg ?? `I offer ${amount}.`, at: now() });
      const round = turns.filter((t) => t.from === "seller").length;
      const floor = floors[it.id];
      let reply: Turn;
      if (amount >= it.ask) {
        capture(it, b, h, amount);
        reply = { from: "seller", buyer: b.name, amount, action: "accept", message: `Deal at ${amount}.`, at: now() };
      } else if (amount < floor) {
        refund(h, b);
        reply = { from: "seller", buyer: b.name, amount: it.ask, action: "decline", message: `Too low. I'd sell at ${it.ask}.`, at: now() };
      } else {
        const c = round < C.length ? C[round] : 0.5;
        const counter = Math.round(Math.max(floor, it.ask - (it.ask - amount) * c));
        if (counter <= amount) { capture(it, b, h, amount); reply = { from: "seller", buyer: b.name, amount, action: "accept", message: `Fine — ${amount} it is.`, at: now() }; }
        else reply = { from: "seller", buyer: b.name, amount: counter, action: "counter", message: `I can do ${counter}.`, at: now() };
      }
      reply.message = ack(msg) + reply.message;
      turns.push(reply);
      return { hold: h, reply, item: it };
    }
    if (method === "POST" && (m = path.match(/^\/api\/items\/([^/]+)\/respond$/))) {
      const it = item(m[1]); listed(it); const b = buyer(body.buyerId);
      const turns = (it.negotiations[b.name] ??= []);
      const old = it.holds.filter((h) => h.buyer === b.name && h.kind === "offer" && h.status === "held");
      const msg = note(body);
      if (msg) turns.push({ from: "buyer", buyer: b.name, amount: 0, action: body.action === "accept" ? "accept" : "walk_away", message: msg, at: now() });
      if (body.action === "walk_away") {
        old.forEach((h) => refund(h, b));
        const reply: Turn = { from: "seller", buyer: b.name, amount: 0, action: "walk_away", message: ack(msg) + "Understood — your hold is refunded.", at: now() };
        turns.push(reply); return { hold: old[0], reply, item: it };
      }
      const last = [...turns].reverse().find((t) => t.from === "seller" && t.action === "counter");
      if (!last) throw new Error("no counter to accept");
      old.forEach((h) => refund(h, b));
      const h = place(it, b, "offer", last.amount);
      capture(it, b, h, last.amount);
      const reply: Turn = { from: "seller", buyer: b.name, amount: last.amount, action: "accept", message: ack(msg) + `Sold at ${last.amount}. Enjoy!`, at: now() };
      turns.push(reply); return { hold: h, reply, item: it };
    }
    if (method === "POST" && (m = path.match(/^\/api\/items\/([^/]+)\/bid$/))) {
      const it = item(m[1]); listed(it); const b = buyer(body.buyerId); const max = Number(body.max);
      if (it.mechanism !== "auction") throw new Error(`${it.name} is not an auction`);
      const h = place(it, b, "bid", max);
      const maxes = (bidMax[it.id] ??= {}); maxes[b.name] = max;
      const sorted = Object.entries(maxes).sort((a, c) => c[1] - a[1]);
      it.auction!.bids++; it.auction!.leader = sorted[0][0]; it.auction!.reserveMet = sorted[0][1] >= floors[it.id];
      return { hold: h, item: it };
    }
    if (method === "POST" && (m = path.match(/^\/api\/items\/([^/]+)\/buy$/))) {
      const it = item(m[1]); listed(it); const b = buyer(body.buyerId);
      if (it.mechanism !== "buy-now" && it.mechanism !== "dutch") throw new Error(`${it.name} is not buy-now`);
      const price = it.price ?? it.ask;
      const h = place(it, b, "buy", price); capture(it, b, h, price);
      return { hold: h, item: it };
    }
    if (method === "POST" && (m = path.match(/^\/api\/holds\/([^/]+)\/reclaim$/))) {
      const h = holds.find((x) => x.id === m![1]); if (!h) throw new Error("no such hold");
      const b = buyer(body.buyerId); if (h.buyer !== b.name) throw new Error("not your hold");
      if (h.status !== "held") throw new Error(`hold is already ${h.status}`);
      refund(h, b); return { hold: h };
    }
    const e = new Error(`not found: ${method} ${path}`); (e as any).status = 404; throw e;
  }

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://x");
    let raw = ""; for await (const c of req) raw += c;
    try {
      const out = await handle(req.method || "GET", url.pathname, url.searchParams, raw ? JSON.parse(raw) : {});
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    } catch (e) {
      res.writeHead((e as any).status ?? 400, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 4041);
  makeMarket().listen(port, () => console.log(`mock market on http://localhost:${port}`));
}
