// Negotiation brains for the Holdback market. Pure functions, no I/O.
//
// Seller (server-side, floor hidden from buyers), per demo/API.md:
//   offer >= ask (or >= the seller's last counter) -> accept
//   offer <  floor -> decline (hold refunded), counter at ask
//   otherwise counter; round n counter = max(floor, ask - (ask - offer) * c[n]),
//     c = [0.3, 0.5, 0.7, 0.85] (best-price) or [0.5, 0.75, 0.9, 1] (quick-sale);
//   after 4 rounds: final offer = max(floor, midpoint of the offer and the last counter).
// Counters never go back up, and a counter at or below the offer becomes an accept.
// An offer within 3% of ask of the standing price is accepted ("close enough").
//
// Buyer agent: open at ~55% of ask, concede half the way toward the owner's max each
// round, accept a counter at or under max, walk away when already at max.

export type Goal = "best-price" | "quick-sale";

export const CONCESSIONS: Record<Goal, number[]> = {
  "best-price": [0.3, 0.5, 0.7, 0.85],
  "quick-sale": [0.5, 0.75, 0.9, 1],
};

export type SellerInput = {
  offer: number;
  ask: number;
  floor: number;
  goal: Goal;
  round: number;          // 1-based: how many offers this buyer has made on this item, including this one
  lastCounter?: number;   // seller's previous counter to this buyer, if any
  message?: string;       // the buyer's free-text note with this offer (optional)
  item?: ItemFacts;       // what the seller can say about the piece when asked
};

export type SellerReply = {
  action: "accept" | "counter" | "decline";
  amount: number;         // accept: the price captured; counter/decline: the price the seller asks
  final?: boolean;        // the take-it-or-leave-it offer after the concession rounds
  message: string;
  read?: Intent[];        // what the seller picked up from the buyer's message
};

// ------------------------------------------------------------------ reading buyer messages
// Local, rule-based (no LLM, no network). Effects stay inside the hidden floor:
//   hardship   -> concedes a bit faster this round (+0.15 on the concession factor)
//   enthusiasm -> holds firmer (-0.1)
//   rude       -> no concession this round (counter stays at the standing price)
//   question   -> the reply answers with item facts
//   bundle / first_purchase -> tone only
export type Intent = "hardship" | "enthusiasm" | "bundle" | "first_purchase" | "rude" | "question";
export type ItemFacts = { name: string; kind?: "unique" | "digital" | "physical"; guarantee?: string };
export type MessageRead = { intents: Intent[]; terms: Partial<Record<Intent, string>> };

const RULES: [Intent, RegExp][] = [
  ["rude", /\b(stupid|idiots?|dumb|morons?|scam\w*|rip-?off|ripoff|greedy|garbage|trash|crap\w*|ugly|clowns?|shut up|ridiculous|absurd|insane|a joke|lame|wtf|f+u+c+k\w*|shit\w*|screw you|go to hell|loser)\b/],
  ["hardship", /\b(students?|budget|broke|can'?t afford|cannot afford|can not afford|unemployed|tuition|money'?s tight|tight on (?:money|cash)|low on (?:cash|funds|money))\b/],
  ["enthusiasm", /\b(collectors?|collecting|huge fan|big fan|fan|fans|love (?:this|it|that|the|your|these)|loving|obsessed|adore|favou?rite)\b/],
  ["bundle", /\b(bundle|both|two|pair|package deal|multiple)\b/],
  ["first_purchase", /\b(first|new|newbie|beginner)\b/],
  ["question", /\b(who (?:made|created|drew|painted|minted|designed)|artist|creator|editions?|rare|rarity|unique|one of a kind|1\/1|how many|provenance|authentic\w*|escrow|guarantee\w*|refund\w*)\b/],
];

/** Pure intent detector for a buyer's free-text message. */
export function readMessage(text: string | undefined | null): MessageRead {
  const t = String(text ?? "").toLowerCase().replace(/[\u2018\u2019]/g, "'").slice(0, 280);
  const intents: Intent[] = [];
  const terms: MessageRead["terms"] = {};
  for (const [intent, re] of RULES) {
    const m = t.match(re);
    if (m) { intents.push(intent); terms[intent] = m[1]; }
  }
  return { intents, terms };
}

const ORDER: Intent[] = ["rude", "question", "hardship", "enthusiasm", "bundle", "first_purchase"];
type Ctx = "counter" | "accept" | "decline" | "walk_away";

function seedOf(s: string) {
  let h = 7;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}
const pick = <T,>(xs: T[], seed: number) => xs[seed % xs.length];

