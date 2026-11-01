import { tx } from "./db";
import { stripe } from "./stripe";
import { transition, idempotencyKey, type OrderStatus } from "./state-machine";
import type { ChargeRow } from "./payments";

export type RefundResult =
  | { ok: true; refundId: string; status: string; alreadyRefunded: boolean }
  | { ok: false; error: string; status: number };

/**
 * Refund ONLY the upsell charge of an order. Idempotent:
 *  - refunds.charge_id is unique, so one refund row per upsell charge
 *  - the Stripe call uses key "<order>:upsell-refund:1", so retries return the same refund
 *  - an already-refunded order returns the existing refund
 */
export async function refundUpsell(orderId: string): Promise<RefundResult> {
  const prep = await tx(async (c) => {
    const o = await c.query<{ status: OrderStatus }>("select status from orders where id = $1 for update", [orderId]);
    if (!o.rows[0]) return { error: "order not found", status: 404 } as const;
    const ch = await c.query<ChargeRow>(
      "select * from charges where order_id = $1 and step = 'upsell' and status in ('succeeded','refunded') limit 1",
      [orderId],
    );
    const charge = ch.rows[0];
    if (!charge) return { error: "order has no paid upsell to refund", status: 409 } as const;
    await c.query(
      `insert into refunds (charge_id, idempotency_key, amount_cents) values ($1,$2,$3)
       on conflict (charge_id) do nothing`,
      [charge.id, idempotencyKey(orderId, "upsell-refund"), charge.amount_cents],
    );
    const r = await c.query<{ id: string; idempotency_key: string; stripe_refund_id: string | null; status: string }>(
      "select * from refunds where charge_id = $1",
      [charge.id],
    );
    return { charge, refund: r.rows[0], orderStatus: o.rows[0].status };
  });
  if ("error" in prep) return { ok: false, error: prep.error!, status: prep.status! };

  const { charge, refund } = prep;
  if (refund.status === "succeeded" && refund.stripe_refund_id)
    return { ok: true, refundId: refund.stripe_refund_id, status: "succeeded", alreadyRefunded: true };

  const sr = await stripe().refunds.create(
    {
      payment_intent: charge.stripe_payment_intent_id!,
      amount: charge.amount_cents, // upsell amount only; the main purchase is untouched
      reason: "requested_by_customer",
      metadata: { order_id: orderId, charge_id: charge.id, step: "upsell" },
    },
    { idempotencyKey: refund.idempotency_key },
  );
  await applyRefund(sr.id, sr.status ?? "pending", charge.id, { source: "admin" });
  return { ok: true, refundId: sr.id, status: sr.status ?? "pending", alreadyRefunded: false };
}

/** Shared by the admin endpoint and the refund webhooks. */
export async function applyRefund(
  stripeRefundId: string,
  status: string,
  chargeId: string,
  meta: { source: "admin" | "webhook"; stripeEventId?: string },
) {
  await tx(async (c) => {
    await c.query(
      `update refunds set stripe_refund_id = coalesce(stripe_refund_id, $2),
         status = case when status = 'succeeded' then status else $3 end, updated_at = now()
       where charge_id = $1`,
      [chargeId, stripeRefundId, status],
    );
    if (status !== "succeeded") return;
    const ch = await c.query<{ order_id: string }>(
      "update charges set status = 'refunded', updated_at = now() where id = $1 and status = 'succeeded' returning order_id",
      [chargeId],
    );
    const orderId = ch.rows[0]?.order_id;
    if (orderId)
      await transition(c, orderId, "refunded", {
        source: meta.source, reason: `upsell refund ${stripeRefundId}`, stripeEventId: meta.stripeEventId, allowStale: true,
      });
  });
}
