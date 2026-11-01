import { describe, it, expect } from "vitest";
import { pool, tx } from "@/lib/db";
import { canTransition, transition, IllegalTransition, STATUSES, TRANSITIONS } from "@/lib/state-machine";

async function newOrder(status = "pending") {
  const { rows } = await pool().query(
    "insert into orders (checkout_ref, email, status) values (gen_random_uuid()::text, 'a@b.co', $1) returning id",
    [status],
  );
  return rows[0].id as string;
}

describe("order state machine", () => {
  it("only allows the documented edges", () => {
    const allowed = STATUSES.flatMap((f) => STATUSES.filter((t) => canTransition(f, t)).map((t) => `${f}->${t}`));
    expect(allowed.sort()).toEqual(
      ["pending->paid", "paid->upsell_pending", "upsell_pending->upsell_paid", "upsell_pending->upsell_failed",
       "upsell_failed->upsell_pending", "upsell_paid->refunded"].sort(),
    );
    expect(TRANSITIONS.refunded).toEqual([]);
  });

  it("walks the happy path and logs every transition in order_events", async () => {
    const id = await newOrder();
    for (const to of ["paid", "upsell_pending", "upsell_paid", "refunded"] as const)
      await tx((c) => transition(c, id, to, { source: "api", reason: `to ${to}` }));
    const { rows } = await pool().query("select from_status, to_status from order_events where order_id=$1 order by id", [id]);
    expect(rows).toEqual([
      { from_status: "pending", to_status: "paid" },
      { from_status: "paid", to_status: "upsell_pending" },
      { from_status: "upsell_pending", to_status: "upsell_paid" },
      { from_status: "upsell_paid", to_status: "refunded" },
    ]);
  });

  it("rejects illegal transitions and writes nothing", async () => {
    const id = await newOrder();
    await expect(tx((c) => transition(c, id, "upsell_paid", { source: "api", reason: "skip" }))).rejects.toBeInstanceOf(IllegalTransition);
    await expect(tx((c) => transition(c, id, "refunded", { source: "api", reason: "x" }))).rejects.toThrow(/pending -> refunded/);
    const s = await pool().query("select status, (select count(*) from order_events where order_id=$1)::int n from orders where id=$1", [id]);
    expect(s.rows[0]).toEqual({ status: "pending", n: 0 });
  });

  it("same-state transition is an idempotent no-op (no duplicate log row)", async () => {
    const id = await newOrder();
    const a = await tx((c) => transition(c, id, "paid", { source: "webhook", reason: "1" }));
    const b = await tx((c) => transition(c, id, "paid", { source: "webhook", reason: "2" }));
    expect([a.changed, b.changed]).toEqual([true, false]);
    const n = await pool().query("select count(*)::int n from order_events where order_id=$1", [id]);
    expect(n.rows[0].n).toBe(1);
  });

  it("allowStale ignores out-of-order edges instead of throwing (used by webhooks)", async () => {
    const id = await newOrder("refunded");
    const r = await tx((c) => transition(c, id, "upsell_failed", { source: "webhook", reason: "late", allowStale: true }));
    expect(r.changed).toBe(false);
    expect((await pool().query("select status from orders where id=$1", [id])).rows[0].status).toBe("refunded");
  });

  it("concurrent transitions are serialized by the row lock (exactly one wins)", async () => {
    const id = await newOrder("paid");
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => tx((c) => transition(c, id, "upsell_pending", { source: "api", reason: "race" }))),
    );
    const changed = results.filter((r) => r.status === "fulfilled" && r.value.changed).length;
    expect(changed).toBe(1);
  });

  it("DB rejects an unknown status even if app code is bypassed", async () => {
    const id = await newOrder();
    await expect(pool().query("update orders set status='shipped' where id=$1", [id])).rejects.toThrow(/invalid input value for enum/);
  });
});
