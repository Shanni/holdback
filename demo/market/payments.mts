// Payment layer for the Holdback market: card authorize / capture / void / refund.
//
// The market server only talks to a HoldProvider. StripeProvider implements it with
// PaymentIntents (capture_method: manual): an authorization reserves the amount on the
// buyer's card, a capture can take less than was authorized (the rest is released),
// cancel voids it, and refunds follow a capture. Amounts are USD; Stripe gets cents.
import Stripe from "stripe";

export type AuthStatus = "authorized" | "captured" | "voided" | "refunded" | "expired" | "failed";

export type Authorization = {
  id: string;
  amount: number;
  captured: number;
  refunded: number;
  status: AuthStatus;
  expiresAt?: number;   // ms; card authorizations must be captured before this
};

export type ProviderCapabilities = {
  maxHoldSecs: number;
  partialCapture: boolean;
  multiCapture: boolean;
  incrementalAuth: boolean;
};

export type SavedCard = { paymentMethod: string; label: string };

export interface HoldProvider {
  readonly id: string;
  readonly name: string;
  readonly mode: "test" | "live";
  readonly publishableKey: string;
  readonly capabilities: ProviderCapabilities;
  createCustomer(name: string, metadata: Record<string, string>): Promise<string>;
  /** Starts saving a card for later holds; the browser confirms it with the client secret. */
  startCardSetup(customer: string): Promise<{ setupIntent: string; clientSecret: string }>;
  finishCardSetup(customer: string, setupIntent: string): Promise<SavedCard>;
  /** Test mode only: attach one of Stripe's test cards (default pm_card_visa) without a browser. */
  attachTestCard(customer: string, testCard?: string): Promise<SavedCard>;
  authorize(req: { customer: string; paymentMethod: string; amount: number; idempotencyKey: string; description: string; metadata: Record<string, string> }): Promise<Authorization>;
  /** Takes `amount` (≤ authorized); the rest of the authorization is released. */
  capture(authId: string, amount: number): Promise<Authorization>;
  /** Releases an uncaptured authorization in full. */
  void(authId: string): Promise<Authorization>;
  /** Returns up to the captured amount (default: all of it). */
  refund(authId: string, amount?: number): Promise<Authorization>;
  get(authId: string): Promise<Authorization>;
}

/** A payment problem to show the buyer (declined card, authentication needed, ...). */
export class PaymentError extends Error {}

const cents = (usd: number) => Math.round(usd * 100);
const usd = (c: number) => c / 100;
const CARD_AUTH_SECS = 7 * 86400;

export class StripeProvider implements HoldProvider {
  readonly id = "stripe";
  readonly name: string;
  readonly mode: "test" | "live";
  readonly capabilities: ProviderCapabilities = { maxHoldSecs: CARD_AUTH_SECS, partialCapture: true, multiCapture: false, incrementalAuth: false };
  readonly publishableKey: string;
  private stripe: Stripe;

  constructor(secretKey: string, publishableKey: string) {
    this.publishableKey = publishableKey;
    this.mode = secretKey.startsWith("sk_live_") ? "live" : "test";
    this.name = this.mode === "live" ? "Stripe" : "Stripe (test mode)";
    this.stripe = new Stripe(secretKey, { appInfo: { name: "holdback" } });
  }

  async createCustomer(name: string, metadata: Record<string, string>) {
    return (await this.call(() => this.stripe.customers.create({ name, metadata }))).id;
  }

  async startCardSetup(customer: string) {
    const si = await this.call(() => this.stripe.setupIntents.create({ customer, usage: "off_session", payment_method_types: ["card"] }));
    return { setupIntent: si.id, clientSecret: si.client_secret! };
  }

  async finishCardSetup(customer: string, setupIntent: string) {
    const si = await this.call(() => this.stripe.setupIntents.retrieve(setupIntent, { expand: ["payment_method"] }));
    if (si.customer !== customer) throw new PaymentError("that card setup belongs to someone else");
    if (si.status !== "succeeded") throw new PaymentError(`card setup is ${si.status.replace(/_/g, " ")}`);
    return this.saved(si.payment_method as Stripe.PaymentMethod);
  }

