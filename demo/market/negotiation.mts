// Negotiation brains for the Holdback market. Pure functions, no chain, no I/O.
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
};

export type SellerReply = {
  action: "accept" | "counter" | "decline";
  amount: number;         // accept: the price captured; counter/decline: the price the seller asks
  final?: boolean;        // the take-it-or-leave-it offer after the concession rounds
  message: string;
};

export function sellerReply(i: SellerInput): SellerReply {
  const ask = i.ask;
  const standing = Math.min(ask, i.lastCounter ?? ask);
  if (i.offer >= standing) {
    const price = standing;
    const extra = i.offer - price;
    return {
      action: "accept",
      amount: price,
      message: `Deal at ${price} dUSDC.${extra > 0 ? ` You offered ${i.offer}; the extra ${extra} goes back to you.` : ""}`,
    };
  }
  if (i.offer < i.floor) {
    return {
      action: "decline",
      amount: ask,
      message: `${i.offer} is too low for me. Your hold is released. The asking price is ${ask}.`,
    };
  }
  // Close enough (within 3% of ask of the standing price): take it rather than haggle over crumbs.
  if (standing - i.offer <= Math.max(1, Math.round(ask * 0.03))) {
    return { action: "accept", amount: i.offer, message: `Close enough. Deal at ${i.offer} dUSDC.` };
  }
  const c = CONCESSIONS[i.goal];
  const round = Math.max(1, Math.floor(i.round));
  let amount: number;
  let final = false;
  if (round <= c.length) {
    amount = Math.max(i.floor, Math.round(ask - (ask - i.offer) * c[round - 1]));
  } else {
    final = true;
    amount = Math.max(i.floor, Math.round((i.offer + standing) / 2));
  }
  amount = Math.min(amount, standing);
  if (amount <= i.offer) {
    return { action: "accept", amount: i.offer, message: `You have a deal at ${i.offer} dUSDC.` };
  }
  const message = final
    ? `Final offer: ${amount} dUSDC. I can't go lower.`
    : i.goal === "quick-sale"
      ? `I'd like to sell this quickly. I can do ${amount} dUSDC.`
      : round === 1
        ? `It's worth more than ${i.offer}. I can do ${amount} dUSDC.`
        : `Meeting you partway: ${amount} dUSDC.`;
  return { action: "counter", amount, final: final || undefined, message };
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
    return { action: "offer", amount, message: `Would you take ${amount} dUSDC?` };
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
  return { action: "offer", amount, message: `I can stretch to ${amount} dUSDC.` };
}
