import { defineConfig } from "@playwright/test";

// Specs that mock every API call (`*.mocked.spec.ts`): no pos-service, no database, no live stack. Needs a production build whose
// NEXT_PUBLIC_API_BASE_URL is MOCK_API (default http://localhost:8199/api/v1, nothing listens there):
//   NEXT_PUBLIC_API_BASE_URL=http://localhost:8199/api/v1 pnpm exec next build && pnpm exec playwright test -c playwright.mocked.config.ts
const WEB_PORT = process.env.E2E_MOCK_WEB_PORT ?? "3187";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.mocked\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: Number(process.env.E2E_EXPECT_TIMEOUT ?? 15000) },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${WEB_PORT}`, serviceWorkers: "block", trace: "retain-on-failure" },
  webServer: { command: `pnpm exec next start -p ${WEB_PORT}`, url: `http://localhost:${WEB_PORT}/login`, reuseExistingServer: false, timeout: 60_000 },
});
