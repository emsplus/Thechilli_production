import { test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { expect, log, openPos, resetAbuse, seed, shot, sleep, signIn } from "./common";

/**
 * Scenario 4 (counter PWA): deploy while a ticket with items exists; old chunks 404 after a new build is served.
 * Prepare: e2e/chaos/life-setup.sh <worktree> <scratch>/ba-life src/app/reports/page.tsx 'Sales, items, purchases and profit' 'Sales, items, purchases and profit (v2)'
 * Env: LIFE_DIR, LIFE_PORT (13935).
 */
const DIR = process.env.LIFE_DIR!; const PORT = process.env.LIFE_PORT ?? "13935";
const sh = (v: "A" | "B") => execFileSync("/Users/saurabh/Downloads/thechilli/_wt/r2-ba-qa2/e2e/chaos/life-server.sh", [DIR, v, PORT], { stdio: "pipe" }).toString();
test.use({ baseURL: `http://localhost:${PORT}` });
test.describe.configure({ mode: "serial" });
test.beforeAll(() => { sh("A"); });
test.afterAll(() => { try { execFileSync("pkill", ["-f", `next start -p ${PORT}`]); } catch { /* none */ } });
test.beforeEach(() => resetAbuse());

test("L3 deploy while a ticket with items is open (and one queued offline sale): both survive the new build + new service worker", async ({ page, context, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: "increase" }).click();
  await context.setOffline(true);
  await page.getByRole("button", { name: /Place order/ }).click();
  await expect(page.getByTestId("order-line")).toContainText("Saved offline");
  await page.getByRole("button", { name: "Open another order" }).click().catch(() => {});
  await page.getByRole("button", { name: /Latte/ }).first().click();           // a second, unplaced draft
  await sleep(1500);
  await context.setOffline(false);
  sh("B");
  await page.reload(); await sleep(5000);
  await shot(page, "L3-after-deploy");
  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  log("L3.log", `url=${page.url()} text=${body.slice(0, 200)}`);
  await expect(page.getByRole("button", { name: /Latte/ }).first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await (await request.get(`${process.env.E2E_API_BASE ?? "http://127.0.0.1:18931/api/v1"}/orders`, { headers: s.auth })).json()).length, { timeout: 60_000 }).toBe(1);
  const tabs = await page.getByRole("tab").count();
  log("L3.log", `open ticket tabs after deploy=${tabs}`);
  expect(tabs).toBeGreaterThanOrEqual(2); // placed order ticket + unplaced draft both still there
});

test("L4 old tab open, server moved to a new build: navigating to a not-yet-loaded page (chunk 404) recovers, no white screen", async ({ browser, request }) => {
  sh("A");
  const s = await seed(request);
  const ctx = await browser.newContext({ baseURL: `http://localhost:${PORT}`, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errs: string[] = []; page.on("pageerror", (e) => errs.push(e.message));
  const nf: string[] = []; page.on("response", (r) => { if (r.status() === 404 && r.url().includes("/_next/")) nf.push(r.url().split("/").slice(-1)[0]); });
  await signIn(page, s.token, s.refresh);
  await page.goto("/pos"); await expect(page.getByRole("button", { name: /Latte/ }).first()).toBeVisible({ timeout: 30_000 });
  sh("B");
  await page.getByRole("complementary", { name: "Primary" }).getByRole("link", { name: "Manage", exact: true }).click(); // Reports is inside Manage now
  await page.getByRole("navigation", { name: "Manage sections" }).getByRole("link", { name: "Reports", exact: true }).click();
  await sleep(7000);
  await shot(page, "L4-stale-chunk-navigation");
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
  log("L4.log", `url=${page.url()} 404 chunks=${JSON.stringify(nf.slice(0, 4))} pageerrors=${JSON.stringify(errs.slice(0, 3))} visible: ${text.slice(0, 200) || "(EMPTY: white screen)"}`);
  expect(text.length, "white screen").toBeGreaterThan(30);
  await ctx.close();
});