  async attachTestCard(customer: string, testCard = "pm_card_visa") {
    if (this.mode !== "test") throw new PaymentError("test cards only work with a test-mode key");
    return this.saved(await this.call(() => this.stripe.paymentMethods.attach(testCard, { customer })));
  }

  async authorize(req: { customer: string; paymentMethod: string; amount: number; idempotencyKey: string; description: string; metadata: Record<string, string> }) {
    const pi = await this.call(() => this.stripe.paymentIntents.create({
      amount: cents(req.amount), currency: "usd", customer: req.customer, payment_method: req.paymentMethod,
      capture_method: "manual", confirm: true, off_session: true,
      description: req.description, metadata: req.metadata, expand: ["latest_charge"],
    }, { idempotencyKey: req.idempotencyKey }));
    if (pi.status !== "requires_capture") {
      if (pi.status !== "canceled") await this.stripe.paymentIntents.cancel(pi.id).catch(() => {});
      throw new PaymentError(pi.status === "requires_action" ? "the card needs the owner to authenticate this payment" : `card authorization ${pi.status.replace(/_/g, " ")}`);
    }
    return this.toAuth(pi);
  }

  async capture(authId: string, amount: number) {
    return this.toAuth(await this.call(() => this.stripe.paymentIntents.capture(authId, { amount_to_capture: cents(amount), expand: ["latest_charge"] })));
  }

  async void(authId: string) {
    return this.toAuth(await this.call(() => this.stripe.paymentIntents.cancel(authId, { expand: ["latest_charge"] })));
  }

  async refund(authId: string, amount?: number) {
    await this.call(() => this.stripe.refunds.create({ payment_intent: authId, ...(amount === undefined ? {} : { amount: cents(amount) }) }));
    return this.get(authId);
  }

  async get(authId: string) {
    return this.toAuth(await this.call(() => this.stripe.paymentIntents.retrieve(authId, { expand: ["latest_charge"] })));
  }

  private saved(pm: Stripe.PaymentMethod): SavedCard {
    const c = pm.card;
    const brand = c?.brand ? c.brand[0].toUpperCase() + c.brand.slice(1) : "Card";
    return { paymentMethod: pm.id, label: c ? `${brand} •••• ${c.last4}` : brand };
  }

  private toAuth(pi: Stripe.PaymentIntent): Authorization {
    const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
    const captured = usd(pi.amount_received ?? 0);
    const refunded = usd(charge?.amount_refunded ?? 0);
    const status: AuthStatus =
      pi.status === "requires_capture" ? "authorized"
      : pi.status === "succeeded" ? (refunded > 0 && refunded >= captured ? "refunded" : "captured")
      : pi.status === "canceled" ? (pi.cancellation_reason === "automatic" || pi.cancellation_reason === "expired" ? "expired" : "voided")
      : "failed";
    const before = charge?.payment_method_details?.card?.capture_before;
    return { id: pi.id, amount: usd(pi.amount), captured, refunded, status, expiresAt: before ? before * 1000 : undefined };
  }

  /** Stripe card and request errors become PaymentErrors with Stripe's own message. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e: any) {
      if (e instanceof Stripe.errors.StripeCardError || e instanceof Stripe.errors.StripeInvalidRequestError) throw new PaymentError(e.message);
      throw e;
    }
  }
}

/** The provider configured in the environment (.env). Refuses live keys unless ALLOW_LIVE=1. */
export function paymentsFromEnv(env = process.env): HoldProvider {
  const sk = env.STRIPE_SECRET_KEY, pk = env.STRIPE_PUBLISHABLE_KEY;
  if (!sk || !pk) throw new Error("Set STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY (test-mode keys from dashboard.stripe.com/test/apikeys) in .env");
  if (sk.startsWith("sk_live_") && env.ALLOW_LIVE !== "1") throw new Error("Refusing a live Stripe key: set ALLOW_LIVE=1 once you mean to take real payments");
  if (sk.startsWith("sk_live_") !== pk.startsWith("pk_live_")) throw new Error("STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY are from different modes");
  return new StripeProvider(sk, pk);
}
