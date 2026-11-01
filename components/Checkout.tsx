"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { getStripeJs } from "@/lib/stripe-client";
import { MAIN_PRODUCT, fmt } from "@/lib/catalog";

export default function Checkout() {
  return (
    <Elements
      stripe={getStripeJs()}
      options={{
        mode: "payment",
        amount: MAIN_PRODUCT.amount_cents,
        currency: "usd",
        setupFutureUsage: "off_session",
        allowedPaymentMethodTypes: ["card"],
        appearance: { theme: "stripe", variables: { colorPrimary: "#2f5d46", borderRadius: "10px" } },
      }}
    >
      <CheckoutForm />
    </Elements>
  );
}

function CheckoutForm() {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  // One id per checkout session, created on first submit (never at render/prerender time, or
  // every visitor would share one). Resubmits reuse it, so the server returns the same order + PaymentIntent.
  const checkoutRef = useRef<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements || busy) return;
    setBusy(true);
    setError(null);
    checkoutRef.current ??= crypto.randomUUID();
    try {
      const { error: submitError } = await elements.submit();
      if (submitError) throw new Error(submitError.message);
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checkoutRef: checkoutRef.current, email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Checkout failed");
      const { error: confirmError } = await stripe.confirmPayment({
        elements,
        clientSecret: data.clientSecret,
        confirmParams: { return_url: `${window.location.origin}/upsell/${data.orderId}`, receipt_email: email },
        redirect: "if_required",
      });
      if (confirmError) throw new Error(confirmError.message);
      // The redirect doesn't mark anything paid. The next page waits for the webhook.
      router.push(`/upsell/${data.orderId}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card" data-testid="checkout-form">
      <h2>Payment</h2>
      <p className="muted" style={{ marginTop: 0 }}>Your card is saved securely with Stripe, so post-purchase offers are one click.</p>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
      </div>
      <div className="field">
        {/* Cards only: the server PaymentIntent only allows cards, and the upsell needs a saved card.
            Link's bank option would render here otherwise and then fail at confirm. */}
        <PaymentElement
          options={{
            layout: { type: "accordion", defaultCollapsed: false, radios: "never" },
            wallets: { link: "never", applePay: "never", googlePay: "never" },
          }}
        />
      </div>
      {error && <div className="notice err" role="alert" data-testid="checkout-error" style={{ marginBottom: 12 }}>{error}</div>}
      <button className="btn" disabled={!stripe || busy} data-testid="pay-button">
        {busy ? <><span className="spinner" />Processing…</> : `Pay ${fmt(MAIN_PRODUCT.amount_cents)}`}
      </button>
    </form>
  );
}
