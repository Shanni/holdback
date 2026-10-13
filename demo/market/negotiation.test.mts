import { test } from "node:test";
import assert from "node:assert/strict";
import { sellerReply, buyerNext, readMessage, sellerNote } from "./negotiation.mts";

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

// ------------------------------------------------------------------ buyer messages
const intents = (t: string) => readMessage(t).intents;

test("readMessage: detects hardship, enthusiasm, bundle, first purchase, rude, question", () => {
  assert.deepEqual(intents("I'm a student — any flexibility?"), ["hardship"]);
  assert.deepEqual(intents("Honestly I can’t afford the ask"), ["hardship"]);
  assert.deepEqual(intents("on a tight budget"), ["hardship"]);
  assert.deepEqual(intents("Huge fan of this series!"), ["enthusiasm"]);
  assert.deepEqual(intents("I'm a collector"), ["enthusiasm"]);
  assert.deepEqual(intents("I love this one"), ["enthusiasm"]);
  assert.deepEqual(intents("Would you do a bundle?"), ["bundle"]);
  assert.deepEqual(intents("I'd take both"), ["bundle"]);
  assert.deepEqual(intents("This is my first NFT"), ["first_purchase"]);
  assert.deepEqual(intents("I'm new here"), ["first_purchase"]);
  assert.deepEqual(intents("this price is a ripoff, idiot"), ["rude"]);
  assert.deepEqual(intents("Who made this?"), ["question"]);
  assert.deepEqual(intents("What edition is it? Is it rare?"), ["question"]);
  assert.deepEqual(intents("Student here, huge fan"), ["hardship", "enthusiasm"]);
});

test("readMessage: neutral text, empty input and the scripted agents' lines detect nothing", () => {
  for (const t of ["", "hello", "Would you take 55 dUSDC?", "I can stretch to 58 dUSDC.", "60 works for me. Deal.", "66 is above my owner's limit. I'll pass.", "fantastic", "defend"])
    assert.deepEqual(intents(t), [], t);
  assert.deepEqual(readMessage(undefined).intents, []);
});

const m3 = { ask: 100, floor: 60, goal: "best-price" as const, item: { name: "Monkey #3", kind: "nft" as const } };

test("hardship concedes a little faster; enthusiasm holds firmer; rude gets no concession", () => {
  const plain = sellerReply({ ...m3, offer: 70, round: 1 }).amount;                                      // 91
  const hard = sellerReply({ ...m3, offer: 70, round: 1, message: "I'm a student — any flexibility?" });
  const fan = sellerReply({ ...m3, offer: 70, round: 1, message: "Huge fan of this series!" });
  const rude = sellerReply({ ...m3, offer: 70, round: 2, lastCounter: 91, message: "you greedy clown" });
  assert.equal(plain, 91);
  assert.ok(hard.amount < plain && hard.amount >= m3.floor, `hardship ${hard.amount}`);
  assert.ok(fan.amount > plain, `enthusiasm ${fan.amount}`);
  assert.equal(rude.action, "counter");
  assert.equal(rude.amount, 91);
  assert.deepEqual(hard.read, ["hardship"]);
});

test("replies reference the message and still state the number", () => {
  const hard = sellerReply({ ...m3, offer: 70, round: 1, message: "I'm a student" });
  assert.match(hard.message, /student/);
  assert.ok(hard.message.includes(`${hard.amount} dUSDC`));
  const q = sellerReply({ ...m3, offer: 70, round: 1, message: "Who made this? Is it rare?" });
  assert.match(q.message, /Monkey #3/);
  assert.match(q.message, /1\/1/);
  assert.match(q.message, /escrow/);
  assert.ok(q.message.includes(`${q.amount} dUSDC`));
  const g = sellerReply({ ...m3, item: { name: "Print", kind: "digital", guarantee: "7 days" }, offer: 70, round: 1, message: "is there a guarantee?" });
  assert.match(g.message, /7 days money-back guarantee/);
  const dec = sellerReply({ ...m3, offer: 40, round: 1, message: "I'm broke" });
  assert.equal(dec.action, "decline");
  assert.match(dec.message, /money being tight/);
  assert.match(dec.message, /100 dUSDC/);
  const acc = sellerReply({ ...m3, offer: 100, round: 1, message: "Huge fan!" });
  assert.equal(acc.action, "accept");
  assert.match(acc.message, /fan.*Deal at 100 dUSDC/);
  // sentence count stays small (1–2 sentences, the fact line is one sentence)
  for (const r of [hard, q, dec, acc]) assert.ok(r.message.split(/(?<=[.?!])\s+/).length <= 3, r.message);
});

test("templates vary across messages", () => {
  const msgs = ["I'm a student", "student budget here", "As a student I can't stretch", "student, sorry", "I'm on a student loan"];
  const texts = new Set(msgs.map((message) => sellerReply({ ...m3, offer: 70, round: 1, message }).message.replace(/\d+ dUSDC.*/, "")));
  assert.ok(texts.size >= 2, [...texts].join(" | "));
});

test("no message, or nothing recognised: replies are unchanged", () => {
  const a = sellerReply({ ...m3, offer: 70, round: 1 });
  const b = sellerReply({ ...m3, offer: 70, round: 1, message: "I can stretch to 70 dUSDC." });
  assert.deepEqual(a, b);
  assert.equal(a.read, undefined);
});

test("messages never push any price below the floor (exhaustive sweep)", () => {
  const messages = [undefined, "I'm a student, can't afford it, broke", "Huge fan, collector", "idiot", "bundle both", "first", "who made it? rare?", "student but also a huge fan", "student idiot"];
  for (const goal of ["best-price", "quick-sale"] as const)
    for (const floor of [40, 60, 70, 95])
      for (let offer = floor; offer <= 100; offer += 1)
        for (let round = 1; round <= 6; round++)
          for (const lastCounter of [undefined, floor, Math.min(100, floor + 5), 99])
            for (const message of messages) {
              const r = sellerReply({ ask: 100, floor, goal, offer, round, lastCounter, message });
              assert.ok(r.amount >= floor, `${JSON.stringify({ goal, floor, offer, round, lastCounter, message })} -> ${r.action} ${r.amount}`);
              if (r.action === "counter") assert.ok(r.amount <= Math.min(100, lastCounter ?? 100) && r.amount > offer);
            }
});

test("sellerNote: accept / walk-away replies reference the message", () => {
  assert.deepEqual(sellerNote(undefined, "accept", 80), { message: "Deal at 80 dUSDC. The NFT is yours.", read: [] });
  const a = sellerNote("my first NFT!", "accept", 80);
  assert.match(a.message, /first/i);
  assert.match(a.message, /80 dUSDC/);
  const w = sellerNote("can't afford it, sorry", "walk_away", 87);
  assert.match(w.message, /money being tight/);
  assert.match(w.message, /87 dUSDC stands/);
});
