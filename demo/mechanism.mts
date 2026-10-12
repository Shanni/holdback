// The seller agent's brain: pick a sales mechanism from demand signals, and the
// pricing rules each mechanism needs. Pure functions, so they are easy to test and
// to swap for an LLM later (the reason string is what a model would explain).

export type Mechanism = "offers" | "auction" | "dutch" | "buy-now";

export type Signals = {
  watchers: number;       // agents that asked about the item
  offers: number;         // live offers
  secondsListed: number;
  urgent: boolean;        // seller wants a quick sale
  staleSecs?: number;     // no interest for this long → Dutch auction (default 20; <= 0 means never)
};

export type Goal = { floor: number; target: number };

export function chooseMechanism(s: Signals, g: Goal): { mechanism: Mechanism; reason: string } {
  const stale = s.staleSecs ?? 20;
  if (s.watchers >= 3) return { mechanism: "auction", reason: `${s.watchers} buyers interested → let them compete (proxy auction, winner pays 2nd price + increment)` };
  if (s.urgent && s.watchers >= 1) return { mechanism: "offers", reason: `quick sale wanted and ${s.watchers} buyer${s.watchers > 1 ? "s" : ""} interested → open to offers, conceding fast` };
  if (s.urgent) return { mechanism: "dutch", reason: "seller wants a quick sale → price falls until the first buyer takes it" };
  if (s.watchers >= 1) return { mechanism: "offers", reason: `only ${s.watchers} interested buyer${s.watchers > 1 ? "s" : ""} → open to offers, counter anything under ${g.target}` };
  if (stale > 0 && s.secondsListed > stale) return { mechanism: "dutch", reason: `no interest after ${Math.round(s.secondsListed)}s → price drops step by step toward the floor` };
  return { mechanism: "buy-now", reason: `fresh listing → fixed price ${g.target}, waiting to see demand` };
}

/** Counter-offer policy: accept at/above target, counter halfway in between, refuse below floor. */
export function respondToOffer(amount: number, g: Goal): { action: "accept" | "counter" | "decline"; counter?: number } {
  if (amount >= g.target) return { action: "accept" };
  if (amount < g.floor) return { action: "decline" };
  return { action: "counter", counter: Math.round((amount + g.target) / 2) };
}

/** Proxy (second-price) auction: highest max wins, pays max(2nd max + increment, reserve), capped at own max. */
export function settleAuction<T extends { max: number }>(bids: T[], reserve: number, increment: number) {
  const sorted = [...bids].sort((a, b) => b.max - a.max);
  const [winner, second] = sorted;
  if (!winner || winner.max < reserve) return { winner: undefined, price: 0, losers: sorted };
  const price = Math.min(winner.max, Math.max(reserve, (second?.max ?? reserve - increment) + increment));
  return { winner, price, losers: sorted.slice(1) };
}

/** Dutch auction: start high, drop `step` every `everySecs`, never below the floor. */
export function dutchPrice(start: number, floor: number, step: number, everySecs: number, elapsedSecs: number) {
  return Math.max(floor, start - step * Math.floor(elapsedSecs / everySecs));
}
