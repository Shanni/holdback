#!/usr/bin/env node
// Holdback Market MCP server (stdio). A thin HTTP client of the market server (demo/API.md).
// Run: node mcp/server.mts   (Node 22+ type stripping; no build step)
// Env: MARKET_URL (default http://localhost:4022), BUYER_NAME (default "Claude"), OWNER_MAX (default 90),
//      HOLDBACK_TOKEN (optional: reuse an existing buyer and its saved card instead of registering a new one)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MARKET_URL = (process.env.MARKET_URL || "http://localhost:4022").replace(/\/+$/, "");
const BUYER_NAME = process.env.BUYER_NAME || "Claude";
const OWNER_MAX = Number(process.env.OWNER_MAX || 90);
const ENV_TOKEN = process.env.HOLDBACK_TOKEN?.trim() || undefined;

type Hold = {
  id: string; itemId: string; buyer: string; kind: "offer" | "bid" | "buy";
  amount: number; captured?: number; refunded?: number;
  status: "held" | "captured" | "released" | "refunded";   // released: authorization voided, never charged
  ref: string;                // card processor reference (Stripe PaymentIntent id)
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
type Me = {
  id: string; name: string; kind: string;
  max?: number;        // owner's limit, enforced by the market on every hold
  hasCard: boolean;
  card?: string;       // e.g. "Visa •••• 4242"
  holds: Hold[];
};
type CardSetup = { code: string; setupUrl: string; expiresInSecs: number };
type Config = { provider: { id: string; name: string; mode: "test" | "live" } };

// ---------- HTTP ----------
class MarketError extends Error {
  status: number;
  data: any;
  constructor(message: string, status = 0, data: any = {}) { super(message); this.status = status; this.data = data; }
}

let token: string | undefined = ENV_TOKEN;

async function api<T>(method: "GET" | "POST", path: string, body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth && token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(MARKET_URL + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new MarketError(`Cannot reach the Holdback market at ${MARKET_URL} (${(e as Error).message}). Is the market server running?`);
  }
  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) {
    if (res.status === 401 && auth && token) {
      if (token === ENV_TOKEN) {
        throw new MarketError(`Market refused (401): the HOLDBACK_TOKEN buyer token is not known to the market at ${MARKET_URL}. ` +
          "Unset HOLDBACK_TOKEN to register a new buyer, or set it to a token this market issued.", 401, data);
      }
      // Our own registration is gone (e.g. the market's data was reset): register again on the next call.
      buyer = null; registering = null; token = undefined;
      throw new MarketError("Market refused (401): this buyer is no longer known to the market. A new buyer will be registered on the next call (it will need a card again).", 401, data);
    }
    throw new MarketError(`Market refused (${res.status}): ${data?.error ?? text}`, res.status, data);
  }
  return data as T;
}

/** The buyer this server acts for: HOLDBACK_TOKEN's buyer, or one registered on first use (token kept in memory). */
let buyer: Me | null = null;
let registering: Promise<Me> | null = null;
async function me(): Promise<Me> {
  if (buyer) return buyer;
  if (!registering) {
    registering = (async () => {
      if (token) return (buyer = await api<Me>("GET", "/api/me"));
      let r: Me & { token: string };
      try {
        r = await api<Me & { token: string }>("POST", "/api/buyers", { name: BUYER_NAME, kind: "mcp", max: OWNER_MAX }, false);
      } catch (e) {
        if (e instanceof MarketError) throw new MarketError(`Could not register as a buyer on the market. ${e.message}`, e.status, e.data);
        throw e;
      }
      const { token: t, ...b } = r;
      token = t;
      console.error(`[holdback-market] registered buyer "${b.name}" (${b.id}). To keep this buyer and its card across restarts, set HOLDBACK_TOKEN=${t}`);
      return (buyer = b);
    })().catch((e) => { registering = null; throw e; });
  }
  return registering;
}

/** The buyer as the market sees it right now (card saved since the last call?). */
async function fresh(): Promise<Me> {
  await me();
  return (buyer = await api<Me>("GET", "/api/me"));
}

