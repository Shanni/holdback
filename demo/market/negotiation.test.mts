import { test } from "node:test";
import assert from "node:assert/strict";
import { sellerReply, buyerNext } from "./negotiation.mts";

const base = { ask: 100, floor: 50, goal: "best-price" as const };

test("offer at or above ask is accepted at ask (excess refunded)", () => {
  assert.deepEqual(
    { a: sellerReply({ ...base, offer: 100, round: 1 }).action, p: sellerReply({ ...base, offer: 100, round: 1 }).amount },
    { a: "accept", p: 100 },
  );
  const r = sellerReply({ ...base, offer: 110, round: 1 });
  assert.equal(r.action, "accept");
  assert.equal(r.amount, 100);
  assert.match(r.message, /extra 10/);
});

test("below the floor: decline with a counter at ask", () => {
  const r = sellerReply({ ...base, offer: 45, round: 1 });
  assert.equal(r.action, "decline");
  assert.equal(r.amount, 100);
});

test("best-price concessions shrink round by round", () => {
  assert.equal(sellerReply({ ...base, offer: 55, round: 1 }).amount, 87); // 100 - 45*.3 = 86.5
  assert.equal(sellerReply({ ...base, offer: 58, round: 2, lastCounter: 87 }).amount, 79);
  assert.equal(sellerReply({ ...base, offer: 59, round: 3, lastCounter: 79 }).amount, 71);
  assert.equal(sellerReply({ ...base, offer: 60, round: 4, lastCounter: 71 }).amount, 66);
});

test("quick-sale concedes faster and meets the offer by round 4", () => {
  const q = { ...base, goal: "quick-sale" as const };
  assert.equal(sellerReply({ ...q, offer: 60, round: 1 }).amount, 80);
  assert.equal(sellerReply({ ...q, offer: 60, round: 2, lastCounter: 80 }).amount, 70);
  const r4 = sellerReply({ ...q, offer: 60, round: 4, lastCounter: 70 });
  assert.equal(r4.action, "accept");
  assert.equal(r4.amount, 60);
});

test("after 4 rounds: final offer at the midpoint, never below the floor, never above last counter", () => {
  const r = sellerReply({ ...base, offer: 60, round: 5, lastCounter: 66 });
  assert.equal(r.action, "counter");
  assert.equal(r.final, true);
  assert.equal(r.amount, 63);
  const low = sellerReply({ ask: 100, floor: 70, goal: "best-price", offer: 70, round: 6, lastCounter: 71 });
  assert.ok(low.amount >= 70 && low.amount <= 71);
});

test("counter never rises above a previous counter, and meeting the counter is an accept", () => {
  const r = sellerReply({ ...base, offer: 51, round: 1, lastCounter: 70 });
  assert.ok(r.amount <= 70);
  const met = sellerReply({ ...base, offer: 70, round: 3, lastCounter: 70 });
  assert.equal(met.action, "accept");
  assert.equal(met.amount, 70);
});

test("floor is respected by every counter", () => {
  for (let round = 1; round <= 8; round++) {
    const r = sellerReply({ ask: 100, floor: 70, goal: "quick-sale", offer: 70, round, lastCounter: 75 });
    assert.ok(r.amount >= 70);
  }
});

test("buyer opens at ~55% of ask, capped by max", () => {
  assert.deepEqual(buyerNext({ ask: 100, max: 60 }), { action: "offer", amount: 55, message: "Would you take 55 dUSDC?" });
  assert.equal((buyerNext({ ask: 100, max: 40 }) as any).amount, 40);
});

test("buyer concedes toward max, accepts a counter within max, walks away at max", () => {
  const m = buyerNext({ ask: 100, max: 60, lastOffer: 55, reply: { action: "counter", amount: 87 }, round: 1 });
  assert.equal(m.action, "offer");
  assert.equal((m as any).amount, 58);
  assert.equal(buyerNext({ ask: 100, max: 95, lastOffer: 80, reply: { action: "counter", amount: 90 }, round: 2 }).action, "accept");
  assert.equal(buyerNext({ ask: 100, max: 60, lastOffer: 60, reply: { action: "counter", amount: 66 }, round: 4 }).action, "walk_away");
  assert.equal(buyerNext({ ask: 100, max: 60, lastOffer: 60, reply: { action: "accept", amount: 60 }, round: 4 }).action, "done");
});

test("simulated Bo vs seller: four rounds, then walks away above his limit", () => {
  let lastOffer: number | undefined, reply: any, lastCounter: number | undefined;
  const trail: string[] = [];
  for (let round = 1; round <= 10; round++) {
    const move = buyerNext({ ask: 100, max: 60, lastOffer, reply, round: round - 1 });
    if (move.action !== "offer") { trail.push(move.action); break; }
    lastOffer = move.amount;
    reply = sellerReply({ ...base, offer: move.amount, round, lastCounter });
    if (reply.action === "counter") lastCounter = reply.amount;
    trail.push(`${move.amount}->${reply.action}:${reply.amount}`);
  }
  assert.deepEqual(trail, ["55->counter:87", "58->counter:79", "59->counter:71", "60->counter:66", "walk_away"]);
});

test("simulated fan (max 95) closes a deal against floor 70", () => {
  let lastOffer: number | undefined, reply: any, lastCounter: number | undefined, deal: number | undefined;
  const s = { ask: 100, floor: 70, goal: "best-price" as const };
  for (let round = 1; round <= 10 && deal === undefined; round++) {
    const move = buyerNext({ ask: 100, max: 95, lastOffer, reply, round: round - 1 });
    if (move.action === "accept") { deal = move.amount; break; }
    if (move.action !== "offer") break;
    lastOffer = move.amount;
    reply = sellerReply({ ...s, offer: move.amount, round, lastCounter });
    if (reply.action === "accept") deal = reply.amount;
    if (reply.action === "counter") lastCounter = reply.amount;
  }
  assert.ok(deal !== undefined && deal >= 70 && deal <= 95, `deal ${deal}`);
});

test("an offer within 3% of ask of the standing counter is accepted", () => {
  const r = sellerReply({ ask: 100, floor: 70, goal: "best-price", offer: 90, round: 4, lastCounter: 92 });
  assert.equal(r.action, "accept");
  assert.equal(r.amount, 90);
  assert.equal(sellerReply({ ask: 100, floor: 70, goal: "best-price", offer: 88, round: 3, lastCounter: 92 }).action, "counter");
});
