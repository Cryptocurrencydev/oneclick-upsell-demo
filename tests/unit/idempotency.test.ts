import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@/lib/db";
import { chargeUpsell } from "@/lib/upsell";
import { startCheckout } from "@/lib/checkout";
import { reconcileOrder } from "@/lib/orders";
import { fake } from "./setup";
import { paidOrder, orderStatus, upsellCharges } from "./helpers";

describe("idempotency: no double charges", () => {
  it("20 concurrent upsell clicks produce exactly ONE PaymentIntent and one charge row", async () => {
    const id = await paidOrder("pm_ok");
    const results = await Promise.all(Array.from({ length: 20 }, () => chargeUpsell(id)));
    const upsells = fake.createdIntents((p) => p.metadata.step === "upsell");
    expect(upsells).toHaveLength(1);
    expect(await upsellCharges(id)).toHaveLength(1);
    expect(await orderStatus(id)).toBe("upsell_paid");
    expect(results.every((r) => r.state === "paid" || r.state === "processing")).toBe(true);
  });

  it("forced race: 20 clicks pile up behind a held row lock, released at once -> ONE charge, no errors", async () => {
    const id = await paidOrder("pm_ok");
    const blocker = await pool().connect();
    await blocker.query("begin");
    await blocker.query("select 1 from orders where id=$1 for update", [id]);
    await blocker.query("update orders set updated_at = now() where id=$1", [id]);
    const clicks = Array.from({ length: 20 }, () => chargeUpsell(id));
    await new Promise((r) => setTimeout(r, 300)); // let every request reach the database and queue up
    await blocker.query("commit");
    blocker.release();
    const results = await Promise.allSettled(clicks);
    const errors = results.filter((r) => r.status === "rejected");
    expect(errors).toHaveLength(0);
    expect(fake.createdIntents((p) => p.metadata.step === "upsell")).toHaveLength(1);
    expect(await upsellCharges(id)).toHaveLength(1);
    expect(await orderStatus(id)).toBe("upsell_paid");
  });

  it("clicking again after success (refresh, back button) never charges again", async () => {
    const id = await paidOrder();
    await chargeUpsell(id);
    const again = await chargeUpsell(id);
    expect(again.state).toBe("paid");
    expect(fake.createdIntents((p) => p.metadata.step === "upsell")).toHaveLength(1);
  });

  it("the Stripe idempotency key is derived from order id + step + attempt", async () => {
    const id = await paidOrder();
    await chargeUpsell(id);
    const [c] = await upsellCharges(id);
    expect(c.idempotency_key).toBe(`${id}:upsell:1`);
    const co = await pool().query("select idempotency_key from charges where order_id=$1 and step='checkout'", [id]);
    expect(co.rows[0].idempotency_key).toBe(`${id}:checkout:1`);
  });

  it("DB enforces: two live upsell charges for one order are impossible", async () => {
    const id = await paidOrder();
    await pool().query("insert into charges (order_id, step, attempt, idempotency_key, amount_cents) values ($1,'upsell',1,$2,1400)", [id, `${id}:upsell:1`]);
    await expect(
      pool().query("insert into charges (order_id, step, attempt, idempotency_key, amount_cents) values ($1,'upsell',2,$2,1400)", [id, `${id}:upsell:2`]),
    ).rejects.toThrow(/one_live_charge_per_step/);
  });

  it("DB enforces: idempotency keys are unique and must match order/step/attempt", async () => {
    const id = await paidOrder();
    await expect(
      pool().query("insert into charges (order_id, step, attempt, idempotency_key, amount_cents) values ($1,'upsell',1,'made-up-key',1400)", [id]),
    ).rejects.toThrow(/idem_key_shape/);
  });

  it("lost response (Stripe charged, network died) is retried with the SAME key: one charge", async () => {
    const id = await paidOrder("pm_flaky");
    const r = await chargeUpsell(id);
    expect(r.state).toBe("paid");
    expect(fake.createCalls).toBeGreaterThanOrEqual(2); // first call + retry
    expect(fake.createdIntents((p) => p.metadata.step === "upsell")).toHaveLength(1);
  });

  it("if every retry fails the attempt stays 'creating'; reconciliation finishes it with the same key", async () => {
    const id = await paidOrder("pm_ok");
    fake.failNextNetwork = 3;
    const r = await chargeUpsell(id);
    expect(r.state).toBe("processing");
    expect(await orderStatus(id)).toBe("upsell_pending");
    await reconcileOrder(id, 0);
    expect(await orderStatus(id)).toBe("upsell_paid");
    expect(fake.createdIntents((p) => p.metadata.step === "upsell")).toHaveLength(1);
  });

  it("double-submitted checkout maps to one order and one PaymentIntent", async () => {
    const ref = randomUUID();
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => startCheckout(ref, "x@y.co")));
    expect(new Set([a.orderId, b.orderId, c.orderId]).size).toBe(1);
    expect(new Set([a.clientSecret, b.clientSecret, c.clientSecret]).size).toBe(1);
    expect(fake.createdIntents((p) => p.metadata.step === "checkout")).toHaveLength(1);
    const n = await pool().query("select count(*)::int n from orders");
    expect(n.rows[0].n).toBe(1);
  });

  it("upsell is refused before the first payment is confirmed by Stripe", async () => {
    const { orderId } = await startCheckout(randomUUID(), "x@y.co");
    const r = await chargeUpsell(orderId);
    expect(r.state).toBe("not_eligible");
    expect(fake.createdIntents((p) => p.metadata.step === "upsell")).toHaveLength(0);
  });
});
