import { describe, it, expect } from "vitest";
import { pool } from "@/lib/db";
import { chargeUpsell, abandonUpsell, upsellState } from "@/lib/upsell";
import { fake } from "./setup";
import { deliver, paidOrder, orderStatus, upsellCharges, events } from "./helpers";

describe("upsell failures and retries", () => {
  it("card declined -> upsell_failed, retryable, original order untouched", async () => {
    const id = await paidOrder("pm_decline");
    const r = await chargeUpsell(id);
    expect(r).toMatchObject({ state: "failed", retryable: true });
    expect(await orderStatus(id)).toBe("upsell_failed");
    const lines = await pool().query("select kind from line_items where order_id=$1", [id]);
    expect(lines.rows.map((l) => l.kind)).toEqual(["main"]);
  });

  it("retry after a decline is a NEW attempt with a NEW idempotency key; capped at 3", async () => {
    const id = await paidOrder("pm_decline");
    await chargeUpsell(id);
    await chargeUpsell(id);
    const third = await chargeUpsell(id);
    expect(third).toMatchObject({ state: "failed", retryable: false });
    const fourth = await chargeUpsell(id);
    expect(fourth.state).toBe("not_eligible");
    const cs = await upsellCharges(id);
    expect(cs.map((c) => c.idempotency_key)).toEqual([1, 2, 3].map((n) => `${id}:upsell:${n}`));
    expect(cs.every((c) => c.status === "failed")).toBe(true);
  });

  it("customer fixes their card, then retry succeeds", async () => {
    const id = await paidOrder("pm_decline");
    await chargeUpsell(id);
    await pool().query("update orders set payment_method_id='pm_ok' where id=$1", [id]);
    expect((await chargeUpsell(id)).state).toBe("paid");
    expect(await orderStatus(id)).toBe("upsell_paid");
    const flow = (await events(id)).map((e) => e.to_status);
    expect(flow).toEqual(["paid", "upsell_pending", "upsell_failed", "upsell_pending", "upsell_paid"]);
  });

  it("non-retryable decline (stolen_card) is not offered a retry", async () => {
    const id = await paidOrder("pm_stolen");
    const r = await chargeUpsell(id);
    expect(r).toMatchObject({ state: "failed", retryable: false });
    expect((await chargeUpsell(id)).state).toBe("not_eligible");
  });

  it("3DS required off-session -> requires_action with a client secret; webhook completes it", async () => {
    const id = await paidOrder("pm_auth");
    const r = await chargeUpsell(id);
    expect(r.state).toBe("requires_action");
    if (r.state !== "requires_action") throw new Error();
    expect(r.clientSecret).toMatch(/_secret_/);
    expect(r.paymentMethodId).toBe("pm_auth");
    expect(await orderStatus(id)).toBe("upsell_pending");
    // customer authenticates on-session in the browser; Stripe sends succeeded
    const [c] = await upsellCharges(id);
    await deliver("payment_intent.succeeded", fake.settle(c.stripe_payment_intent_id, "succeeded"));
    expect(await orderStatus(id)).toBe("upsell_paid");
  });

  it("3DS fails -> upsell_failed via webhook", async () => {
    const id = await paidOrder("pm_auth");
    await chargeUpsell(id);
    const [c] = await upsellCharges(id);
    await deliver("payment_intent.payment_failed", fake.settle(c.stripe_payment_intent_id, "requires_payment_method", {
      code: "payment_intent_authentication_failure", message: "auth failed",
    }));
    expect(await orderStatus(id)).toBe("upsell_failed");
    const s = await upsellState(id);
    expect(s).toMatchObject({ state: "failed", retryable: true });
  });

  it("customer skips 3DS -> PaymentIntent canceled, upsell_failed", async () => {
    const id = await paidOrder("pm_auth");
    await chargeUpsell(id);
    await abandonUpsell(id);
    expect(await orderStatus(id)).toBe("upsell_failed");
  });

  it("a late failure for an OLD attempt does not affect the newer attempt", async () => {
    const id = await paidOrder("pm_decline");
    await chargeUpsell(id); // attempt 1 fails
    await pool().query("update orders set payment_method_id='pm_auth' where id=$1", [id]);
    await chargeUpsell(id); // attempt 2 requires_action
    const [old] = await upsellCharges(id);
    await deliver("payment_intent.payment_failed", {
      ...fake.intents.get(old.stripe_payment_intent_id), status: "requires_payment_method",
      last_payment_error: { code: "card_declined", decline_code: "insufficient_funds" },
    });
    expect(await orderStatus(id)).toBe("upsell_pending");
  });
});
