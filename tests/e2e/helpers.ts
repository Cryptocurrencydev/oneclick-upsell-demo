import { expect, type Page, type Frame } from "@playwright/test";
import Stripe from "stripe";
import { Client } from "pg";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) throw new Error("e2e requires a TEST secret key");

export const CARDS = {
  success: "4242424242424242",
  decline: "4000000000000002",
  threeDS: "4000002760003184", // always requires authentication, on-session AND off-session
};

export async function db<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required for e2e DB assertions");
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: /neon\.tech|sslmode=require/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined });
  await c.connect();
  try { return (await c.query(sql, params)).rows as T[]; } finally { await c.end(); }
}

/** Stripe renders several frames titled "Secure payment input frame"; return the one holding the card form. */
export async function cardFrame(page: Page) {
  const frames = page.locator('iframe[title="Secure payment input frame"]');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const n = await frames.count();
    for (let i = 0; i < n; i++) {
      const fl = frames.nth(i).contentFrame();
      if (await fl.locator('input[name="number"]').count().catch(() => 0)) return fl;
    }
    // Collapsed accordion: open the Card item, then look again.
    for (let i = 0; i < n; i++) await frames.nth(i).contentFrame().getByText("Card", { exact: true }).click({ timeout: 500 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  throw new Error("card number field never rendered in the Payment Element");
}

export async function fillCard(page: Page, number: string) {
  const f = await cardFrame(page);
  await f.locator('input[name="number"]').fill(number);
  await f.locator('input[name="expiry"]').fill("12 / 34");
  await f.locator('input[name="cvc"]').fill("123");
  const zip = f.locator('input[name="postalCode"]');
  if (await zip.isVisible().catch(() => false)) await zip.fill("94107");
}

export async function checkout(page: Page, card: string, email = `e2e+${crypto.randomUUID()}@example.com`) {
  await page.goto("/");
  await page.fill("#email", email);
  await fillCard(page, card);
  await page.getByTestId("pay-button").click();
  return email;
}

/**
 * Stripe's test-mode 3DS2 challenge lives in nested iframes (testmode-acs.stripe.com).
 * A click that lands before the page wires its handlers is silently dropped, so wait for
 * visibility, click, and click again if the challenge is still open.
 */
export async function complete3DS(page: Page, action: "authorize" | "fail" = "authorize") {
  const sel = action === "authorize" ? "#test-source-authorize-3ds" : "#test-source-fail-3ds";
  const deadline = Date.now() + 60_000;
  let clicked = false;
  while (Date.now() < deadline) {
    const fr = page.frames().find((f) => f.url().includes("3d_secure_2_test") || f.url().includes("testmode-acs"));
    const btn = fr?.locator(sel);
    if (btn && (await btn.isVisible().catch(() => false))) {
      await page.waitForTimeout(1000);
      await btn.click().catch(() => {});
      clicked = true;
      await page.waitForTimeout(3000);
      continue; // loop re-checks: if the frame is gone, we're done
    }
    if (clicked) return;
    await page.waitForTimeout(500);
  }
  if (!clicked) throw new Error("3DS challenge frame never appeared");
}

export const orderIdFromUrl = (url: string) => url.match(/[0-9a-f-]{36}/)![0];

export async function waitForUpsellOffer(page: Page) {
  await page.waitForURL(/\/upsell\/[0-9a-f-]{36}/);
  await expect(page.getByTestId("upsell-accept")).toBeVisible(); // only rendered once the webhook marked the order paid
  return orderIdFromUrl(page.url());
}

/** Ground truth from Stripe itself: every PaymentIntent for this order's customer. */
export async function stripeIntentsForOrder(orderId: string) {
  const [o] = await db<{ stripe_customer_id: string }>("select stripe_customer_id from orders where id=$1", [orderId]);
  const list = await stripe.paymentIntents.list({ customer: o.stripe_customer_id, limit: 100 });
  return list.data;
}
