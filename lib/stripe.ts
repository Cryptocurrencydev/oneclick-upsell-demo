import Stripe from "stripe";

let client: Stripe | undefined;

export function stripe(): Stripe {
  if (!client) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    // Hard guard: this demo must never touch live money.
    if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
      throw new Error("Refusing to start: STRIPE_SECRET_KEY is not a TEST mode key");
    }
    // maxNetworkRetries: the SDK retries transient network errors reusing the SAME idempotency key.
    client = new Stripe(key, { maxNetworkRetries: 2, timeout: 20_000 });
  }
  return client;
}

/** Test hook: swap the Stripe client for a fake. */
export function setStripeForTests(fake: unknown) {
  client = fake as Stripe;
}
