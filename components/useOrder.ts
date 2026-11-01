"use client";
import { useCallback, useEffect, useState } from "react";

export type UpsellState =
  | { state: "paid" } | { state: "processing" }
  | { state: "requires_action"; clientSecret: string; paymentMethodId: string }
  | { state: "failed"; message: string; retryable: boolean }
  | { state: "not_eligible"; reason: string };

export type OrderViewData = {
  order: { id: string; status: string; email: string; created_at: string };
  lineItems: { kind: string; sku: string; name: string; amount_cents: number; refunded: boolean }[];
  total: number;
  charges: { id: string; step: string; attempt: number; status: string; amount_cents: number; failure_code: string | null; stripe_payment_intent_id: string | null }[];
  events: { from_status: string | null; to_status: string; reason: string; source: string; created_at: string }[];
  upsell: UpsellState | null;
};

/** Polls the server while the order is in a transitional state. The server, driven by webhooks, is the source of truth. */
export function useOrder(orderId: string, shouldPoll: (v: OrderViewData | null) => boolean) {
  const [view, setView] = useState<OrderViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const res = await fetch(`/api/orders/${orderId}`, { cache: "no-store" });
    if (!res.ok) { setError(res.status === 404 ? "Order not found" : "Couldn't load order"); return null; }
    const v = (await res.json()) as OrderViewData;
    setView(v);
    return v;
  }, [orderId]);

  useEffect(() => {
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const v = await refresh().catch(() => null);
      if (!stop && shouldPoll(v)) t = setTimeout(tick, 1200);
    };
    tick();
    return () => { stop = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  return { view, error, refresh, setView };
}
