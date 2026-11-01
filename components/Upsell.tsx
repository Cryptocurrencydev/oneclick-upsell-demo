"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getStripeJs } from "@/lib/stripe-client";
import { UPSELL_PRODUCT, fmt } from "@/lib/catalog";
import { useOrder, type OrderViewData, type UpsellState } from "./useOrder";

const transitional = (v: OrderViewData | null) =>
  !v || v.order.status === "pending" || (v.order.status === "upsell_pending" && v.upsell?.state === "processing");

export default function Upsell({ orderId }: { orderId: string }) {
  const router = useRouter();
  const { view, error, refresh } = useOrder(orderId, transitional);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<UpsellState | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const inFlight = useRef(false); // UX guard only; the server enforces exactly-once

  const status = view?.order.status;
  const upsell = local ?? view?.upsell ?? null;

  useEffect(() => {
    if (status === "upsell_paid" || status === "refunded") router.replace(`/orders/${orderId}`);
  }, [status, orderId, router]);

  async function pollUntilSettled() {
    for (let i = 0; i < 40; i++) {
      const v = await refresh();
      if (v && !transitional(v)) { setLocal(null); return; }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async function accept() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setAuthError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/upsell`, { method: "POST" });
      const data = (await res.json()) as UpsellState;
      setLocal(data);
      if (data.state === "processing") await pollUntilSettled();
      else { await refresh(); setLocal(null); }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function authenticate(u: Extract<UpsellState, { state: "requires_action" }>) {
    setBusy(true);
    setAuthError(null);
    const stripe = await getStripeJs();
    const r = await stripe!.confirmCardPayment(u.clientSecret, { payment_method: u.paymentMethodId });
    if (r.error) setAuthError(r.error.message ?? "Authentication failed");
    await pollUntilSettled();
    setBusy(false);
  }

  async function abandon() {
    setBusy(true);
    await fetch(`/api/orders/${orderId}/upsell/abandon`, { method: "POST" });
    router.push(`/orders/${orderId}`);
  }

  if (error) return <div className="card"><div className="notice err">{error}</div></div>;
  if (!view || status === "pending")
    return (
      <div className="card" data-testid="confirming">
        <h1>Thank you!</h1>
        <p><span className="spinner" />Confirming your payment with the bank…</p>
        <p className="muted">This page updates when Stripe confirms the charge (via webhook), not when the browser redirects.</p>
      </div>
    );

  return (
    <div className="grid">
      <section className="card">
        <div className="notice ok" style={{ marginBottom: 14 }} data-testid="main-paid">Payment received. Your order is confirmed.</div>
        <h2>Order #{orderId.slice(0, 8)}</h2>
        {view.lineItems.map((li) => (
          <div className="row" key={li.kind}><span>{li.name}</span><span>{fmt(li.amount_cents)}</span></div>
        ))}
      </section>

      <section className="card offer" data-testid="upsell-offer">
        <span className="pill">One-time offer</span>
        <div className="product" style={{ margin: "14px 0" }}>
          <div className="swatch peony" aria-hidden />
          <div><strong>{UPSELL_PRODUCT.name}</strong><div className="muted">{UPSELL_PRODUCT.pitch}</div></div>
        </div>

        {status === "paid" && (
          <div className="stack">
            <button className="btn" onClick={accept} disabled={busy} data-testid="upsell-accept">
              {busy ? <><span className="spinner" />Adding…</> : `Add to my order (${fmt(UPSELL_PRODUCT.amount_cents)})`}
            </button>
            <button className="btn ghost" onClick={() => router.push(`/orders/${orderId}`)} disabled={busy} data-testid="upsell-decline">No thanks</button>
          </div>
        )}

        {status === "upsell_pending" && upsell?.state === "processing" && (
          <p data-testid="upsell-processing"><span className="spinner" />Charging your saved card…</p>
        )}

        {status === "upsell_pending" && upsell?.state === "requires_action" && (
          <div className="stack" data-testid="upsell-requires-action">
            <div className="notice warn">Your bank wants to confirm this {fmt(UPSELL_PRODUCT.amount_cents)} charge. You don&apos;t need to re-enter your card.</div>
            {authError && <div className="notice err">{authError}</div>}
            <button className="btn" onClick={() => authenticate(upsell)} disabled={busy} data-testid="upsell-authenticate">
              {busy ? <><span className="spinner" />Waiting for bank…</> : "Confirm with my bank"}
            </button>
            <button className="btn ghost" onClick={abandon} disabled={busy}>Skip the add-on</button>
          </div>
        )}

        {status === "upsell_failed" && upsell?.state === "failed" && (
          <div className="stack" data-testid="upsell-failed">
            <div className="notice err" role="alert">{upsell.message} You weren&apos;t charged for the add-on, and your original order is unaffected.</div>
            {upsell.retryable && (
              <button className="btn" onClick={accept} disabled={busy} data-testid="upsell-retry">Try again</button>
            )}
            <button className="btn ghost" onClick={() => router.push(`/orders/${orderId}`)} data-testid="upsell-continue">Continue without it</button>
          </div>
        )}

        {local?.state === "not_eligible" && <div className="notice warn">{local.reason}</div>}
      </section>
    </div>
  );
}
