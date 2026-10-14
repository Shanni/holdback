// Payment layer for the Holdback market: card-style authorize / capture / void / refund.
//
// The market server only talks to a HoldProvider. FakeCardProvider is an in-memory
// processor with the same rules a card processor enforces (an authorization reserves
// the buyer's available credit, captures can be partial but never exceed the
// authorization, authorizations expire, refunds only follow a capture), so the demo and
// tests run offline. A StripeProvider (PaymentIntents, capture_method: manual) replaces
// it without touching the server. See docs/v2-plan.md.

export type AuthStatus = "authorized" | "captured" | "voided" | "refunded" | "expired";

export type Authorization = {
  id: string;
  account: string;
  amount: number;
  captured: number;
  refunded: number;
  status: AuthStatus;
  createdAt: number;
  expiresAt: number;
};

export type ProviderCapabilities = {
  maxHoldSecs: number;
  partialCapture: boolean;
  multiCapture: boolean;
  incrementalAuth: boolean;
};

export interface HoldProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /** A demo payment method with `limit` available. Real providers attach the buyer's own card. */
  createAccount(holder: string, limit: number): Promise<{ id: string; label: string }>;
  available(account: string): Promise<number>;
  authorize(account: string, amount: number, idempotencyKey?: string): Promise<Authorization>;
  /** Takes `amount` (≤ authorized); the rest of the authorization is released. */
  capture(authId: string, amount: number): Promise<Authorization>;
  /** Releases an uncaptured authorization in full. */
  void(authId: string): Promise<Authorization>;
  /** Returns up to the captured amount (default: all of it). */
  refund(authId: string, amount?: number): Promise<Authorization>;
  get(authId: string): Promise<Authorization>;
}

export class PaymentError extends Error {}

const CARD_AUTH_SECS = 7 * 86400; // card-not-present authorizations typically last about 7 days

export class FakeCardProvider implements HoldProvider {
  readonly id = "fake-card";
  readonly name = "Demo cards (in-memory)";
  readonly capabilities: ProviderCapabilities = { maxHoldSecs: CARD_AUTH_SECS, partialCapture: true, multiCapture: false, incrementalAuth: false };
  /** Money the merchant has captured, net of refunds. */
  merchantBalance = 0;
  private accounts = new Map<string, { holder: string; available: number; label: string }>();
  private auths = new Map<string, Authorization>();
  private byKey = new Map<string, string>();
  private seq = 1;
  private clock: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.clock = opts.now ?? Date.now;
  }

  async createAccount(holder: string, limit: number) {
    const id = `pm_${this.seq++}`;
    const label = `Demo card •••• ${String(4000 + ((this.seq * 7919) % 6000)).slice(-4)}`;
    this.accounts.set(id, { holder, available: limit, label });
    return { id, label };
  }

  async available(account: string) {
    return this.account(account).available;
  }

  async authorize(account: string, amount: number, idempotencyKey?: string) {
    if (idempotencyKey && this.byKey.has(idempotencyKey)) return this.auth(this.byKey.get(idempotencyKey)!);
    if (!(amount > 0)) throw new PaymentError("amount must be positive");
    const a = this.account(account);
    if (a.available < amount) throw new PaymentError(`card declined: ${a.available} USD available, ${amount} needed`);
    a.available -= amount;
    const now = this.clock();
    const auth: Authorization = {
      id: `auth_${this.seq++}`, account, amount, captured: 0, refunded: 0, status: "authorized",
      createdAt: now, expiresAt: now + CARD_AUTH_SECS * 1000,
    };
    this.auths.set(auth.id, auth);
    if (idempotencyKey) this.byKey.set(idempotencyKey, auth.id);
    return { ...auth };
  }

  async capture(authId: string, amount: number) {
    const auth = this.live(authId);
    if (!(amount > 0) || amount > auth.amount) throw new PaymentError(`capture must be between 0 and ${auth.amount}`);
    auth.captured = amount;
    auth.status = "captured";
    this.account(auth.account).available += auth.amount - amount;
    this.merchantBalance += amount;
    return { ...auth };
  }

  async void(authId: string) {
    const auth = this.live(authId);
    auth.status = "voided";
    this.account(auth.account).available += auth.amount;
    return { ...auth };
  }

  async refund(authId: string, amount?: number) {
    const auth = this.auth(authId);
    if (auth.status !== "captured") throw new PaymentError(`only a captured payment can be refunded (this one is ${auth.status})`);
    const left = auth.captured - auth.refunded;
    const n = amount ?? left;
    if (!(n > 0) || n > left) throw new PaymentError(`refund must be between 0 and ${left}`);
    auth.refunded += n;
    if (auth.refunded === auth.captured) auth.status = "refunded";
    this.account(auth.account).available += n;
    this.merchantBalance -= n;
    return { ...auth };
  }

  async get(authId: string) {
    return { ...this.expireIfDue(this.auth(authId)) };
  }

  private account(id: string) {
    const a = this.accounts.get(id);
    if (!a) throw new PaymentError(`unknown payment method ${id}`);
    return a;
  }

  private auth(id: string) {
    const a = this.auths.get(id);
    if (!a) throw new PaymentError(`unknown authorization ${id}`);
    return a;
  }

  /** An authorization that is still open: not captured, voided or expired. */
  private live(id: string) {
    const a = this.expireIfDue(this.auth(id));
    if (a.status !== "authorized") throw new PaymentError(`authorization ${id} is ${a.status}`);
    return a;
  }

  private expireIfDue(a: Authorization) {
    if (a.status === "authorized" && this.clock() >= a.expiresAt) {
      a.status = "expired";
      this.account(a.account).available += a.amount;
    }
    return a;
  }
}
