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
  amount: number; captured?: number; refunded?: number;
  status: "held" | "captured" | "released" | "refunded";   // released: authorization voided, never charged
  ref: string;                // card processor reference (authorization id)
  refundableUntil?: string;   // guarantee purchases: refund available until then
  at: string; settledAt?: string;
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
  status: "listed" | "sold" | "unsold"; soldTo?: string; soldFor?: number;
  watchers: string[];
  auction?: { endsAt: string; bids: number; leader?: string; reserveMet: boolean; price?: number; closed?: boolean };
  negotiations: Record<string, Turn[]>;
  holds: Hold[];
  kind: "unique" | "digital" | "physical";   // unique: one of a kind, negotiable. digital / physical: fixed price + guarantee
  guarantee?: string;
  description?: string;
};
type Buyer = {
  id: string; name: string; kind: string; max?: number;
  card: string;      // payment method label
  balance: number;   // available credit on that card
};

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
const usd = (n: number | undefined) => (n === undefined ? "?" : `${n} USD`);

function holdLine(h: Hold): string {
  const charged = h.captured ?? h.amount;
  const what = h.status === "held"
    ? `HELD ${usd(h.amount)} on your card (authorized, not charged yet)`
    : h.status === "captured"
      ? `CHARGED ${usd(charged)} (captured${charged < h.amount ? `; the other ${h.amount - charged} of the authorization was released` : ""})` +
        (h.refundableUntil ? `, refundable until ${h.refundableUntil}` : "")
      : h.status === "released"
        ? `RELEASED ${usd(h.amount)} (authorization voided, never charged)`
        : `REFUNDED ${usd(h.refunded ?? charged)} back to your card`;
  return `- hold ${h.id} (${h.kind} on ${h.itemId}${h.ref && h.ref !== h.id ? `, ref ${h.ref}` : ""}): ${what}`;
}

function itemSummary(it: Item): string {
  const lines = [`${it.name} [${it.id}] — ${it.status.toUpperCase()} (${it.kind}${it.guarantee ? `, ${it.guarantee} refund guarantee` : ""})`];
  if (it.description) lines.push(`  ${it.description}`);
  lines.push(`  mechanism: ${it.mechanism} (${it.reason})`);
  lines.push(`  ask: ${usd(it.ask)}${it.price !== undefined ? ` | current price: ${usd(it.price)}` : ""}`);
  if (it.auction) {
    lines.push(`  auction: ${it.auction.bids} bids, leader ${it.auction.leader ?? "none"}, reserve ${it.auction.reserveMet ? "met" : "not met"}, ends ${it.auction.endsAt}`);
  }
  if (it.status === "sold") lines.push(`  sold to ${it.soldTo} for ${usd(it.soldFor)}`);
  lines.push(`  watchers: ${it.watchers.length ? it.watchers.join(", ") : "none"}`);
  return lines.join("\n");
}

function howToBuy(it: Item): string {
  if (it.status !== "listed") return "This item is no longer for sale.";
  switch (it.mechanism) {
    case "offers": return "To buy: make_offer(id, amount). The seller replies immediately (accept / counter / decline).";
    case "auction": return "To buy: place_bid(id, max) — a proxy bid; you pay the 2nd-highest max + 1, never more than your max.";
    case "dutch": return "To buy: buy_now(id) at the current (falling) price, or wait for it to drop.";
    case "buy-now": return it.kind === "unique"
      ? "To buy: buy_now(id) at the listed price."
      : `To buy: buy_now(id) at the fixed price. You are charged right away and can reclaim(hold_id) for a full refund within ${it.guarantee ?? "the guarantee window"}.`;
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
      `Holdback is a market where every offer, bid and purchase is a HOLD on your card (a card authorization, in USD). ` +
      `The amount is reserved on the card but not charged. If the deal clears the hold is CAPTURED (you are charged the deal price, and any excess is released); ` +
      `if not, it is RELEASED (the authorization is voided and you are never charged). Fixed-price items are charged at once and refundable within their guarantee window. ` +
      `You buy on behalf of an owner whose hard spending limit is ${OWNER_MAX} USD: never offer, bid or pay more than that. ` +
      `Start with list_items, then get_item to see how an item is sold and the negotiation so far.`,
  },
);

