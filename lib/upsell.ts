import Stripe from "stripe";
import { pool, tx } from "./db";
import { stripe } from "./stripe";
import { transition, idempotencyKey, type OrderStatus } from "./state-machine";
import { applyPaymentIntent, isRetryableDecline, type ChargeRow } from "./payments";
import { UPSELL_PRODUCT } from "./catalog";

export const MAX_UPSELL_ATTEMPTS = 3;

export type UpsellState =
  | { state: "paid" }
  | { state: "processing" }
  | { state: "requires_action"; clientSecret: string; paymentMethodId: string }
  | { state: "failed"; message: string; retryable: boolean }
  | { state: "not_eligible"; reason: string };

export class NotFound extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Errors where the request may or may not have reached Stripe: retry with the SAME key. */
function isTransient(e: unknown): boolean {
  return (
    e instanceof Stripe.errors.StripeConnectionError ||
    e instanceof Stripe.errors.StripeAPIError ||
    e instanceof Stripe.errors.StripeRateLimitError ||
    (e instanceof Stripe.errors.StripeError && (e.statusCode ?? 0) >= 500)
  );
}

/**
 * One-click upsell. Safe under double clicks, refreshes and concurrent retries:
 *  1. Row lock on the order + state check + a partial unique index (one live upsell
 *     charge per order) mean only ONE request ever creates a charge attempt.
 *  2. The Stripe call uses idempotency key "<order>:upsell:<attempt>", so a network
 *     retry of the same attempt can never create a second PaymentIntent.
 */
export async function chargeUpsell(orderId: string): Promise<UpsellState> {
  const reserved = await tx(async (c) => {
    const o = await c.query<{ status: OrderStatus; stripe_customer_id: string | null; payment_method_id: string | null }>(
      "select status, stripe_customer_id, payment_method_id from orders where id = $1 for update",
      [orderId],
    );
    const order = o.rows[0];
    if (!order) throw new NotFound();
    if (order.status === "pending") return { kind: "ineligible" as const, reason: "Your first payment is still confirming." };
    if (order.status === "upsell_pending" || order.status === "upsell_paid" || order.status === "refunded")
      return { kind: "existing" as const };
    if (!order.payment_method_id || !order.stripe_customer_id)
      return { kind: "ineligible" as const, reason: "No saved payment method on this order." };

    const prev = await c.query<{ attempt: number; failure_code: string | null }>(
      "select attempt, failure_code from charges where order_id = $1 and step = 'upsell' order by attempt desc limit 1",
      [orderId],
    );
    const last = prev.rows[0];
    if (last && !isRetryableDecline(last.failure_code))
      return { kind: "ineligible" as const, reason: "This card can't be charged again. Your original order is unaffected." };
    const attempt = (last?.attempt ?? 0) + 1;
    if (attempt > MAX_UPSELL_ATTEMPTS)
      return { kind: "ineligible" as const, reason: "Too many attempts. Your original order is unaffected." };

    const ins = await c.query<ChargeRow>(
      `insert into charges (order_id, step, attempt, idempotency_key, amount_cents)
       values ($1,'upsell',$2,$3,$4) returning *`,
      [orderId, attempt, idempotencyKey(orderId, "upsell", attempt), UPSELL_PRODUCT.amount_cents],
    );
    await transition(c, orderId, "upsell_pending", { source: "api", reason: `upsell attempt ${attempt} started` });
    return { kind: "created" as const, charge: ins.rows[0], customer: order.stripe_customer_id, pm: order.payment_method_id };
  });

  if (reserved.kind === "ineligible") return { state: "not_eligible", reason: reserved.reason };
  if (reserved.kind === "existing") return upsellState(orderId);

  // Stripe call happens OUTSIDE the transaction: never hold row locks across the network.
  await createUpsellIntent(reserved.charge, reserved.customer, reserved.pm);
  return upsellState(orderId);
}

