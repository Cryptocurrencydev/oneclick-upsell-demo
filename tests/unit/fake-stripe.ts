import Stripe from "stripe";

type PI = Stripe.PaymentIntent;
let seq = 0;
const id = (p: string) => `${p}_${Date.now().toString(36)}${(++seq).toString(36)}`;

/**
 * A fake of the Stripe API surface we use. It models Stripe's idempotency semantics: the same
 * idempotency key returns the original result (including the original error) and never creates
 * a second object. Payment method ids pick behavior:
 *   pm_ok        succeeds off-session
 *   pm_decline   card_declined (insufficient_funds)
 *   pm_stolen    card_declined (stolen_card, not retryable)
 *   pm_auth      authentication_required (3DS) off-session
 *   pm_flaky     Stripe runs the charge but the response is lost once (network error)
 */
export class FakeStripe {
  intents = new Map<string, PI>();
  idem = new Map<string, { ok: unknown } | { err: unknown }>();
  createCalls = 0;      // paymentIntents.create calls (including idempotent replays)
  refundsCreated = 0;   // distinct refunds actually created
  flakyFailuresLeft = 1;
  failNextNetwork = 0;

  reset() {
    this.intents.clear(); this.idem.clear();
    this.createCalls = 0; this.refundsCreated = 0; this.flakyFailuresLeft = 1; this.failNextNetwork = 0;
  }
  /** PaymentIntents actually created (what the customer would see on their statement). */
  createdIntents(filter?: (p: PI) => boolean) {
    return [...this.intents.values()].filter((p) => !filter || filter(p));
  }

  private async idempotent<T>(key: string | undefined, fn: () => T, afterRun?: () => void): Promise<T> {
    await new Promise((r) => setTimeout(r, 5)); // be a little async so races are real
    if (key && this.idem.has(key)) {
      const v = this.idem.get(key)!;
      if ("err" in v) throw v.err;
      return v.ok as T;
    }
    try {
      const out = fn();
      if (key) this.idem.set(key, { ok: out });
      afterRun?.();
      return out;
    } catch (e) {
      if (key && e instanceof Stripe.errors.StripeCardError) this.idem.set(key, { err: e });
      throw e;
    }
  }

  customers = {
    create: (p: { email: string }, o?: { idempotencyKey?: string }) =>
      this.idempotent(o?.idempotencyKey, () => ({ id: id("cus"), email: p.email } as Stripe.Customer)),
  };

  paymentIntents = {
    create: async (p: Stripe.PaymentIntentCreateParams, o?: { idempotencyKey?: string }) => {
      this.createCalls++;
      if (this.failNextNetwork > 0) {
        this.failNextNetwork--;
        throw new Stripe.errors.StripeConnectionError({ message: "socket hang up" } as never);
      }
      let lostResponse = false;
      const result = await this.idempotent(o?.idempotencyKey, () => {
        const pi = {
          id: id("pi"), object: "payment_intent", amount: p.amount, currency: p.currency,
          customer: p.customer ?? null, metadata: p.metadata ?? {}, client_secret: "",
          payment_method: p.payment_method ?? null, status: "requires_payment_method", last_payment_error: null,
          livemode: false,
        } as unknown as PI;
        pi.client_secret = `${pi.id}_secret_x`;
        this.intents.set(pi.id, pi);
        if (p.confirm) {
          const pm = p.payment_method!;
          if (pm === "pm_ok" || pm === "pm_flaky") pi.status = "succeeded";
          else {
            const auth = pm === "pm_auth";
            const decline = pm === "pm_stolen" ? "stolen_card" : "insufficient_funds";
            pi.status = "requires_payment_method";
            pi.last_payment_error = {
              type: "card_error", code: auth ? "authentication_required" : "card_declined",
              decline_code: auth ? undefined : decline, message: auth ? "Authentication required" : "Your card was declined.",
              payment_method: { id: pm } as Stripe.PaymentMethod,
            } as Stripe.PaymentIntent.LastPaymentError;
            throw new Stripe.errors.StripeCardError({
              type: "card_error", message: pi.last_payment_error.message, code: pi.last_payment_error.code,
              decline_code: pi.last_payment_error.decline_code, payment_intent: structuredClone(pi),
            } as never);
          }
          if (pm === "pm_flaky" && this.flakyFailuresLeft > 0) { this.flakyFailuresLeft--; lostResponse = true; }
        }
        return structuredClone(pi);
      });
      if (lostResponse) throw new Stripe.errors.StripeConnectionError({ message: "ECONNRESET after send" } as never);
      return result;
    },
    retrieve: async (piId: string) => structuredClone(this.intents.get(piId)!),
    cancel: async (piId: string) => {
      const pi = this.intents.get(piId)!;
      pi.status = "canceled";
      return structuredClone(pi);
    },
  };

  refunds = {
    create: (p: { payment_intent: string; amount: number }, o?: { idempotencyKey?: string }) =>
      this.idempotent(o?.idempotencyKey, () => {
        this.refundsCreated++;
        return { id: id("re"), payment_intent: p.payment_intent, amount: p.amount, status: "succeeded" } as Stripe.Refund;
      }),
  };

  /** Test helper: what the customer later does in the browser to settle a PI. */
  settle(piId: string, status: PI["status"], err?: Partial<Stripe.PaymentIntent.LastPaymentError>) {
    const pi = this.intents.get(piId)!;
    pi.status = status;
    pi.last_payment_error = (err as Stripe.PaymentIntent.LastPaymentError) ?? null;
    if (status === "succeeded" && !pi.payment_method) pi.payment_method = "pm_ok";
    return structuredClone(pi);
  }
}