server.registerTool("list_items", {
  title: "List items",
  description:
    "List every item on the Holdback market with its kind (unique / digital / physical), sale mechanism (offers / auction / dutch / buy-now), ask price and status. " +
    `Start here. Your owner's spending limit is ${OWNER_MAX} USD.`,
  inputSchema: {},
}, async () => guard(async () => {
  await me();
  const items = await api<Item[]>("GET", "/api/items");
  const text = items.map((it) =>
    `- ${it.name} [${it.id}]: ${it.status}, ${it.kind}, ${it.mechanism}, ask ${usd(it.ask)}${it.price !== undefined ? `, price ${usd(it.price)}` : ""}`).join("\n");
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
    "Offer a price on a unique item sold by 'offers'. The amount is HELD on your card (authorized, not charged) the moment you offer. " +
    "The seller agent replies at once: ACCEPT (the hold is captured: you are charged and you bought it), COUNTER (your hold stays held; the seller names a price), " +
    "or DECLINE (your hold is released, nothing charged). To counter the seller's counter, call make_offer again with a new amount: the new offer replaces your previous one and the old hold is released. " +
    "To take the seller's counter as-is, use respond_to_counter(id, 'accept'); to quit, respond_to_counter(id, 'walk_away'). " +
    `Sellers concede more each round, so start below the ask and move up gradually. Never exceed your owner's limit of ${OWNER_MAX} USD. ` +
    "You can explain yourself with an optional `message` (≤280 chars): the seller agent reads it and replies to it. Be honest and polite: a genuine budget constraint can earn a slightly bigger concession, rudeness earns none, and you can ask about the piece (edition, condition, payment, guarantee).",
  inputSchema: {
    id: z.string().describe("Item id"),
    amount: z.number().positive().describe(`Offer in USD (max ${OWNER_MAX})`),
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
        : `Next: make_offer again with a higher amount to keep bargaining, respond_to_counter(accept) to buy at ${usd(r.reply.amount)}, or respond_to_counter(walk_away) to release your hold.`);
    } else if (r.reply.action === "accept") {
      lines.push(`Deal! You bought ${r.item.name}${r.item.soldFor !== undefined ? ` for ${usd(r.item.soldFor)}` : ""}.`);
    } else if (r.reply.action === "decline") {
      lines.push(`Your offer was declined and your hold released (nothing charged). The seller's price for you is now the ask, ${usd(r.reply.amount)}` +
        (r.reply.amount > OWNER_MAX ? `, above your owner's limit: offer again up to ${OWNER_MAX} or walk away.` : "."));
    }
    return result(lines.join("\n"), r);
  });
});