/** Create (or idempotently re-create) the PaymentIntent for a charge attempt. */
export async function createUpsellIntent(charge: ChargeRow, customer: string, pm: string): Promise<void> {
  let pi: Stripe.PaymentIntent | undefined;
  for (let i = 0; i < 3; i++) {
    try {
      pi = await stripe().paymentIntents.create(
        {
          amount: charge.amount_cents,
          currency: "usd",
          customer,
          payment_method: pm,
          allowed_payment_method_types: ["card"],
          off_session: true,
          confirm: true,
          description: `Upsell: ${UPSELL_PRODUCT.name}`,
          metadata: { order_id: charge.order_id, step: "upsell", charge_id: charge.id, attempt: String(charge.attempt) },
        },
        { idempotencyKey: charge.idempotency_key },
      );
      break;
    } catch (e) {
      if (e instanceof Stripe.errors.StripeCardError) {
        // A decline or authentication_required: the error carries the PaymentIntent.
        const raw = (e.raw as { payment_intent?: Stripe.PaymentIntent } | undefined)?.payment_intent;
        if (raw) { pi = raw; break; }
        await markFailed(charge, e.decline_code ?? e.code ?? "card_error", e.message);
        return;
      }
      if (isTransient(e) && i < 2) { await sleep(400 * 2 ** i); continue; }
      if (isTransient(e)) {
        // Outcome unknown: leave the attempt in 'creating'. Reconciliation retries it with
        // the same idempotency key, which returns the original result if Stripe did run it.
        console.warn(`[upsell] transient error, will reconcile charge ${charge.id}:`, (e as Error).message);
        return;
      }
      await markFailed(charge, (e as Stripe.errors.StripeError).code ?? "error", (e as Error).message);
      return;
    }
  }
  if (pi) {
    const intent = pi;
    await tx((c) => applyPaymentIntent(c, intent, { source: "api" }));
  }
}

async function markFailed(charge: ChargeRow, code: string, message: string) {
  await tx(async (c) => {
    const r = await c.query(
      `update charges set status = 'failed', failure_code = $2, failure_message = $3, updated_at = now()
       where id = $1 and status in ('creating','processing','requires_action') returning id`,
      [charge.id, code, message],
    );
    if (r.rowCount) await transition(c, charge.order_id, "upsell_failed", { source: "api", reason: `upsell failed: ${code}` });
  });
}

/** Customer gave up on authenticating (or tapped "no thanks" while it was pending). */
export async function abandonUpsell(orderId: string): Promise<UpsellState> {
  const charge = await latestUpsellCharge(orderId);
  if (!charge || charge.status !== "requires_action") return upsellState(orderId);
  if (charge.stripe_payment_intent_id) {
    try {
      const pi = await stripe().paymentIntents.cancel(charge.stripe_payment_intent_id, {}, { idempotencyKey: `${charge.idempotency_key}:cancel` });
      await tx((c) => applyPaymentIntent(c, pi, { source: "api" }));
    } catch (e) {
      console.warn("[upsell] cancel failed", (e as Error).message);
    }
  }
  return upsellState(orderId);
}

export async function latestUpsellCharge(orderId: string): Promise<ChargeRow | undefined> {
  const { rows } = await pool().query<ChargeRow>(
    "select * from charges where order_id = $1 and step = 'upsell' order by attempt desc limit 1",
    [orderId],
  );
  return rows[0];
}

/** What the upsell UI should show right now. */
export async function upsellState(orderId: string): Promise<UpsellState> {
  const charge = await latestUpsellCharge(orderId);
  if (!charge) return { state: "not_eligible", reason: "No upsell attempted." };
  switch (charge.status) {
    case "succeeded":
    case "refunded":
      return { state: "paid" };
    case "creating":
    case "processing":
      return { state: "processing" };
    case "failed": {
      const retryable = isRetryableDecline(charge.failure_code) && charge.attempt < MAX_UPSELL_ATTEMPTS;
      return { state: "failed", message: friendlyDecline(charge.failure_code, charge.failure_message), retryable };
    }
    case "requires_action": {
      if (!charge.stripe_payment_intent_id) return { state: "processing" };
      const pi = await stripe().paymentIntents.retrieve(charge.stripe_payment_intent_id);
      const pm = typeof pi.payment_method === "string" ? pi.payment_method : pi.payment_method?.id;
      const fallbackPm = pi.last_payment_error?.payment_method?.id;
      return { state: "requires_action", clientSecret: pi.client_secret!, paymentMethodId: (pm ?? fallbackPm)! };
    }
  }
}

function friendlyDecline(code: string | null, raw: string | null): string {
  switch (code) {
    case "insufficient_funds": return "Your card has insufficient funds for the add-on.";
    case "payment_intent_authentication_failure": return "Your bank couldn't verify the payment.";
    case "canceled": return "The add-on wasn't charged.";
    case "expired_card": return "Your card has expired.";
    default: return raw ?? "Your card was declined for the add-on.";
  }
}
