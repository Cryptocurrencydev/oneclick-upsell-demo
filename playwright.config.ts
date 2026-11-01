import { defineConfig, devices } from "@playwright/test";

// Run via `npm run test:e2e` (scripts/e2e.sh), which starts the app + `stripe listen`.
// Or set E2E_BASE_URL to run against a deployed URL.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
});
