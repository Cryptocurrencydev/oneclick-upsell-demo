import type { Db } from "./db";

export const STATUSES = ["pending", "paid", "upsell_pending", "upsell_paid", "upsell_failed", "refunded"] as const;
export type OrderStatus = (typeof STATUSES)[number];
export type Source = "api" | "webhook" | "reconcile" | "admin";

/** The only legal edges. Anything else is rejected and nothing is written. */
export const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["paid"],
  paid: ["upsell_pending"],
  upsell_pending: ["upsell_paid", "upsell_failed"],
  upsell_failed: ["upsell_pending"], // customer-initiated retry (new attempt)
  upsell_paid: ["refunded"],
  refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransition extends Error {
  constructor(public from: OrderStatus, public to: OrderStatus) {
    super(`Illegal order transition ${from} -> ${to}`);
  }
}

export type TransitionResult = { changed: boolean; from: OrderStatus; to: OrderStatus };

/**
 * Move an order to `to`, logging the transition in order_events in the same transaction.
 * - Same-state requests are a no-op (idempotent).
 * - With `allowStale`, an illegal edge is ignored instead of thrown. Webhooks use this
 *   because Stripe can deliver events late or out of order.
 * Must be called inside a transaction (`c` is a PoolClient from tx()).
 */
export async function transition(
  c: Db,
  orderId: string,
  to: OrderStatus,
  meta: { reason: string; source: Source; stripeEventId?: string; allowStale?: boolean },
): Promise<TransitionResult> {
  const { rows } = await c.query<{ status: OrderStatus }>(
    "select status from orders where id = $1 for update",
    [orderId],
  );
  if (!rows[0]) throw new Error(`order ${orderId} not found`);
  const from = rows[0].status;
  if (from === to) return { changed: false, from, to };
  if (!canTransition(from, to)) {
    if (meta.allowStale) return { changed: false, from, to: from };
    throw new IllegalTransition(from, to);
  }
  await c.query("update orders set status = $2, updated_at = now() where id = $1", [orderId, to]);
  await c.query(
    `insert into order_events (order_id, from_status, to_status, reason, source, stripe_event_id)
     values ($1,$2,$3,$4,$5,$6)`,
    [orderId, from, to, meta.reason, meta.source, meta.stripeEventId ?? null],
  );
  return { changed: true, from, to };
}

export const idempotencyKey = (orderId: string, step: "checkout" | "upsell" | "upsell-refund", attempt = 1) =>
  `${orderId}:${step}:${attempt}`;
