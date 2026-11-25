import { defineConfig } from "@playwright/test";

// Light-only checks that need no API: just the built web app (`next build && next start`). Usage: pnpm exec playwright test -c playwright.light.config.ts e2e/light-only.spec.ts
const WEB_PORT = process.env.E2E_WEB_PORT ?? "3120";
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${WEB_PORT}`, serviceWorkers: "block" },
  webServer: { command: `pnpm exec next start -p ${WEB_PORT}`, url: `http://localhost:${WEB_PORT}/login`, reuseExistingServer: false, timeout: 60_000 },
});
