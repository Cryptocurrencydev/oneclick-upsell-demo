import { describe, it, expect } from "vitest";
import { pool } from "@/lib/db";
import { chargeUpsell } from "@/lib/upsell";
import { refundUpsell } from "@/lib/refunds";
import { fake } from "./setup";
import { deliver, paidOrder, orderStatus } from "./helpers";
import { POST as refundRoute } from "@/app/api/admin/orders/[id]/refund-upsell/route";

describe("upsell refunds", () => {
  it("refunds ONLY the upsell amount and moves the order to refunded", async () => {
    const id = await paidOrder();
    await chargeUpsell(id);
    const r = await refundUpsell(id);
    expect(r).toMatchObject({ ok: true, status: "succeeded", alreadyRefunded: false });
    expect(await orderStatus(id)).toBe("refunded");
    const rf = await pool().query("select amount_cents from refunds");
    expect(rf.rows).toEqual([{ amount_cents: 1400 }]);
    const main = await pool().query("select status from charges where order_id=$1 and step='checkout'", [id]);
    expect(main.rows[0].status).toBe("succeeded");
  });

  it("is idempotent: 10 concurrent refund requests create ONE Stripe refund", async () => {
    const id = await paidOrder();
    await chargeUpsell(id);
    const rs = await Promise.all(Array.from({ length: 10 }, () => refundUpsell(id)));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(fake.refundsCreated).toBe(1);
    expect(new Set(rs.map((r) => r.ok && r.refundId)).size).toBe(1);
    expect((await pool().query("select count(*)::int n from refunds")).rows[0].n).toBe(1);
  });

  it("refusing to refund when there's no paid upsell", async () => {
    const id = await paidOrder();
    expect(await refundUpsell(id)).toMatchObject({ ok: false, status: 409 });
  });

  it("charge.refunded webhook after the admin refund is a no-op", async () => {
    const id = await paidOrder();
    await chargeUpsell(id);
    const r = await refundUpsell(id);
    if (!r.ok) throw new Error();
    const ch = await pool().query("select stripe_payment_intent_id pi from charges where order_id=$1 and step='upsell'", [id]);
    const res = await deliver("charge.refunded", { object: "charge", refunds: { data: [{ id: r.refundId, payment_intent: ch.rows[0].pi, status: "succeeded" }] } });
    expect(res.status).toBe(200);
    const evs = await pool().query("select count(*)::int n from order_events where order_id=$1 and to_status='refunded'", [id]);
    expect(evs.rows[0].n).toBe(1);
  });

  it("admin endpoint requires the bearer token", async () => {
    const id = await paidOrder();
    await chargeUpsell(id);
    const ctx = { params: Promise.resolve({ id }) } as never;
    const noAuth = await refundRoute(new Request("http://x", { method: "POST" }), ctx);
    expect(noAuth.status).toBe(401);
    const bad = await refundRoute(new Request("http://x", { method: "POST", headers: { authorization: "Bearer nope" } }), ctx);
    expect(bad.status).toBe(401);
    const ok = await refundRoute(new Request("http://x", { method: "POST", headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` } }), ctx);
    expect(ok.status).toBe(200);
    expect(await orderStatus(id)).toBe("refunded");
  });
});
