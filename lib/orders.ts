import { pool, tx } from "./db";
import { stripe } from "./stripe";
import { applyPaymentIntent, type ChargeRow } from "./payments";
import { createUpsellIntent, upsellState } from "./upsell";
import type { OrderStatus } from "./state-machine";

export async function getOrderView(orderId: string) {
  if (!/^[0-9a-f-]{36}$/.test(orderId)) return null;
  const o = await pool().query<{ id: string; status: OrderStatus; email: string; created_at: Date }>(
    "select id, status, email, created_at from orders where id = $1",
    [orderId],
  );
  if (!o.rows[0]) return null;
  const [items, charges, events] = await Promise.all([
    pool().query("select kind, sku, name, amount_cents from line_items where order_id = $1 order by kind = 'upsell', created_at", [orderId]),
    pool().query<ChargeRow>(
      "select id, step, attempt, status, amount_cents, failure_code, failure_message, stripe_payment_intent_id, created_at from charges where order_id = $1 order by step, attempt",
      [orderId],
    ),
    pool().query("select from_status, to_status, reason, source, created_at from order_events where order_id = $1 order by id", [orderId]),
  ]);
  const order = o.rows[0];
  const upsell = ["upsell_pending", "upsell_paid", "upsell_failed", "refunded"].includes(order.status)
    ? await upsellState(orderId)
    : null;
  const refunded = order.status === "refunded";
  const lineItems = items.rows.map((li) => ({ ...li, refunded: li.kind === "upsell" && refunded }));
  const total = lineItems.reduce((s, li) => s + (li.refunded ? 0 : li.amount_cents), 0);
  return { order, lineItems, total, charges: charges.rows, events: events.rows, upsell };
}

/**
 * Safety net for missed or slow webhooks. Webhooks remain the primary driver; this only
 * runs for charges that have sat in a non-terminal state for a while, and it asks Stripe
 * (server-side) for the truth. It never trusts the client redirect.
 */
export async function reconcileOrder(orderId: string, olderThanMs = 5000) {
  const { rows } = await pool().query<ChargeRow & { stripe_customer_id: string; payment_method_id: string }>(
    `select ch.*, o.stripe_customer_id, o.payment_method_id from charges ch join orders o on o.id = ch.order_id
     where ch.order_id = $1 and ch.status in ('creating','processing') and ch.updated_at < now() - ($2 || ' milliseconds')::interval`,
    [orderId, String(olderThanMs)],
  );
  for (const ch of rows) {
    if (ch.stripe_payment_intent_id) {
      const pi = await stripe().paymentIntents.retrieve(ch.stripe_payment_intent_id);
      await tx((c) => applyPaymentIntent(c, pi, { source: "reconcile" }));
    } else if (ch.step === "upsell" && ch.status === "creating") {
      // The original request died mid-flight. Re-sending with the SAME idempotency key is safe:
      // Stripe returns the original PaymentIntent if it was created, or creates it exactly once.
      await createUpsellIntent(ch, ch.stripe_customer_id, ch.payment_method_id);
    }
  }
}
