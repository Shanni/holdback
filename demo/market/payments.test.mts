import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeCardProvider } from "./payments.mts";

async function setup() {
  let t = 0;
  const p = new FakeCardProvider({ now: () => t });
  const card = await p.createAccount("Ada", 300);
  return { p, card: card.id, advance: (ms: number) => (t += ms) };
}

test("authorize reserves credit; partial capture releases the rest", async () => {
  const { p, card } = await setup();
  const a = await p.authorize(card, 120);
  assert.equal(await p.available(card), 180);
  const c = await p.capture(a.id, 96);
  assert.equal(c.status, "captured");
  assert.equal(await p.available(card), 204);
  assert.equal(p.merchantBalance, 96);
});

test("declines above available credit", async () => {
  const { p, card } = await setup();
  await assert.rejects(p.authorize(card, 301), /declined/);
});

test("capture cannot exceed the authorization or run twice", async () => {
  const { p, card } = await setup();
  const a = await p.authorize(card, 50);
  await assert.rejects(p.capture(a.id, 51), /between/);
  await p.capture(a.id, 50);
  await assert.rejects(p.capture(a.id, 10), /captured/);
});

test("void returns everything and blocks capture", async () => {
  const { p, card } = await setup();
  const a = await p.authorize(card, 80);
  await p.void(a.id);
  assert.equal(await p.available(card), 300);
  await assert.rejects(p.capture(a.id, 80), /voided/);
});

test("refund only after capture, partial refunds add up", async () => {
  const { p, card } = await setup();
  const a = await p.authorize(card, 100);
  await assert.rejects(p.refund(a.id), /captured/);
  await p.capture(a.id, 100);
  assert.equal((await p.refund(a.id, 40)).status, "captured");
  assert.equal((await p.refund(a.id)).status, "refunded");
  assert.equal(await p.available(card), 300);
  assert.equal(p.merchantBalance, 0);
  await assert.rejects(p.refund(a.id, 1), /refunded/);
});

test("authorizations expire after 7 days and release the credit", async () => {
  const { p, card, advance } = await setup();
  const a = await p.authorize(card, 100);
  advance(7 * 86400 * 1000);
  await assert.rejects(p.capture(a.id, 100), /expired/);
  assert.equal(await p.available(card), 300);
});

test("idempotency key returns the same authorization", async () => {
  const { p, card } = await setup();
  const a = await p.authorize(card, 30, "k1");
  const b = await p.authorize(card, 30, "k1");
  assert.equal(a.id, b.id);
  assert.equal(await p.available(card), 270);
});
