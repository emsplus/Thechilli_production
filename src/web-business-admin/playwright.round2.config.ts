import { defineConfig } from "@playwright/test";

/** Round-2 counter fixes (docs/testing/FIX_ROUND2_COUNTER_REPORT.md). NO webServer: start pos-service and `next start` of this build yourself.
 *  E2E_API_PORT (default 19650) / E2E_WEB_PORT (19651); the build must use NEXT_PUBLIC_API_BASE_URL=http://localhost:<api>/api/v1. */
export default defineConfig({
  testDir: "./e2e/round2",
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${process.env.E2E_WEB_PORT ?? "19651"}`, serviceWorkers: "allow", trace: "off", actionTimeout: 15_000 },
});
