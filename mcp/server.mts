#!/usr/bin/env node
// Holdback Market MCP server (stdio). A thin HTTP client of the market server (demo/API.md).
// Run: node mcp/server.mts   (Node 22+ type stripping; no build step)
// Env: MARKET_URL (default http://localhost:4022), BUYER_NAME (default "Claude"), OWNER_MAX (default 90)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MARKET_URL = (process.env.MARKET_URL || "http://localhost:4022").replace(/\/+$/, "");
const BUYER_NAME = process.env.BUYER_NAME || "Claude";
const OWNER_MAX = Number(process.env.OWNER_MAX || 90);

type Hold = {
  id: string; itemId: string; buyer: string; kind: "offer" | "bid" | "buy";
  amount: number; captured?: number; status: "held" | "captured" | "refunded"; tx: string; settleTx?: string;
};
type Turn = {
  from: "buyer" | "seller"; buyer: string; amount: number;
  action: "offer" | "counter" | "accept" | "decline" | "walk_away"; message: string; at: string;
  read?: string[];
};
type Item = {
  id: string; name: string; hue: number; image?: string;
  mechanism: "buy-now" | "offers" | "auction" | "dutch"; reason: string;
  goal: "best-price" | "quick-sale"; ask: number; price?: number;
  status: "listed" | "sold" | "unsold"; soldTo?: string; soldFor?: number; saleTx?: string;
  watchers: string[];
  auction?: { endsAt: string; bids: number; leader?: string; reserveMet: boolean };
  negotiations: Record<string, Turn[]>;
  holds: Hold[];
};
type Buyer = { id: string; name: string; kind: string; max?: number; wallet: string; balance: number };

// ---------- HTTP ----------
class MarketError extends Error {}

async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(MARKET_URL + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new MarketError(`Cannot reach the Holdback market at ${MARKET_URL} (${(e as Error).message}). Is the market server running?`);
  }
  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) throw new MarketError(`Market refused (${res.status}): ${data?.error ?? text}`);
  return data as T;
}

let buyer: Buyer | null = null;
let registering: Promise<Buyer> | null = null;
async function me(): Promise<Buyer> {
  if (buyer) return buyer;
  if (!registering) {
    registering = api<Buyer>("POST", "/api/buyers", { name: BUYER_NAME, kind: "mcp", max: OWNER_MAX })
      .then((b) => (buyer = b))
      .catch((e) => { registering = null; throw e; });
  }
  return registering;
}

// ---------- formatting ----------
const usd = (n: number | undefined) => (n === undefined ? "?" : `${n} dUSDC`);

function holdLine(h: Hold): string {
  const what = h.status === "held"
    ? `HELD ${usd(h.amount)} in escrow`
    : h.status === "captured"
      ? `CAPTURED ${usd(h.captured ?? h.amount)} (paid to seller${h.captured !== undefined && h.captured < h.amount ? `, ${h.amount - h.captured} refunded` : ""})`
      : `REFUNDED ${usd(h.amount)} back to your wallet`;
  const txs = [h.tx && `tx: ${h.tx}`, h.settleTx && `settle tx: ${h.settleTx}`].filter(Boolean).join(" | ");
  return `- hold ${h.id} (${h.kind} on ${h.itemId}): ${what}${txs ? ` — ${txs}` : ""}`;
}

function itemSummary(it: Item): string {
  const lines = [`${it.name} [${it.id}] — ${it.status.toUpperCase()}`];
  lines.push(`  mechanism: ${it.mechanism} (${it.reason})`);
  lines.push(`  ask: ${usd(it.ask)}${it.price !== undefined ? ` | current price: ${usd(it.price)}` : ""}`);
  if (it.auction) {
    lines.push(`  auction: ${it.auction.bids} bids, leader ${it.auction.leader ?? "none"}, reserve ${it.auction.reserveMet ? "met" : "not met"}, ends ${it.auction.endsAt}`);
  }
  if (it.status === "sold") lines.push(`  sold to ${it.soldTo} for ${usd(it.soldFor)}${it.saleTx ? ` — tx: ${it.saleTx}` : ""}`);
  lines.push(`  watchers: ${it.watchers.length ? it.watchers.join(", ") : "none"}`);
  return lines.join("\n");
}

