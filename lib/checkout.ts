import { pool, tx } from "./db";
import { stripe } from "./stripe";
import { idempotencyKey } from "./state-machine";
import { MAIN_PRODUCT } from "./catalog";

export class BadRequest extends Error {}

/**
 * Create (or return) the order + PaymentIntent for a checkout attempt.
 * `checkoutRef` is generated once per checkout page load. A double-submitted form or a
 * network retry maps to the SAME order (unique constraint) and the SAME PaymentIntent
 * (Stripe idempotency key "<order>:checkout:1").
 */
export async function startCheckout(checkoutRef: string, email: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(checkoutRef)) throw new BadRequest("invalid checkoutRef");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new BadRequest("invalid email");

  const order = await tx(async (c) => {
    await c.query(
      `insert into orders (checkout_ref, email) values ($1, $2) on conflict (checkout_ref) do nothing`,
      [checkoutRef, email],
    );
    const { rows } = await c.query<{ id: string; status: string; stripe_customer_id: string | null; email: string }>(
      "select id, status, stripe_customer_id, email from orders where checkout_ref = $1 for update",
      [checkoutRef],
    );
    const o = rows[0];
    await c.query(
      `insert into line_items (order_id, kind, sku, name, amount_cents) values ($1,'main',$2,$3,$4)
       on conflict (order_id, kind) do nothing`,
      [o.id, MAIN_PRODUCT.sku, MAIN_PRODUCT.name, MAIN_PRODUCT.amount_cents],
    );
    await c.query(
      `insert into charges (order_id, step, attempt, idempotency_key, amount_cents)
       values ($1,'checkout',1,$2,$3) on conflict (idempotency_key) do nothing`,
      [o.id, idempotencyKey(o.id, "checkout"), MAIN_PRODUCT.amount_cents],
    );
    return o;
  });
  if (order.status !== "pending") throw new BadRequest("order already paid");

  const customer = await stripe().customers.create(
    { email: order.email, metadata: { order_id: order.id } },
    { idempotencyKey: `${order.id}:customer:1` },
  );
  const { rows } = await pool().query<{ id: string }>(
    "select id from charges where order_id = $1 and step = 'checkout' and attempt = 1",
    [order.id],
  );
  const pi = await stripe().paymentIntents.create(
    {
      amount: MAIN_PRODUCT.amount_cents,
      currency: "usd",
      customer: customer.id,
      allowed_payment_method_types: ["card"],
      setup_future_usage: "off_session", // save the card for the one-click upsell
      description: `Order: ${MAIN_PRODUCT.name}`,
      metadata: { order_id: order.id, step: "checkout", charge_id: rows[0].id, attempt: "1" },
    },
    { idempotencyKey: idempotencyKey(order.id, "checkout") },
  );
  await pool().query(
    `update orders set stripe_customer_id = coalesce(stripe_customer_id, $2), updated_at = now() where id = $1`,
    [order.id, customer.id],
  );
  await pool().query(
    `update charges set stripe_payment_intent_id = $2, status = case when status = 'creating' then 'processing' else status end,
       updated_at = now() where id = $1`,
    [rows[0].id, pi.id],
  );
  return { orderId: order.id, clientSecret: pi.client_secret! };
}