let config: Config | null = null;
async function marketMode(): Promise<"test" | "live" | undefined> {
  try { return (config ??= await api<Config>("GET", "/api/config", undefined, false)).provider.mode; } catch { return undefined; }
}

/** A fresh card-setup link for the owner, with instructions. */
async function cardSetupText(): Promise<{ text: string; setup: CardSetup }> {
  const setup = await api<CardSetup>("POST", "/api/me/card-setup");
  const mins = Math.round(setup.expiresInSecs / 60);
  const mode = await marketMode();
  const lines = [
    `Ask your owner (the human you are buying for) to open this link in a browser and save a card:`,
    `  ${setup.setupUrl}`,
    `The link is valid for ${mins} minutes. Saving the card charges nothing: offers and bids are only authorized (held) on it, and money is captured only when a deal clears.`,
    `Card setup is the owner's action: do not try to enter card details yourself. Once they say it is saved, retry.`,
  ];
  if (mode === "test") lines.push("This market runs in Stripe TEST mode: the owner can use the test card 4242 4242 4242 4242 with any future expiry date and any CVC. No real money moves.");
  return { text: lines.join("\n"), setup };
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
    if (e instanceof MarketError) {
      if (e.status === 402 && e.data?.needsCard) return needsCard();
      if (e.status === 402) {
        return fail(`${e.message}\nThe card on file could not be authorized for this hold. If your owner wants to use a different card, call add_card and give them the link.`);
      }
      return fail(e.message);
    }
    return fail(`Unexpected error: ${(e as Error).message}`);
  }
}

/** The market refused a hold because this buyer has no card: hand back a fresh setup link for the owner. */
async function needsCard() {
  let how: string;
  try { how = (await cardSetupText()).text; } catch (e) {
    how = `Could not create a card-setup link (${(e as Error).message}). Call add_card to try again.`;
  }
  return fail(`A card is needed: your owner has not saved a card for you yet, so the market cannot place this hold (nothing was held or charged).\n${how}`);
}

/** The price the market would actually take on a buy (server.mts `buy`). */
function buyPrice(it: Item): number {
  if (it.kind !== "unique") return it.ask;
  if (it.mechanism === "dutch") return it.price ?? it.ask;
  if (it.mechanism === "offers") return it.ask;
  return it.price ?? it.ask;
}

// ---------- server ----------
const server = new McpServer(
  { name: "holdback-market", version: "0.2.0" },
  {
    instructions:
      `Holdback is a market where every offer, bid and purchase is a HOLD on your owner's card (a card authorization, in USD). ` +
      `The amount is reserved on the card but not charged. If the deal clears the hold is CAPTURED (the card is charged the deal price, and any excess is released); ` +
      `if not, it is RELEASED (the authorization is voided and nothing is charged). Fixed-price items are charged at once and refundable within their guarantee window. ` +
      `A card is needed before any offer, bid or purchase: if there is none, call add_card and give your owner the link so they can save one in their browser (you never enter card details yourself). ` +
      `You buy on behalf of an owner whose hard spending limit is ${OWNER_MAX} USD: never offer, bid or pay more than that. ` +
      `Start with list_items, then get_item to see how an item is sold and the negotiation so far.`,
  },
);

server.registerTool("list_items", {
  title: "List items",
  description:
    "List every item on the Holdback market with its kind (unique / digital / physical), sale mechanism (offers / auction / dutch / buy-now), ask price and status. " +
    `Start here. Also says whether your owner has saved a card yet (needed before any offer, bid or purchase). Your owner's spending limit is ${OWNER_MAX} USD.`,
  inputSchema: {},
}, async () => guard(async () => {
  const items = await api<Item[]>("GET", "/api/items", undefined, false);
  let cardNote: string;
  try {
    const b = await fresh();
    cardNote = b.hasCard ? `Paying as ${b.name}${b.card ? ` with ${b.card}` : ""}.` : `${b.name} has no card yet: call add_card before making an offer, bid or purchase.`;
  } catch (e) {
    cardNote = `Note: ${(e as Error).message}`;
  }
  const text = items.map((it) =>
    `- ${it.name} [${it.id}]: ${it.status}, ${it.kind}, ${it.mechanism}, ask ${usd(it.ask)}${it.price !== undefined ? `, price ${usd(it.price)}` : ""}`).join("\n");
  return result(`${items.length} items on the market (your limit: ${usd(OWNER_MAX)}):\n${text}\n${cardNote}`,
    items.map(({ negotiations, holds, ...rest }) => rest));
}));