server.registerTool("respond_to_counter", {
  title: "Respond to counter",
  description:
    "Answer the seller's latest reply. 'accept' buys the item at the seller's standing price for you (their last counter, or the ask after a decline): " +
    "a new hold is placed on your card at that price and captured at once, and your old hold is released. 'walk_away' ends the negotiation and releases your hold (nothing charged). " +
    "(To counter with a different price instead, call make_offer again with the new amount.) " +
    `Will refuse to accept a price above your owner's limit of ${OWNER_MAX} USD. ` +
    "Add an optional `message` (≤280 chars) to tell the seller why, e.g. why you're walking away; the seller replies to it.",
  inputSchema: {
    id: z.string().describe("Item id"),
    action: z.enum(["accept", "walk_away"]),
    message: messageArg,
  },
}, async ({ id, action, message }) => guard(async () => {
  const b = await me();
  if (action === "accept") {
    // The market accepts at the seller's standing price for this buyer, which is the amount of the
    // seller's latest turn whatever its action (a counter, or the ask after a decline). Check that.
    const it = await api<Item>("GET", `/api/items/${encodeURIComponent(id)}`);
    const turns = it.negotiations?.[b.name] ?? [];
    const latest = [...turns].reverse().find((t) => t.from === "seller");
    if (latest && latest.amount > OWNER_MAX) return overMax(latest.amount, "accepting the seller's price of");
  }
  const r = await api<{ hold?: Hold; reply: Turn; item: Item }>("POST", `/api/items/${encodeURIComponent(id)}/respond`, { buyerId: b.id, action, ...(message ? { message } : {}) });
  const lines = [
    `>> Seller: ${r.reply.message}${r.reply.read?.length ? `\n   (the seller read your note as: ${r.reply.read.join(", ")})` : ""}`, "",
    (action === "accept" ? `You accepted the seller's price on ${r.item.name}` : `You walked away from ${r.item.name}`) + (message ? ` with the note "${message}".` : "."),
  ];
  if (r.hold) lines.push(holdLine(r.hold));
  if (r.item.status === "sold" && r.item.soldTo === b.name) {
    lines.push(`You own ${r.item.name}: charged ${usd(r.item.soldFor)}.`);
  }
  if (action === "walk_away") lines.push("Your held offer is released; nothing was charged.");
  return result(lines.join("\n"), r);
}));

server.registerTool("place_bid", {
  title: "Place proxy bid",
  description:
    "Place a proxy bid on an item sold by 'auction'. Your MAX is HELD on your card (authorized, not charged). If you win you are charged only the 2nd-highest max + 1 (at least the reserve) and the rest of the hold is released; " +
    "if you lose, the whole hold is released when the auction closes. Bids are binding until the auction closes (they cannot be reclaimed). So bid the most you are truly willing to pay: the proxy never exceeds it. " +
    `Your max must not exceed your owner's limit of ${OWNER_MAX} USD.`,
  inputSchema: {
    id: z.string().describe("Item id"),
    max: z.number().positive().describe(`Your maximum in USD (≤ ${OWNER_MAX})`),
  },
}, async ({ id, max }) => {
  if (max > OWNER_MAX) return overMax(max, "bidding");
  return guard(async () => {
    const b = await me();
    const r = await api<{ hold: Hold; item: Item }>("POST", `/api/items/${encodeURIComponent(id)}/bid`, { buyerId: b.id, max });
    const a = r.item.auction;
    const lines = [`Proxy bid placed on ${r.item.name} with max ${usd(max)}.`, holdLine(r.hold)];
    if (a) lines.push(`Auction: ${a.bids} bids, leader ${a.leader ?? "none"}${a.leader === b.name ? " (you!)" : ""}, reserve ${a.reserveMet ? "met" : "not met"}, ends ${a.endsAt}.`);
    lines.push("If you win you are charged the 2nd-highest max + 1 and the rest of the hold is released; if you lose, the whole hold is released.");
    return result(lines.join("\n"), r);
  });
});

server.registerTool("buy_now", {
  title: "Buy now",
  description:
    "Buy an item immediately at its buy-now price, or at the current price of a falling 'dutch' auction. Your card is authorized and charged (captured) in one step. " +
    "Fixed-price digital / physical items come with a refund guarantee: reclaim(hold_id) within the window gets the full amount back. " +
    `Refuses if the price is above your owner's limit of ${OWNER_MAX} USD (check get_item first; a dutch price keeps falling, so waiting can pay).`,
  inputSchema: { id: z.string().describe("Item id") },
}, async ({ id }) => guard(async () => {
  const b = await me();
  const it = await api<Item>("GET", `/api/items/${encodeURIComponent(id)}`);
  const price = it.price ?? it.ask;
  if (price > OWNER_MAX) return overMax(price, "buying at");
  const r = await api<{ hold: Hold; item: Item }>("POST", `/api/items/${encodeURIComponent(id)}/buy`, { buyerId: b.id });
  const lines = [`Bought ${r.item.name}.`, holdLine(r.hold)];
  if (r.hold.refundableUntil) lines.push(`Refund guarantee: reclaim("${r.hold.id}") before ${r.hold.refundableUntil} for your money back, no seller approval needed.`);
  return result(lines.join("\n"), r);
}));

