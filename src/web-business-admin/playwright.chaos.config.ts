import { defineConfig } from "@playwright/test";

/** Break/chaos suite for the counter app (docs/testing/BREAK_CHAOS_REPORT.md). NO webServer: start pos-service, `next start` of this build yourself.
 *  E2E_WEB_PORT (13933), E2E_API_BASE (http://127.0.0.1:18931/api/v1), POS_API_URL for the BFF. */
const WEB = `http://localhost:${process.env.E2E_WEB_PORT ?? "13933"}`;
export default defineConfig({
  testDir: "./e2e/chaos",
  testMatch: /.*\.spec\.ts/,
  timeout: 900_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: WEB, serviceWorkers: "allow", trace: "off", actionTimeout: 15_000 },
});
