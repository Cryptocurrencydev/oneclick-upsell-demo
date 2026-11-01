import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, afterAll } from "vitest";
import { pool } from "@/lib/db";
import { setStripeForTests } from "@/lib/stripe";
import { FakeStripe } from "./fake-stripe";

export const fake = new FakeStripe();

beforeAll(async () => {
  await pool().query(readFileSync("db/schema.sql", "utf8"));
});
beforeEach(async () => {
  await pool().query("truncate order_events, refunds, charges, line_items, orders, stripe_events cascade");
  fake.reset();
  setStripeForTests(fake);
});
afterAll(async () => {
  await pool().end();
  globalThis.__pgPool = undefined;
});
