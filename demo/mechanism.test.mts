import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseMechanism, respondToOffer, settleAuction, dutchPrice } from "./mechanism.mts";

const goal = { floor: 50, target: 100 };
test("mechanism follows demand", () => {
  assert.equal(chooseMechanism({ watchers: 0, offers: 0, secondsListed: 0, urgent: false }, goal).mechanism, "buy-now");
  assert.equal(chooseMechanism({ watchers: 1, offers: 0, secondsListed: 5, urgent: false }, goal).mechanism, "offers");
  assert.equal(chooseMechanism({ watchers: 3, offers: 1, secondsListed: 5, urgent: false }, goal).mechanism, "auction");
  assert.equal(chooseMechanism({ watchers: 0, offers: 0, secondsListed: 30, urgent: false }, goal).mechanism, "dutch");
});
test("quick sale and staleness", () => {
  assert.equal(chooseMechanism({ watchers: 0, offers: 0, secondsListed: 0, urgent: true }, goal).mechanism, "dutch");
  assert.equal(chooseMechanism({ watchers: 1, offers: 0, secondsListed: 0, urgent: true }, goal).mechanism, "offers");
  assert.equal(chooseMechanism({ watchers: 3, offers: 0, secondsListed: 0, urgent: true }, goal).mechanism, "auction");
  assert.equal(chooseMechanism({ watchers: 0, offers: 0, secondsListed: 999, urgent: false, staleSecs: 0 }, goal).mechanism, "buy-now", "never stale");
  assert.equal(chooseMechanism({ watchers: 0, offers: 0, secondsListed: 6, urgent: false, staleSecs: 5 }, goal).mechanism, "dutch");
});
test("offers", () => {
  assert.deepEqual(respondToOffer(45, goal), { action: "decline" });
  assert.deepEqual(respondToOffer(60, goal), { action: "counter", counter: 80 });
  assert.deepEqual(respondToOffer(100, goal), { action: "accept" });
});
test("proxy auction pays second price + increment", () => {
  const r = settleAuction([{ max: 120 }, { max: 95 }, { max: 60 }], 50, 1);
  assert.equal(r.winner?.max, 120);
  assert.equal(r.price, 96);
  assert.equal(r.losers.length, 2);
  assert.equal(settleAuction([{ max: 70 }], 50, 1).price, 50, "lone bidder pays the reserve");
  assert.equal(settleAuction([{ max: 40 }], 50, 1).winner, undefined, "below reserve: no sale");
});
test("dutch price floors", () => {
  assert.equal(dutchPrice(100, 40, 10, 5, 0), 100);
  assert.equal(dutchPrice(100, 40, 10, 5, 12), 80);
  assert.equal(dutchPrice(100, 40, 10, 5, 999), 40);
});
