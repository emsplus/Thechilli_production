import { defineConfig } from "@playwright/test";

// Ports are overridable (E2E_API_PORT / E2E_WEB_PORT) so a second checkout or a busy machine can run the suite; defaults unchanged.
const API_PORT = process.env.E2E_API_PORT ?? "8120";
const WEB_PORT = process.env.E2E_WEB_PORT ?? "3120";
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  // A loaded machine needs more than the 5 s default: E2E_EXPECT_TIMEOUT=20000.
  expect: { timeout: Number(process.env.E2E_EXPECT_TIMEOUT ?? 15000) },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: WEB, serviceWorkers: "allow", trace: "retain-on-failure" },
  webServer: [
    {
      // Fresh schema through the real Alembic migrations, then the API.
      command:
        "sh e2e/start-api.sh",
      url: `${API}/api/v1/health`,
      reuseExistingServer: false,
      timeout: Number(process.env.E2E_API_START_TIMEOUT ?? 90_000), // raise on a loaded machine
    },
    { command: `pnpm exec next start -p ${WEB_PORT}`, url: `${WEB}/login`, reuseExistingServer: false, timeout: 60_000 },
  ],
});
