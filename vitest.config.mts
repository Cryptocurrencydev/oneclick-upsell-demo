import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    setupFiles: ["tests/unit/setup.ts"],
    fileParallelism: false, // tests share one Postgres database
    testTimeout: 20_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:54329/upsell_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test_unit_secret",
      ADMIN_TOKEN: "unit-test-admin-token-123456",
      PG_POOL_MAX: "30",
    },
  },
});
