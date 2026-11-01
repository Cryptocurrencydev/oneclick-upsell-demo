import type Stripe from "stripe";
import type { PoolClient } from "pg";
import { transition, type Source } from "./state-machine";
import { UPSELL_PRODUCT } from "./catalog";

export type ChargeStatus = "creating" | "processing" | "requires_action" | "succeeded" | "failed" | "refunded";

export type ChargeRow = {
  id: string;
  order_id: string;
  step: "checkout" | "upsell";
  attempt: number;
  idempotency_key: string;
  stripe_payment_intent_id: string | null;
  amount_cents: number;
  status: ChargeStatus;
  failure_code: string | null;
  failure_message: string | null;
  last_event_created: string | null;
  created_at: Date;
};

// Monotonic rank: a charge never moves backwards (e.g. a late "processing" or
// "payment_failed" event can't undo a success that was already applied).
const RANK: Record<ChargeStatus, number> = {
  creating: 0, processing: 1, requires_action: 1, failed: 2, succeeded: 2, refunded: 3,
};

/** Decline codes where retrying the same card is pointless or unsafe. */
const NON_RETRYABLE = new Set([
  "lost_card", "stolen_card", "pickup_card", "fraudulent", "restricted_card",
  "merchant_blacklist", "invalid_account", "card_not_supported", "expired_card",
]);
export const isRetryableDecline = (code: string | null) => !code || !NON_RETRYABLE.has(code);

type Mapped = { status: ChargeStatus; failure_code?: string | null; failure_message?: string | null };

function mapIntent(pi: Stripe.PaymentIntent, step: "checkout" | "upsell"): Mapped {
  const err = pi.last_payment_error;
  const code = err?.decline_code ?? err?.code ?? null;
  switch (pi.status) {
    case "succeeded":
      return { status: "succeeded", failure_code: null, failure_message: null };
    case "processing":
      return { status: "processing" };
    case "requires_action":
      return { status: "requires_action" };
    case "canceled":
      return { status: "failed", failure_code: "canceled", failure_message: "Payment was canceled." };
    case "requires_payment_method":
      if (!err) return { status: "processing" }; // fresh checkout intent, nothing attempted yet
      // Off-session charge needs the customer to authenticate (3DS): recoverable on-session.
      if (step === "upsell" && err.code === "authentication_required")
        return { status: "requires_action", failure_code: code, failure_message: err.message ?? null };
      // At checkout the Payment Element lets the customer retry on the same intent,
      // so a decline there isn't terminal.
      if (step === "checkout") return { status: "processing", failure_code: code, failure_message: err.message ?? null };
      return { status: "failed", failure_code: code, failure_message: err.message ?? "Card declined." };
    default:
      return { status: "processing" };
  }
}

export type ApplyMeta = { source: Source; stripeEventId?: string; eventCreated?: number };
export type ApplyOutcome = "applied" | "unchanged" | "stale" | "unknown_charge" | "amount_mismatch";

/**
 * Apply a Stripe PaymentIntent's state to our charge + order. It's the single path for
 * webhooks, synchronous API results and reconciliation, so they can't disagree.
 * Must run inside a transaction.
 */
export async function applyPaymentIntent(c: PoolClient, pi: Stripe.PaymentIntent, meta: ApplyMeta): Promise<ApplyOutcome> {
  const chargeId = pi.metadata?.charge_id;
  const { rows } = await c.query<ChargeRow>(
    `select * from charges where stripe_payment_intent_id = $1 or ($2::uuid is not null and id = $2::uuid)
     order by (stripe_payment_intent_id = $1) desc nulls last limit 1 for update`,
    [pi.id, chargeId && /^[0-9a-f-]{36}$/.test(chargeId) ? chargeId : null],
  );
  const charge = rows[0];
  if (!charge) return "unknown_charge";

  // Out-of-order guard 1: ignore events older than the last one applied to this charge.
  if (meta.eventCreated && charge.last_event_created && meta.eventCreated < Number(charge.last_event_created))
    return "stale";

  if (pi.amount !== charge.amount_cents || pi.currency !== "usd") {
    console.error(`[payments] amount mismatch for charge ${charge.id}: pi=${pi.amount} db=${charge.amount_cents}`);
    return "amount_mismatch";
  }

  const next = mapIntent(pi, charge.step);
  // Out-of-order guard 2: monotonic charge status.
  const forward = RANK[next.status] > RANK[charge.status] ||
    (RANK[next.status] === RANK[charge.status] && RANK[next.status] < 2 && next.status !== charge.status);
  const sameButNewInfo = next.status === charge.status && next.failure_message && next.failure_message !== charge.failure_message;

  if (!forward && !sameButNewInfo) {
    if (meta.eventCreated) await c.query("update charges set last_event_created = greatest(coalesce(last_event_created,0), $2) where id = $1", [charge.id, meta.eventCreated]);
    if (charge.stripe_payment_intent_id == null) await c.query("update charges set stripe_payment_intent_id = $2 where id = $1", [charge.id, pi.id]);
    return RANK[next.status] < RANK[charge.status] ? "stale" : "unchanged";
  }

  await c.query(
    `update charges set status = $2, stripe_payment_intent_id = $3,
       failure_code = coalesce($4, failure_code), failure_message = coalesce($5, failure_message),
       last_event_created = greatest(coalesce(last_event_created,0), coalesce($6, 0)), updated_at = now()
     where id = $1`,
    [charge.id, next.status, pi.id, next.failure_code ?? null, next.failure_message ?? null, meta.eventCreated ?? null],
  );

  // Only the latest attempt for a step may drive the order (a late event for an
  // older, already-failed attempt must not touch a newer attempt's order state).
  const latest = await c.query<{ id: string }>(
    "select id from charges where order_id = $1 and step = $2 order by attempt desc limit 1",
    [charge.order_id, charge.step],
  );
  if (latest.rows[0]?.id !== charge.id) return "applied";

  const t = { source: meta.source, stripeEventId: meta.stripeEventId, allowStale: meta.source === "webhook" };
  if (charge.step === "checkout" && next.status === "succeeded") {
    const pm = typeof pi.payment_method === "string" ? pi.payment_method : pi.payment_method?.id;
    await c.query("update orders set payment_method_id = coalesce(payment_method_id, $2) where id = $1", [charge.order_id, pm ?? null]);
    await transition(c, charge.order_id, "paid", { ...t, reason: `checkout ${pi.id} succeeded` });
  }
  if (charge.step === "upsell" && next.status === "succeeded") {
    await c.query(
      `insert into line_items (order_id, kind, sku, name, amount_cents) values ($1,'upsell',$2,$3,$4)
       on conflict (order_id, kind) do nothing`,
      [charge.order_id, UPSELL_PRODUCT.sku, UPSELL_PRODUCT.name, charge.amount_cents],
    );
    await transition(c, charge.order_id, "upsell_paid", { ...t, reason: `upsell ${pi.id} succeeded` });
  }
  if (charge.step === "upsell" && next.status === "failed") {
    await transition(c, charge.order_id, "upsell_failed", { ...t, reason: `upsell ${pi.id} failed: ${next.failure_code ?? "unknown"}` });
  }
  return "applied";
}