function factLine(item: ItemFacts | undefined, term: string | undefined) {
  const name = item?.name ?? "this piece";
  const digital = item?.kind === "digital";
  const edition = digital ? `${name} is a digital download` : `${name} is a 1/1, the only edition there is`;
  const howPaid = digital ? "you're only charged once it's delivered" : "your card is only authorized until we agree, then charged the agreed price";
  const g = item?.guarantee ? ` and it comes with a ${item.guarantee} money-back guarantee` : "";
  const t = term ?? "";
  if (/who|artist|creator/.test(t)) return `Good question: ${name} is from the gallery's own monkey series, ${digital ? "a digital download" : "a 1/1"}, and ${howPaid}${g}.`;
  if (/escrow|refund|authentic|provenance/.test(t)) return `On that: ${howPaid}, and ${digital ? `${name} is a digital download` : `${name} is a 1/1`}${g}.`;
  if (/guarantee/.test(t)) return item?.guarantee ? `${name} has a ${item.guarantee} money-back guarantee, and ${howPaid}.` : `No guarantee on ${name}, but ${howPaid}, and if we don't agree your hold comes straight back.`;
  return `You asked about rarity: ${edition}, and ${howPaid}${g}.`;
}

function hardshipPhrase(term: string | undefined) {
  if (term && /student|tuition/.test(term)) return "being a student";
  if (term && /afford|broke|tight|low on|unemployed/.test(term)) return "money being tight";
  return "your budget";
}

/** One conversational sentence that answers what the buyer said, or undefined if nothing stood out. */
function ack(read: MessageRead, ctx: Ctx, item: ItemFacts | undefined, seed: number): string | undefined {
  const top = ORDER.find((i) => read.intents.includes(i));
  if (!top) return undefined;
  const term = read.terms[top];
  const name = item?.name ?? "this piece";
  switch (top) {
    case "rude":
      return pick(ctx === "counter"
        ? ["Let's keep it civil; insults don't move my price.", "I'll skip the tone, but it costs you this round's concession.", "Calling it that won't get you a discount."]
        : ctx === "accept" ? ["No hard feelings.", "Fair enough, tone aside."] : ["Let's keep it civil.", "I'll let the tone slide."], seed);
    case "question":
      return factLine(item, term);
    case "hardship": {
      const p = hardshipPhrase(term);
      return pick(ctx === "counter"
        ? [`I hear you on ${p}, so I'll bend a bit more than usual this round.`, `Since you mentioned ${p}, I'm moving further than I normally would.`, `Fair enough about ${p}, so I'll meet you a little more this time.`]
        : ctx === "accept" ? [`Glad it worked out despite ${p}.`, `Happy to make it work with ${p}.`]
        : ctx === "decline" ? [`I hear you on ${p}, but that's lower than I can go.`, `I'm sorry about ${p}; I just can't sell that low.`]
        : [`Understood, ${p} comes first.`, `No worries, I get ${p}.`], seed);
    }
    case "enthusiasm": {
      const who = term && /collect/.test(term) ? "a collector" : "a real fan";
      return pick(ctx === "counter"
        ? [`Always good to hear from ${who}, and it's exactly why I'm holding near my price.`, `I can tell you love ${name}; so do I, which is why I won't move much.`, `Good to know you're ${who}: pieces like this keep their value, so I'm staying firm.`]
        : ctx === "accept" ? [`Glad ${name} is going to ${who}.`, `Nice to see it go to ${who}.`]
        : ctx === "decline" ? [`Thanks for the kind words, but that's too low even for ${who}.`]
        : [`Sorry to lose ${who}.`, `Shame, it would've suited ${who}.`], seed);
    }
    case "bundle":
      return pick(ctx === "accept"
        ? ["On the bundle: each piece clears on its own hold, so this one's done and the others are priced separately."]
        : ["On a bundle: each piece settles on its own hold, so I price them one at a time.", "No bundles from me, since every piece clears on its own hold, but I can work on this one."], seed);
    case "first_purchase":
      return pick(ctx === "accept"
        ? ["Congrats on the first purchase.", "Welcome aboard, nice first buy."]
        : ["Welcome! If we don't agree, your hold comes straight back.", "First time here? Nothing is charged unless we agree."], seed);
  }
}

/** Seller's reply text when the buyer accepts a counter or walks away (server respond handler). */
export function sellerNote(message: string | undefined, ctx: "accept" | "walk_away", amount: number, item?: ItemFacts): { message: string; read: Intent[] } {
  const read = readMessage(message);
  const a = ack(read, ctx, item, seedOf(String(message ?? "")));
  const base = ctx === "accept" ? `Deal at ${amount} USD. It's yours.` : `No problem. ${amount} USD stands if you change your mind.`;
  if (!a) return { message: base, read: read.intents };
  return { message: ctx === "accept" ? `${a} Deal at ${amount} USD, it's yours.` : `${a} ${amount} USD stands if you change your mind.`, read: read.intents };
}