server.registerTool("get_item", {
  title: "Get item",
  description:
    "Look at one item in detail: mechanism, the seller's reason for it, ask price, auction state, and your negotiation history with the seller. " +
    "Viewing registers you as a watcher — the seller agent may switch the sale mechanism when demand rises (e.g. offers → auction), so re-check before acting.",
  inputSchema: { id: z.string().describe("Item id from list_items") },
}, async ({ id }) => guard(async () => {
  const b = await fresh();
  const it = await api<Item>("GET", `/api/items/${encodeURIComponent(id)}`);
  const mine = (it.holds ?? []).filter((h) => h.buyer === b.name);
  const text = [
    itemSummary(it),
    howToBuy(it),
    lastTurns(it, b.name),
    mine.length ? "Your holds on this item:\n" + mine.map(holdLine).join("\n") : "",
    b.hasCard ? "" : "You have no card yet: call add_card first (your owner saves the card in a browser).",
  ].filter(Boolean).join("\n");
  return result(text, it);
}));

server.registerTool("add_card", {
  title: "Add card",
  description:
    "Get a link for your OWNER (the human you buy for) to save a payment card in their browser. Every offer, bid and purchase is a hold on that card, so one is needed before you can buy. " +
    "Returns a setup URL (valid about 30 minutes): give it to your owner and ask them to open it and save a card, then retry. Saving a card charges nothing; money is only captured when a deal clears. " +
    "Never ask for or type card numbers yourself. Also use this if your owner wants to replace the current card.",
  inputSchema: {},
}, async () => guard(async () => {
  const b = await fresh();
  const { text, setup } = await cardSetupText();
  const current = b.hasCard ? `${b.name} already has a card (${b.card ?? "saved"}); saving another replaces it.` : `${b.name} has no card yet.`;
  return result(`${current}\n${text}`, setup);
}));

server.registerTool("make_offer", {
  title: "Make offer",
  description:
    "Offer a price on a unique item sold by 'offers'. The amount is HELD on your owner's card (authorized, not charged) the moment you offer; needs a saved card (see add_card). " +
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
    await me();
    const r = await api<{ hold: Hold; reply: Turn; item: Item }>("POST", `/api/items/${encodeURIComponent(id)}/offer`, { amount, ...(message ? { message } : {}) });
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
    "a new hold is placed on your owner's card at that price and captured at once, and your old hold is released. 'walk_away' ends the negotiation and releases your hold (nothing charged). " +
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
    const it = await api<Item>("GET", `/api/items/${encodeURIComponent(id)}`, undefined, false);
    const turns = it.negotiations?.[b.name] ?? [];
    const latest = [...turns].reverse().find((t) => t.from === "seller");
    if (latest && latest.amount > OWNER_MAX) return overMax(latest.amount, "accepting the seller's price of");
  }
  const r = await api<{ hold?: Hold; reply: Turn; item: Item }>("POST", `/api/items/${encodeURIComponent(id)}/respond`, { action, ...(message ? { message } : {}) });
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
    "Place a proxy bid on an item sold by 'auction'. Your MAX is HELD on your owner's card (authorized, not charged); needs a saved card (see add_card). If you win you are charged only the 2nd-highest max + 1 (at least the reserve) and the rest of the hold is released; " +
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
    const r = await api<{ hold: Hold; item: Item }>("POST", `/api/items/${encodeURIComponent(id)}/bid`, { max });
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
    "Buy an item immediately at its buy-now price, or at the current price of a falling 'dutch' auction. Your owner's card is authorized and charged (captured) in one step; needs a saved card (see add_card). " +
    "Fixed-price digital / physical items come with a refund guarantee: reclaim(hold_id) within the window gets the full amount back. " +
    `Refuses if the price is above your owner's limit of ${OWNER_MAX} USD (check get_item first; a dutch price keeps falling, so waiting can pay).`,
  inputSchema: { id: z.string().describe("Item id") },
}, async ({ id }) => guard(async () => {
  await me();
  const it = await api<Item>("GET", `/api/items/${encodeURIComponent(id)}`, undefined, false);
  const price = buyPrice(it);
  if (price > OWNER_MAX) return overMax(price, "buying at");
  const r = await api<{ hold: Hold; item: Item }>("POST", `/api/items/${encodeURIComponent(id)}/buy`);
  const lines = [`Bought ${r.item.name}.`, holdLine(r.hold)];
  if (r.hold.refundableUntil) lines.push(`Refund guarantee: reclaim("${r.hold.id}") before ${r.hold.refundableUntil} for your money back, no seller approval needed.`);
  return result(lines.join("\n"), r);
}));

