// StripeProvider against Stripe test mode. Needs STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY (sk_test_) in .env;
// skipped otherwise. No real money moves in test mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { paymentsFromEnv, PaymentError, type HoldProvider } from "./payments.mts";

try { process.loadEnvFile(new URL("../../.env", import.meta.url).pathname); } catch {}
const live = process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_");
const skip = live ? false : "needs Stripe test keys in .env";

let p: HoldProvider, customer: string, card: string;
const key = () => crypto.randomUUID();
const hold = (amount: number, paymentMethod = card) =>
  p.authorize({ customer, paymentMethod, amount, idempotencyKey: key(), description: "holdback test", metadata: { test: "1" } });

test("setup: customer with Stripe's test Visa", { skip }, async () => {
  p = paymentsFromEnv();
  customer = await p.createCustomer("Holdback test", { test: "1" });
  const saved = await p.attachTestCard(customer);
  card = saved.paymentMethod;
  assert.match(saved.label, /Visa •••• 4242/);
});

test("authorize, then capture part: the rest is released", { skip }, async () => {
  const a = await hold(120);
  assert.equal(a.status, "authorized");
  assert.ok(a.expiresAt && a.expiresAt > Date.now(), "authorization has a capture deadline");
  const c = await p.capture(a.id, 96);
  assert.equal(c.status, "captured");
  assert.equal(c.captured, 96);
});

test("void releases an authorization; it can't be captured afterwards", { skip }, async () => {
  const a = await hold(40);
  assert.equal((await p.void(a.id)).status, "voided");
  await assert.rejects(p.capture(a.id, 40), PaymentError);
});

test("refund after capture, partial then full", { skip }, async () => {
  const a = await hold(30);
  await p.capture(a.id, 30);
  assert.equal((await p.refund(a.id, 10)).refunded, 10);
  const r = await p.refund(a.id);
  assert.equal(r.status, "refunded");
  assert.equal(r.refunded, 30);
});

test("a declined card becomes a PaymentError", { skip }, async () => {
  const declined = await p.attachTestCard(customer, "pm_card_chargeDeclined");
  await assert.rejects(hold(10, declined.paymentMethod), (e: any) => e instanceof PaymentError && /declined/i.test(e.message));
});
