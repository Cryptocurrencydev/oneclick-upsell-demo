import { handleStripeWebhook } from "@/lib/webhooks";

export async function POST(req: Request) {
  const raw = await req.text(); // raw body is required for signature verification
  try {
    const r = await handleStripeWebhook(raw, req.headers.get("stripe-signature"));
    return Response.json(r.body, { status: r.status });
  } catch (e) {
    console.error("[webhook] processing failed, Stripe will retry", e);
    return Response.json({ error: "processing failed" }, { status: 500 });
  }
}