export function sellerReply(i: SellerInput): SellerReply {
  const ask = i.ask;
  const standing = Math.min(ask, i.lastCounter ?? ask);
  const read = readMessage(i.message);
  const seed = seedOf(`${i.message ?? ""}|${i.round}`);
  const say = (ctx: Ctx, plain: string, withAck: string) => {
    const a = ack(read, ctx, i.item, seed);
    return a ? `${a} ${withAck}` : plain;
  };
  const tag = read.intents.length ? { read: read.intents } : {};
  if (i.offer >= standing) {
    const price = standing;
    const extra = i.offer - price;
    const back = extra > 0 ? ` You offered ${i.offer}; the extra ${extra} goes back to you.` : "";
    return { action: "accept", amount: price, message: say("accept", `Deal at ${price} USD.${back}`, `Deal at ${price} USD.${back}`), ...tag };
  }
  if (i.offer < i.floor) {
    return {
      action: "decline",
      amount: ask,
      message: say("decline", `${i.offer} is too low for me. Your hold is released. The asking price is ${ask}.`,
        `${i.offer} doesn't work, so your hold is released; the asking price is ${ask} USD.`),
      ...tag,
    };
  }
  // Close enough (within 3% of ask of the standing price): take it rather than haggle over crumbs.
  if (standing - i.offer <= Math.max(1, Math.round(ask * 0.03))) {
    return { action: "accept", amount: i.offer, message: say("accept", `Close enough. Deal at ${i.offer} USD.`, `Close enough: deal at ${i.offer} USD.`), ...tag };
  }
  const c = CONCESSIONS[i.goal];
  const round = Math.max(1, Math.floor(i.round));
  const rude = read.intents.includes("rude");
  let amount: number;
  let final = false;
  if (rude) {
    amount = standing; // no concession this round
  } else if (round <= c.length) {
    let f = c[round - 1];
    if (read.intents.includes("hardship")) f += 0.15;
    if (read.intents.includes("enthusiasm")) f -= 0.1;
    f = Math.min(1, Math.max(0.05, f));
    amount = Math.max(i.floor, Math.round(ask - (ask - i.offer) * f));
  } else {
    final = true;
    amount = Math.max(i.floor, Math.round((i.offer + standing) / 2));
  }
  amount = Math.min(amount, standing);
  if (amount <= i.offer) {
    return { action: "accept", amount: i.offer, message: say("accept", `You have a deal at ${i.offer} USD.`, `You have a deal at ${i.offer} USD.`), ...tag };
  }
  const plain = final
    ? `Final offer: ${amount} USD. I can't go lower.`
    : i.goal === "quick-sale"
      ? `I'd like to sell this quickly. I can do ${amount} USD.`
      : round === 1
        ? `It's worth more than ${i.offer}. I can do ${amount} USD.`
        : `Meeting you partway: ${amount} USD.`;
  const num = final
    ? `Final offer: ${amount} USD.`
    : rude
      ? `It stays at ${amount} USD.`
      : pick([`I can do ${amount} USD.`, `My counter is ${amount} USD.`, `How about ${amount} USD?`], seed >>> 3);
  return { action: "counter", amount, final: final || undefined, message: say("counter", plain, num), ...tag };
}

export type BuyerInput = {
  ask: number;
  max: number;                 // owner's spending limit
  lastOffer?: number;          // our previous offer on this item
  reply?: { action: "accept" | "counter" | "decline"; amount: number }; // seller's last reply
  round?: number;              // offers made so far
  maxRounds?: number;          // give up after this many offers (default 6)
  open?: number;               // opening fraction of ask (default 0.55)
};

export type BuyerMove =
  | { action: "offer"; amount: number; message: string }
  | { action: "accept"; amount: number; message: string }
  | { action: "walk_away"; message: string }
  | { action: "done"; message: string };

export function buyerNext(i: BuyerInput): BuyerMove {
  const open = i.open ?? 0.55;
  if (i.lastOffer === undefined || !i.reply) {
    const amount = Math.max(1, Math.min(i.max, Math.round(i.ask * open)));
    return { action: "offer", amount, message: `Would you take ${amount} USD?` };
  }
  if (i.reply.action === "accept") return { action: "done", message: "Deal." };
  if (i.reply.amount <= i.max) {
    return { action: "accept", amount: i.reply.amount, message: `${i.reply.amount} works for me. Deal.` };
  }
  if (i.lastOffer >= i.max || (i.round ?? 0) >= (i.maxRounds ?? 6)) {
    return { action: "walk_away", message: `${i.reply.amount} is above my owner's limit. I'll pass.` };
  }
  const step = Math.max(1, Math.ceil((i.max - i.lastOffer) / 2));
  const amount = Math.min(i.max, i.reply.amount - 1, i.lastOffer + step);
  return { action: "offer", amount, message: `I can stretch to ${amount} USD.` };
}
