import Stripe from "stripe";
import { tx } from "./db";
import { applyPaymentIntent } from "./payments";
import { applyRefund } from "./refunds";

// Signature verification is pure crypto; no API key or network needed.
const verifier = new Stripe("sk_test_signature_verification_only");

export type WebhookResult = { status: number; body: Record<string, unknown> };

const PI_EVENTS = new Set([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.processing",
  "payment_intent.requires_action",
  "payment_intent.canceled",
]);

/**
 * Verify the signature, then process the event exactly once. The stripe_events insert
 * and the business effects commit in ONE transaction: if processing throws, nothing is
 * recorded, we return 500, and Stripe redelivers. Replays of a processed event are acknowledged
 * with 200 and ignored.
 */
export async function handleStripeWebhook(rawBody: string, signature: string | null): Promise<WebhookResult> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return { status: 500, body: { error: "webhook secret not configured" } };
  if (!signature) return { status: 400, body: { error: "missing stripe-signature" } };

  let event: Stripe.Event;
  try {
    event = verifier.webhooks.constructEvent(rawBody, signature, secret); // also enforces 5-min timestamp tolerance
  } catch {
    return { status: 400, body: { error: "invalid signature" } };
  }
  if (event.livemode) return { status: 400, body: { error: "live mode events are rejected by this demo" } };

  return tx(async (c) => {
    const ins = await c.query(
      "insert into stripe_events (id, type, created) values ($1,$2,$3) on conflict (id) do nothing returning id",
      [event.id, event.type, event.created],
    );
    if (ins.rowCount === 0) return { status: 200, body: { received: true, duplicate: true } };

    let outcome = "ignored";
    if (PI_EVENTS.has(event.type)) {
      const pi = event.data.object as Stripe.PaymentIntent;
      outcome = await applyPaymentIntent(c, pi, { source: "webhook", stripeEventId: event.id, eventCreated: event.created });
    } else if (event.type === "charge.refunded" || event.type === "refund.updated" || event.type === "refund.created") {
      outcome = await handleRefundEvent(c, event);
    }
    await c.query("update stripe_events set outcome = $2 where id = $1", [event.id, outcome]);
    return { status: 200, body: { received: true, outcome } };
  });
}

async function handleRefundEvent(c: import("pg").PoolClient, event: Stripe.Event): Promise<string> {
  let refund: Stripe.Refund | undefined;
  if (event.type === "charge.refunded") {
    const ch = event.data.object as Stripe.Charge;
    refund = ch.refunds?.data?.[0];
    if (!refund) return "no_refund_data";
  } else refund = event.data.object as Stripe.Refund;
  const pi = typeof refund.payment_intent === "string" ? refund.payment_intent : refund.payment_intent?.id;
  const { rows } = await c.query<{ id: string }>(
    "select id from charges where stripe_payment_intent_id = $1 and step = 'upsell'",
    [pi],
  );
  if (!rows[0]) return "not_upsell";
  // applyRefund opens its own tx; the refund row update is idempotent so this is safe.
  await applyRefund(refund.id, refund.status ?? "pending", rows[0].id, { source: "webhook", stripeEventId: event.id });
  return "refund_applied";
}