server.registerTool("my_holds", {
  title: "My holds",
  description:
    "Show your card's available credit and every hold you have: HELD (authorized, not charged yet), CAPTURED (charged: you bought something), " +
    "RELEASED (authorization voided, never charged), REFUNDED (charged, then the money came back). Each hold carries its processor reference.",
  inputSchema: {},
}, async () => guard(async () => {
  const b = await me();
  const r = await api<Buyer & { holds: Hold[] }>("GET", `/api/buyers/${encodeURIComponent(b.id)}`);
  const held = r.holds.filter((h) => h.status === "held").reduce((s, h) => s + h.amount, 0);
  const lines = [
    `${r.name}, paying with ${r.card}`,
    `available credit: ${usd(r.balance)} | currently on hold: ${usd(held)} | owner limit: ${usd(OWNER_MAX)}`,
    r.holds.length ? r.holds.map(holdLine).join("\n") : "No holds yet.",
  ];
  return result(lines.join("\n"), r);
}));

server.registerTool("reclaim", {
  title: "Reclaim hold",
  description:
    "Take money back on one of your holds: withdraw a HELD offer you no longer want (the authorization is released, nothing charged), " +
    "or get a refund on a guarantee purchase (a fixed-price digital / physical item) before its refundableUntil time. " +
    "Auction bids cannot be reclaimed: they are binding until the auction closes.",
  inputSchema: { hold_id: z.string().describe("Hold id from my_holds") },
}, async ({ hold_id }) => guard(async () => {
  const b = await me();
  const r = await api<{ hold: Hold }>("POST", `/api/holds/${encodeURIComponent(hold_id)}/reclaim`, { buyerId: b.id });
  const what = r.hold.status === "refunded" ? "Refunded to your card" : "Hold released; nothing charged";
  return result(`${what}.\n${holdLine(r.hold)}`, r);
}));

server.registerPrompt("buy_for_me", {
  title: "Buy for me",
  description: "Have Claude bargain for an item on the Holdback market within a budget.",
  argsSchema: {
    item: z.string().describe("Item name or id, e.g. 'Monkey #3'"),
    budget: z.string().describe(`Most you will pay in USD (capped at the owner limit ${OWNER_MAX})`),
  },
}, ({ item, budget }) => {
  const cap = Math.min(Number(budget) || OWNER_MAX, OWNER_MAX);
  return {
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text:
`Buy "${item}" for me on the Holdback market. My budget is ${cap} USD — never commit more than that.
You may add a short, honest, polite message to your offers (e.g. that you're on a budget or a fan of the series); the seller agent reads it and replies.

How to do it:
1. list_items, find the item, then get_item to see how it is sold (the mechanism can change as other buyers watch).
2. If it is sold by OFFERS: open at about 60–65% of the ask. The seller counters with shrinking concessions, so raise in modest steps (roughly halfway between your last offer and their counter, but never above ${cap}). Accept with respond_to_counter once the counter is at or below what you would pay next, or after ~4 rounds if it is within budget. If the seller will not come within budget, walk_away (your hold is released).
3. If it is an AUCTION: place_bid once with max = ${cap}. You only pay the 2nd-highest max + 1.
4. If it is DUTCH: watch with get_item and buy_now once the price is comfortably within budget; if it is BUY-NOW, buy only if price ≤ ${cap}.
5. Every offer/bid is a hold on my card: authorized, not charged, and released if the deal does not clear. Narrate each step briefly (price, what is held/charged/released, the seller's reply), and finish with my_holds to show the final state.`,
      },
    }],
  };
});

await server.connect(new StdioServerTransport());
console.error(`[holdback-market] MCP server ready — market ${MARKET_URL}, buyer "${BUYER_NAME}", owner max ${OWNER_MAX}`);