function howToBuy(it: Item): string {
  if (it.status !== "listed") return "This item is no longer for sale.";
  switch (it.mechanism) {
    case "offers": return "To buy: make_offer(id, amount). The seller replies immediately (accept / counter / decline).";
    case "auction": return "To buy: place_bid(id, max) — a proxy bid; you pay the 2nd-highest max + 1, never more than your max.";
    case "dutch": return "To buy: buy_now(id) at the current (falling) price, or wait for it to drop.";
    case "buy-now": return "To buy: buy_now(id) at the listed price.";
  }
}

function lastTurns(it: Item, name: string, n = 4): string {
  const turns = it.negotiations?.[name] ?? [];
  if (!turns.length) return "";
  return "Negotiation so far:\n" + turns.slice(-n).map((t) =>
    `  ${t.from === "buyer" ? "you" : "seller"}: ${t.action} ${usd(t.amount)} — "${t.message}"`).join("\n");
}

const messageArg = z.string().max(280).optional().describe(
  "Optional note to the seller (≤280 chars), e.g. why you're offering this price, that you're a fan or on a budget, or a question about the piece. The seller agent reads it and answers.",
);
/** The seller's reply, shown prominently. */
function sellerSays(r: Turn): string {
  const price = r.action === "accept" ? `ACCEPTS at ${usd(r.amount)}` : r.action === "decline" ? `DECLINES (asks ${usd(r.amount)})` : `COUNTERS at ${usd(r.amount)}`;
  return `SELLER ${price}\n>> Seller: ${r.message}${r.read?.length ? `\n   (the seller read your note as: ${r.read.join(", ")})` : ""}`;
}

