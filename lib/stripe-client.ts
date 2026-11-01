"use client";
import { loadStripe, type Stripe } from "@stripe/stripe-js";

let p: Promise<Stripe | null> | undefined;
export const getStripeJs = () => (p ??= loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!, {
    // Hide Stripe's test-mode developer tools button (bottom-right) so the demo looks like a real storefront.
    developerTools: { assistant: { enabled: false } },
  }));
