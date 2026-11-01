import { test, expect } from "@playwright/test";
import { CARDS, cardFrame, checkout, complete3DS, db, stripe, stripeIntentsForOrder, waitForUpsellOffer } from "./helpers";

test("happy path: 4242 checkout -> one-click upsell -> single order with both line items", async ({ page }) => {
  await checkout(page, CARDS.success);
  const orderId = await waitForUpsellOffer(page);

  // order became `paid` because of the Stripe webhook, not the browser redirect
  const paid = await db("select source from order_events where order_id=$1 and to_status='paid'", [orderId]);
  expect(paid).toEqual([{ source: "webhook" }]);

  await page.getByTestId("upsell-accept").click();
  await page.waitForURL(`**/orders/${orderId}`);
  await expect(page.getByTestId("order-status")).toHaveText("upsell_paid");
  await expect(page.getByTestId("line-main")).toContainText("$28.00");
  await expect(page.getByTestId("line-upsell")).toContainText("$14.00");
  await expect(page.getByTestId("order-total")).toHaveText("$42.00");

  const intents = await stripeIntentsForOrder(orderId);
  expect(intents.filter((p) => p.status === "succeeded").map((p) => p.amount).sort()).toEqual([1400, 2800]);
  const upsell = intents.find((p) => p.metadata.step === "upsell")!;
  expect(upsell.payment_method).toBeTruthy(); // the saved card, charged off-session with no re-entry
});

test("double-click (plus 5 parallel POSTs) on the upsell button produces exactly ONE charge", async ({ page }) => {
  await checkout(page, CARDS.success);
  const orderId = await waitForUpsellOffer(page);

  const btn = page.getByTestId("upsell-accept");
  // Fire raw requests in parallel with a real double-click, bypassing any client-side disabling.
  const burst = page.evaluate((id) =>
    Promise.all(Array.from({ length: 5 }, () => fetch(`/api/orders/${id}/upsell`, { method: "POST" }).then((r) => r.status))), orderId);
  await btn.dblclick();
  expect((await burst).every((s) => s === 200)).toBe(true);

  await page.waitForURL(`**/orders/${orderId}`);
  await expect(page.getByTestId("order-status")).toHaveText("upsell_paid");

  const intents = await stripeIntentsForOrder(orderId);
  const upsells = intents.filter((p) => p.metadata.step === "upsell");
  expect(upsells).toHaveLength(1);
  expect(upsells[0].status).toBe("succeeded");
  expect(await db("select count(*)::int n from charges where order_id=$1 and step='upsell'", [orderId])).toEqual([{ n: 1 }]);
});

test("decline card at checkout shows the error; retrying with 4242 completes ONE order", async ({ page }) => {
  const email = await checkout(page, CARDS.decline);
  await expect(page.getByTestId("checkout-error")).toContainText(/declined/i);
  await expect(page).toHaveURL(/\/$/);

  await (await cardFrame(page)).locator('input[name="number"]').fill(CARDS.success);
  // Changing the card number resizes Stripe's iframe, which can move the Pay button between
  // Playwright's position check and the click. Retry until the submit actually starts (the error
  // clears). Re-clicking is safe: the app reuses the same checkoutRef -> same order + PaymentIntent.
  await expect(async () => {
    await page.getByTestId("pay-button").click();
    await expect(page.getByTestId("checkout-error")).toBeHidden({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  const orderId = await waitForUpsellOffer(page);

  const orders = await db("select id from orders where email=$1", [email]);
  expect(orders).toEqual([{ id: orderId }]); // the retry reused the same order + PaymentIntent
  const intents = await stripeIntentsForOrder(orderId);
  expect(intents).toHaveLength(1);
  expect(intents[0].status).toBe("succeeded");
});

test("upsell declined off-session: clean failure state, original order untouched", async ({ page }) => {
  await checkout(page, CARDS.success);
  const orderId = await waitForUpsellOffer(page);

  // Fixture: the saved card starts declining after checkout (Stripe test PM that attaches
  // fine but fails every charge), as if it was cancelled between purchase and upsell.
  const [o] = await db<{ stripe_customer_id: string }>("select stripe_customer_id from orders where id=$1", [orderId]);
  const pm = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: o.stripe_customer_id });
  await db("update orders set payment_method_id=$2 where id=$1", [orderId, pm.id]);

  await page.getByTestId("upsell-accept").click();
  await expect(page.getByTestId("upsell-failed")).toContainText(/declined/i);
  await expect(page.getByTestId("upsell-retry")).toBeVisible();
  await page.getByTestId("upsell-continue").click();

  await expect(page.getByTestId("order-status")).toHaveText("upsell_failed");
  await expect(page.getByTestId("line-upsell")).toHaveCount(0);
  await expect(page.getByTestId("order-total")).toHaveText("$28.00");
  const intents = await stripeIntentsForOrder(orderId);
  expect(intents.filter((p) => p.status === "succeeded").map((p) => p.amount)).toEqual([2800]);
});

test("3DS card: authenticate at checkout, then the off-session upsell asks the bank again", async ({ page }) => {
  await checkout(page, CARDS.threeDS);
  await complete3DS(page);
  const orderId = await waitForUpsellOffer(page);

  await page.getByTestId("upsell-accept").click();
  await expect(page.getByTestId("upsell-requires-action")).toBeVisible();
  await page.getByTestId("upsell-authenticate").click();
  await complete3DS(page);

  await page.waitForURL(`**/orders/${orderId}`);
  await expect(page.getByTestId("order-status")).toHaveText("upsell_paid");
  const intents = await stripeIntentsForOrder(orderId);
  expect(intents.filter((p) => p.status === "succeeded").map((p) => p.amount).sort()).toEqual([1400, 2800]);
  expect(intents.filter((p) => p.metadata.step === "upsell")).toHaveLength(1);
});

test("admin refunds the upsell only; pressing refund twice issues ONE refund", async ({ page }) => {
  await checkout(page, CARDS.success);
  const orderId = await waitForUpsellOffer(page);
  await page.getByTestId("upsell-accept").click();
  await page.waitForURL(`**/orders/${orderId}`);
  await expect(page.getByTestId("order-status")).toHaveText("upsell_paid");

  await page.goto("/admin");
  await page.getByLabel("Admin token").fill(process.env.ADMIN_TOKEN!);
  await page.getByRole("button", { name: "Load" }).click();
  const row = page.getByTestId(`admin-row-${orderId}`);
  await row.getByTestId("refund-upsell").click();
  await expect(page.getByTestId("admin-msg")).toContainText("Refunded upsell");
  await row.getByTestId("refund-upsell").click();
  await expect(page.getByTestId("admin-msg")).toContainText("Already refunded");

  const intents = await stripeIntentsForOrder(orderId);
  const upsell = intents.find((p) => p.metadata.step === "upsell")!;
  const main = intents.find((p) => p.metadata.step === "checkout")!;
  expect((await stripe.refunds.list({ payment_intent: upsell.id })).data.map((r) => r.amount)).toEqual([1400]);
  expect((await stripe.refunds.list({ payment_intent: main.id })).data).toHaveLength(0);
  await page.goto(`/orders/${orderId}`);
  await expect(page.getByTestId("order-status")).toHaveText("refunded");
  await expect(page.getByTestId("order-total")).toHaveText("$28.00");
});