function result(text: string, json: unknown) {
  return { content: [{ type: "text" as const, text: `${text}\n\n---\n${JSON.stringify(json, null, 2)}` }] };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function overMax(amount: number, verb: string) {
  return fail(
    `Refused: ${verb} ${usd(amount)} is above your owner's limit of ${usd(OWNER_MAX)} (OWNER_MAX). ` +
    `You may not commit more than ${usd(OWNER_MAX)} on any item. Try an amount ≤ ${OWNER_MAX}, or walk away.`,
  );
}

async function guard<T>(fn: () => Promise<T>) {
  try { return await fn(); } catch (e) {
    if (e instanceof MarketError) return fail(e.message);
    return fail(`Unexpected error: ${(e as Error).message}`);
  }
}

// ---------- server ----------
const server = new McpServer(
  { name: "holdback-market", version: "0.1.0" },
  {
    instructions:
      `Holdback is an NFT market where every payment is an escrow HOLD on Solana. ` +
      `When you make an offer, bid or purchase, the amount is locked on-chain from your wallet (dUSDC). ` +
      `If the deal clears it is CAPTURED (and any excess refunded); if not, it is REFUNDED automatically — you never lose money on a failed deal. ` +
      `You buy on behalf of an owner whose hard spending limit is ${OWNER_MAX} dUSDC: never offer, bid or pay more than that. ` +
      `Start with list_items, then get_item to see how an item is sold and the negotiation so far.`,
  },
);

server.registerTool("list_items", {
  title: "List items",
  description:
    "List every NFT on the Holdback market with its sale mechanism (offers / auction / dutch / buy-now), ask price and status. " +
    `Start here. Your owner's spending limit is ${OWNER_MAX} dUSDC.`,
  inputSchema: {},
}, async () => guard(async () => {
  await me();
  const items = await api<Item[]>("GET", "/api/items");
  const text = items.map((it) =>
    `- ${it.name} [${it.id}]: ${it.status}, ${it.mechanism}, ask ${usd(it.ask)}${it.price !== undefined ? `, price ${usd(it.price)}` : ""}`).join("\n");
  return result(`${items.length} items on the market (your limit: ${usd(OWNER_MAX)}):\n${text}`,
    items.map(({ negotiations, holds, ...rest }) => rest));
}));

server.registerTool("get_item", {
  title: "Get item",
  description:
    "Look at one item in detail: mechanism, the seller's reason for it, ask price, auction state, and your negotiation history with the seller. " +
    "Viewing registers you as a watcher — the seller agent may switch the sale mechanism when demand rises (e.g. offers → auction), so re-check before acting.",
  inputSchema: { id: z.string().describe("Item id from list_items") },
}, async ({ id }) => guard(async () => {
  const b = await me();
  const it = await api<Item>("GET", `/api/items/${encodeURIComponent(id)}?buyerId=${encodeURIComponent(b.id)}`);
  const mine = (it.holds ?? []).filter((h) => h.buyer === b.name || h.buyer === b.id);
  const text = [
    itemSummary(it),
    howToBuy(it),
    lastTurns(it, b.name),
    mine.length ? "Your holds on this item:\n" + mine.map(holdLine).join("\n") : "",
  ].filter(Boolean).join("\n");
  return result(text, it);
}));

server.registerTool("make_offer", {
  title: "Make offer",
  description:
    "Offer a price on an item sold by 'offers'. The amount is HELD in escrow on Solana from your wallet the moment you offer. " +
    "The seller agent replies at once: ACCEPT (the hold is captured and the NFT delivered — you bought it), COUNTER (your hold stays held; the seller names a price), " +
    "or DECLINE (your hold is refunded). To counter the seller's counter, call make_offer again with a new amount — the new offer replaces your previous one and the old hold is refunded. " +
    "To take the seller's counter as-is, use respond_to_counter(id, 'accept'); to quit, respond_to_counter(id, 'walk_away'). " +
    `Sellers concede more each round, so start below the ask and move up gradually. Never exceed your owner's limit of ${OWNER_MAX} dUSDC. ` +
    "You can explain yourself with an optional `message` (≤280 chars): the seller agent reads it and replies to it. Be honest and polite: a genuine budget constraint can earn a slightly bigger concession, rudeness earns none, and you can ask about the piece (edition, escrow, guarantee).",
  inputSchema: {
    id: z.string().describe("Item id"),
    amount: z.number().positive().describe(`Offer in whole dUSDC (max ${OWNER_MAX})`),
    message: messageArg,
  },
}, async ({ id, amount, message }) => {
  if (amount > OWNER_MAX) return overMax(amount, "offering");
  return guard(async () => {
    const b = await me();
    const r = await api<{ hold: Hold; reply: Turn; item: Item }>("POST", `/api/items/${encodeURIComponent(id)}/offer`, { buyerId: b.id, amount, ...(message ? { message } : {}) });
    const lines = [sellerSays(r.reply), "", `You offered ${usd(amount)} on ${r.item.name}${message ? ` with the note "${message}"` : ""}.`, holdLine(r.hold)];
    if (r.reply.action === "counter") {
      lines.push(r.reply.amount > OWNER_MAX
        ? `Note: the counter (${usd(r.reply.amount)}) is above your owner's limit (${usd(OWNER_MAX)}). You can offer again up to ${OWNER_MAX} or walk away.`
        : `Next: make_offer again with a higher amount to keep bargaining, respond_to_counter(accept) to buy at ${usd(r.reply.amount)}, or respond_to_counter(walk_away) to get your hold refunded.`);
    } else if (r.reply.action === "accept") {
      lines.push(`Deal! You bought ${r.item.name}${r.item.soldFor !== undefined ? ` for ${usd(r.item.soldFor)}` : ""}.${r.item.saleTx ? ` Sale tx: ${r.item.saleTx}` : ""}`);
    } else if (r.reply.action === "decline") {
      lines.push("Your offer was declined and your hold refunded.");
    }
    return result(lines.join("\n"), r);
  });
});

server.registerTool("respond_to_counter", {
  title: "Respond to counter",
  description:
    "Answer the seller's latest counter-offer. 'accept' buys the item at the seller's counter price: a new hold is placed at that price, your old hold is refunded, " +
    "and payment is captured with NFT delivery in one transaction. 'walk_away' ends the negotiation and refunds your hold. " +
    "(To counter with a different price instead, call make_offer again with the new amount.) " +
    `Will refuse to accept a counter above your owner's limit of ${OWNER_MAX} dUSDC. ` +
    "Add an optional `message` (≤280 chars) to tell the seller why, e.g. why you're walking away; the seller replies to it.",
  inputSchema: {
    id: z.string().describe("Item id"),
    action: z.enum(["accept", "walk_away"]),
    message: messageArg,
  },
}, async ({ id, action, message }) => guard(async () => {
  const b = await me();
  if (action === "accept") {
    const it = await api<Item>("GET", `/api/items/${encodeURIComponent(id)}`);
    const turns = it.negotiations?.[b.name] ?? [];
    const lastCounter = [...turns].reverse().find((t) => t.from === "seller" && t.action === "counter");
    if (lastCounter && lastCounter.amount > OWNER_MAX) return overMax(lastCounter.amount, "accepting a counter of");
  }
  const r = await api<{ hold?: Hold; reply: Turn; item: Item }>("POST", `/api/items/${encodeURIComponent(id)}/respond`, { buyerId: b.id, action, ...(message ? { message } : {}) });
  const lines = [
    `>> Seller: ${r.reply.message}${r.reply.read?.length ? `\n   (the seller read your note as: ${r.reply.read.join(", ")})` : ""}`, "",
    (action === "accept" ? `You accepted the seller's counter on ${r.item.name}` : `You walked away from ${r.item.name}`) + (message ? ` with the note "${message}".` : "."),
  ];
  if (r.hold) lines.push(holdLine(r.hold));
  if (r.item.status === "sold" && r.item.soldTo === b.name) {
    lines.push(`You own ${r.item.name} — paid ${usd(r.item.soldFor)}.${r.item.saleTx ? ` Sale tx: ${r.item.saleTx}` : ""}`);
  }
  if (action === "walk_away") lines.push("Your held offer is refunded.");
  return result(lines.join("\n"), r);
}));

server.registerTool("place_bid", {
  title: "Place proxy bid",
  description:
    "Place a proxy bid on an item sold by 'auction'. Your MAX is HELD in escrow, but if you win you pay only the 2nd-highest max + 1 (at least the reserve) and the rest is refunded; " +
    "if you lose, the whole hold is refunded when the auction closes. So bid the most you are truly willing to pay — the proxy never exceeds it. " +
    `Your max must not exceed your owner's limit of ${OWNER_MAX} dUSDC.`,
  inputSchema: {
    id: z.string().describe("Item id"),
    max: z.number().positive().describe(`Your maximum in whole dUSDC (≤ ${OWNER_MAX})`),
  },
}, async ({ id, max }) => {
  if (max > OWNER_MAX) return overMax(max, "bidding");
  return guard(async () => {
    const b = await me();
    const r = await api<{ hold: Hold; item: Item }>("POST", `/api/items/${encodeURIComponent(id)}/bid`, { buyerId: b.id, max });
    const a = r.item.auction;
    const lines = [`Proxy bid placed on ${r.item.name} with max ${usd(max)}.`, holdLine(r.hold)];
    if (a) lines.push(`Auction: ${a.bids} bids, leader ${a.leader ?? "none"}${a.leader === b.name ? " (you!)" : ""}, reserve ${a.reserveMet ? "met" : "not met"}, ends ${a.endsAt}.`);
    lines.push("If you win you pay 2nd-highest max + 1; the difference and any losing hold are refunded.");
    return result(lines.join("\n"), r);
  });
});

server.registerTool("buy_now", {
  title: "Buy now",
  description:
    "Buy an item immediately at its buy-now price, or at the current price of a falling 'dutch' auction. The price is held and captured in one step with NFT delivery. " +
    `Refuses if the price is above your owner's limit of ${OWNER_MAX} dUSDC (check get_item first; a dutch price keeps falling, so waiting can pay).`,
  inputSchema: { id: z.string().describe("Item id") },
}, async ({ id }) => guard(async () => {
  const b = await me();
  const it = await api<Item>("GET", `/api/items/${encodeURIComponent(id)}`);
  const price = it.price ?? it.ask;
  if (price > OWNER_MAX) return overMax(price, "buying at");
  const r = await api<{ hold: Hold; item: Item }>("POST", `/api/items/${encodeURIComponent(id)}/buy`, { buyerId: b.id });
  const lines = [`Bought ${r.item.name}.`, holdLine(r.hold)];
  if (r.item.saleTx) lines.push(`Sale tx: ${r.item.saleTx}`);
  return result(lines.join("\n"), r);
}));

server.registerTool("my_holds", {
  title: "My holds",
  description:
    "Show your wallet balance and every escrow hold you have: HELD (locked, pending), CAPTURED (paid — you bought something), REFUNDED (returned to you). Includes Solana explorer links.",
  inputSchema: {},
}, async () => guard(async () => {
  const b = await me();
  const r = await api<Buyer & { holds: Hold[] }>("GET", `/api/buyers/${encodeURIComponent(b.id)}`);
  const held = r.holds.filter((h) => h.status === "held").reduce((s, h) => s + h.amount, 0);
  const lines = [
    `${r.name} — wallet ${r.wallet}`,
    `balance: ${usd(r.balance)} | currently held in escrow: ${usd(held)} | owner limit: ${usd(OWNER_MAX)}`,
    r.holds.length ? r.holds.map(holdLine).join("\n") : "No holds yet.",
  ];
  return result(lines.join("\n"), r);
}));

server.registerTool("reclaim", {
  title: "Reclaim hold",
  description:
    "Reclaim (refund) one of your HELD holds that is no longer needed — e.g. a stale offer or a hold whose deal expired. Funds return to your wallet on-chain.",
  inputSchema: { hold_id: z.string().describe("Hold id from my_holds") },
}, async ({ hold_id }) => guard(async () => {
  const b = await me();
  const r = await api<{ hold: Hold }>("POST", `/api/holds/${encodeURIComponent(hold_id)}/reclaim`, { buyerId: b.id });
  return result(`Reclaimed.\n${holdLine(r.hold)}`, r);
}));

server.registerPrompt("buy_for_me", {
  title: "Buy for me",
  description: "Have Claude bargain for an item on the Holdback market within a budget.",
  argsSchema: {
    item: z.string().describe("Item name or id, e.g. 'the golden monkey'"),
    budget: z.string().describe(`Most you will pay in dUSDC (capped at the owner limit ${OWNER_MAX})`),
  },
}, ({ item, budget }) => {
  const cap = Math.min(Number(budget) || OWNER_MAX, OWNER_MAX);
  return {
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text:
`Buy "${item}" for me on the Holdback market. My budget is ${cap} dUSDC — never commit more than that.
You may add a short, honest, polite message to your offers (e.g. that you're on a budget or a fan of the series); the seller agent reads it and replies.

How to do it:
1. list_items, find the item, then get_item to see how it is sold (the mechanism can change as other buyers watch).
2. If it is sold by OFFERS: open at about 60–65% of the ask. The seller counters with shrinking concessions, so raise in modest steps (roughly halfway between your last offer and their counter, but never above ${cap}). Accept with respond_to_counter once the counter is at or below what you would pay next, or after ~4 rounds if it is within budget. If the seller will not come within budget, walk_away (your hold is refunded).
3. If it is an AUCTION: place_bid once with max = ${cap}. You only pay the 2nd-highest max + 1.
4. If it is DUTCH: watch with get_item and buy_now once the price is comfortably within budget; if it is BUY-NOW, buy only if price ≤ ${cap}.
5. Every offer/bid is an escrow hold on Solana — refunded if not accepted. Narrate each step briefly (price, what is held/refunded, the seller's reply, tx links), and finish with my_holds to show the final state.`,
      },
    }],
  };
});

await server.connect(new StdioServerTransport());
console.error(`[holdback-market] MCP server ready — market ${MARKET_URL}, buyer "${BUYER_NAME}", owner max ${OWNER_MAX}`);