server.registerTool("my_holds", {
  title: "My holds",
  description:
    "Show the card your owner saved (or that there is none yet) and every hold you have: HELD (authorized, not charged yet), CAPTURED (charged: you bought something), " +
    "RELEASED (authorization voided, never charged), REFUNDED (charged, then the money came back). Each hold carries its processor reference.",
  inputSchema: {},
}, async () => guard(async () => {
  const r = await fresh();
  const held = r.holds.filter((h) => h.status === "held").reduce((s, h) => s + h.amount, 0);
  const limit = r.max !== undefined && r.max !== OWNER_MAX ? `owner limit: ${usd(Math.min(r.max, OWNER_MAX))} (market: ${usd(r.max)}, OWNER_MAX: ${usd(OWNER_MAX)})` : `owner limit: ${usd(OWNER_MAX)}`;
  const lines = [
    r.hasCard ? `${r.name}, paying with ${r.card ?? "a saved card"}` : `${r.name}: no card yet. Call add_card and give your owner the link to save one.`,
    `currently on hold: ${usd(held)} | ${limit}`,
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
  await me();
  const r = await api<{ hold: Hold }>("POST", `/api/holds/${encodeURIComponent(hold_id)}/reclaim`);
  const what = r.hold.status === "refunded" ? "Refunded to your card" : "Hold released; nothing charged";
  return result(`${what}.\n${holdLine(r.hold)}`, r);
}));

server.registerPrompt("buy_for_me", {
  title: "Buy for me",
  description: "Have Claude bargain for an item on the Holdback market within a budget (needs a card saved by the owner).",
  argsSchema: {
    item: z.string().describe("Item name or id, e.g. 'Blue vase'"),
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
2. You need a card on file before any offer, bid or purchase. If list_items says there is no card, or a tool answers that a card is needed, call add_card, give me the link, and wait until I tell you I've saved a card. Never ask me for card numbers in chat.
3. If it is sold by OFFERS: open at about 60–65% of the ask. The seller counters with shrinking concessions, so raise in modest steps (roughly halfway between your last offer and their counter, but never above ${cap}). Accept with respond_to_counter once the counter is at or below what you would pay next, or after ~4 rounds if it is within budget. If the seller will not come within budget, walk_away (your hold is released).
4. If it is an AUCTION: place_bid once with max = ${cap}. You only pay the 2nd-highest max + 1.
5. If it is DUTCH: watch with get_item and buy_now once the price is comfortably within budget; if it is BUY-NOW, buy only if price ≤ ${cap}.
6. Every offer/bid is a hold on my card: authorized, not charged, and released if the deal does not clear. Narrate each step briefly (price, what is held/charged/released, the seller's reply), and finish with my_holds to show the final state.`,
      },
    }],
  };
});

await server.connect(new StdioServerTransport());
console.error(`[holdback-market] MCP server ready — market ${MARKET_URL}, ${ENV_TOKEN ? "buyer from HOLDBACK_TOKEN" : `buyer "${BUYER_NAME}" (registered on first use)`}, owner max ${OWNER_MAX}`);
