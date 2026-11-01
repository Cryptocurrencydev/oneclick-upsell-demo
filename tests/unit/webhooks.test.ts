import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@/lib/db";
import { handleStripeWebhook } from "@/lib/webhooks";
import { startCheckout } from "@/lib/checkout";
import { chargeUpsell } from "@/lib/upsell";
import { fake } from "./setup";
import { deliver, signedEvent, paidOrder, orderStatus, events, upsellCharges } from "./helpers";

async function pendingCheckout() {
  const { orderId } = await startCheckout(randomUUID(), "w@h.co");
  const ch = await pool().query("select stripe_payment_intent_id pi from charges where order_id=$1", [orderId]);
  return { orderId, piId: ch.rows[0].pi as string };
}

describe("stripe webhooks", () => {
  it("rejects a missing or forged signature and records nothing", async () => {
    const { orderId, piId } = await pendingCheckout();
    const { payload } = signedEvent("payment_intent.succeeded", fake.settle(piId, "succeeded"));
    expect((await handleStripeWebhook(payload, null)).status).toBe(400);
    const forged = `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`;
    expect((await handleStripeWebhook(payload, forged)).status).toBe(400);
    const tampered = signedEvent("payment_intent.succeeded", { ...fake.settle(piId, "succeeded") });
    expect((await handleStripeWebhook(tampered.payload.replace('"amount":2800', '"amount":1'), tampered.header)).status).toBe(400);
    expect(await orderStatus(orderId)).toBe("pending");
    expect((await pool().query("select count(*)::int n from stripe_events")).rows[0].n).toBe(0);
  });

  it("payment_intent.succeeded marks the order paid and saves the payment method", async () => {
    const { orderId, piId } = await pendingCheckout();
    const pi = fake.settle(piId, "succeeded");
    pi.payment_method = "pm_ok";
    const r = await deliver("payment_intent.succeeded", pi);
    expect(r.status).toBe(200);
    expect(await orderStatus(orderId)).toBe("paid");
    const o = await pool().query("select payment_method_id from orders where id=$1", [orderId]);
    expect(o.rows[0].payment_method_id).toBe("pm_ok");
    expect(await events(orderId)).toEqual([{ from_status: "pending", to_status: "paid", source: "webhook" }]);
  });

  it("a replayed event (same event id) is acknowledged and ignored", async () => {
    const { orderId, piId } = await pendingCheckout();
    const pi = fake.settle(piId, "succeeded");
    const first = await deliver("payment_intent.succeeded", pi, { id: "evt_replay_1" });
    const replays = await Promise.all([1, 2, 3].map(() => deliver("payment_intent.succeeded", pi, { id: "evt_replay_1" })));
    expect(first.body).toMatchObject({ outcome: "applied" });
    for (const r of replays) expect(r.body).toMatchObject({ received: true, duplicate: true });
    expect(await events(orderId)).toHaveLength(1);
    expect((await pool().query("select count(*)::int n from stripe_events")).rows[0].n).toBe(1);
  });

  it("out of order: a late payment_failed after succeeded can't undo the payment", async () => {
    const id = await paidOrder("pm_ok");
    await chargeUpsell(id);
    const [c] = await upsellCharges(id);
    const now = Math.floor(Date.now() / 1000);
    const succeeded = fake.settle(c.stripe_payment_intent_id, "succeeded");
    await deliver("payment_intent.succeeded", succeeded, { created: now + 10 });
    const failed = { ...succeeded, status: "requires_payment_method", last_payment_error: { code: "card_declined", decline_code: "generic_decline" } };
    const r = await deliver("payment_intent.payment_failed", failed, { created: now + 5 });
    expect(r.body.outcome).toBe("stale");
    expect(await orderStatus(id)).toBe("upsell_paid");
  });

  it("out of order: succeeded arriving BEFORE processing still ends paid", async () => {
    const { orderId, piId } = await pendingCheckout();
    const now = Math.floor(Date.now() / 1000);
    await deliver("payment_intent.succeeded", fake.settle(piId, "succeeded"), { created: now + 2 });
    await deliver("payment_intent.processing", { ...fake.settle(piId, "succeeded"), status: "processing" }, { created: now + 1 });
    expect(await orderStatus(orderId)).toBe("paid");
  });

  it("webhook for the upsell can arrive before our API stored the PaymentIntent id (matched via metadata)", async () => {
    const id = await paidOrder("pm_ok");
    // Simulate the race: charge row exists, but the PI id hasn't been written yet.
    const ins = await pool().query(
      "insert into charges (order_id, step, attempt, idempotency_key, amount_cents) values ($1,'upsell',1,$2,1400) returning id",
      [id, `${id}:upsell:1`],
    );
    await pool().query("update orders set status='upsell_pending' where id=$1", [id]);
    const pi = { id: "pi_race_1", object: "payment_intent", amount: 1400, currency: "usd", status: "succeeded",
      metadata: { order_id: id, step: "upsell", charge_id: ins.rows[0].id }, last_payment_error: null };
    const r = await deliver("payment_intent.succeeded", pi);
    expect(r.body.outcome).toBe("applied");
    expect(await orderStatus(id)).toBe("upsell_paid");
  });

  it("an amount mismatch never marks an order paid", async () => {
    const { orderId, piId } = await pendingCheckout();
    const r = await deliver("payment_intent.succeeded", { ...fake.settle(piId, "succeeded"), amount: 1 });
    expect(r.body.outcome).toBe("amount_mismatch");
    expect(await orderStatus(orderId)).toBe("pending");
  });

  it("if processing throws, the event is NOT marked processed, so Stripe's retry is applied", async () => {
    const { orderId, piId } = await pendingCheckout();
    const pi = fake.settle(piId, "succeeded");
    await pool().query("alter table order_events add constraint tmp_fail check (reason <> reason)");
    try {
      await expect(deliver("payment_intent.succeeded", pi, { id: "evt_retry_me" })).rejects.toThrow();
    } finally {
      await pool().query("alter table order_events drop constraint tmp_fail");
    }
    expect((await pool().query("select count(*)::int n from stripe_events")).rows[0].n).toBe(0);
    expect(await orderStatus(orderId)).toBe("pending");
    const retry = await deliver("payment_intent.succeeded", pi, { id: "evt_retry_me" });
    expect(retry.body.outcome).toBe("applied");
    expect(await orderStatus(orderId)).toBe("paid");
  });

  it("rejects live-mode events", async () => {
    const { payload, header } = signedEvent("payment_intent.succeeded", {});
    const live = payload.replace('"livemode":false', '"livemode":true');
    const s = new (await import("stripe")).default("sk_test_x");
    const h = s.webhooks.generateTestHeaderString({ payload: live, secret: process.env.STRIPE_WEBHOOK_SECRET! });
    expect(header).toBeTruthy();
    expect((await handleStripeWebhook(live, h)).status).toBe(400);
  });
});
