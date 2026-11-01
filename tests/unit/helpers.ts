import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { pool } from "@/lib/db";
import { startCheckout } from "@/lib/checkout";
import { handleStripeWebhook } from "@/lib/webhooks";
import { fake } from "./setup";

const signer = new Stripe("sk_test_x");
let evSeq = 0;

export function signedEvent(type: string, object: unknown, opts: { id?: string; created?: number } = {}) {
  const event = {
    id: opts.id ?? `evt_${Date.now()}_${++evSeq}`,
    object: "event", type, livemode: false, api_version: "2026-01-01",
    created: opts.created ?? Math.floor(Date.now() / 1000),
    data: { object },
  };
  const payload = JSON.stringify(event);
  const header = signer.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
  return { payload, header, event };
}

export async function deliver(type: string, object: unknown, opts: { id?: string; created?: number } = {}) {
  const { payload, header, event } = signedEvent(type, object, opts);
  return { ...(await handleStripeWebhook(payload, header)), event };
}

/** Run a real checkout through startCheckout + a signed payment_intent.succeeded webhook. */
export async function paidOrder(pm = "pm_ok") {
  const { orderId } = await startCheckout(randomUUID(), "buyer@example.com");
  const ch = await pool().query("select stripe_payment_intent_id from charges where order_id=$1 and step='checkout'", [orderId]);
  const pi = fake.settle(ch.rows[0].stripe_payment_intent_id, "succeeded");
  pi.payment_method = pm;
  fake.intents.get(pi.id)!.payment_method = pm;
  const r = await deliver("payment_intent.succeeded", pi);
  if (r.status !== 200) throw new Error("webhook failed " + JSON.stringify(r.body));
  return orderId;
}

export const orderStatus = async (id: string) =>
  (await pool().query("select status from orders where id=$1", [id])).rows[0].status as string;
export const events = async (id: string) =>
  (await pool().query("select from_status, to_status, source from order_events where order_id=$1 order by id", [id])).rows;
export const upsellCharges = async (id: string) =>
  (await pool().query("select * from charges where order_id=$1 and step='upsell' order by attempt", [id])).rows;
