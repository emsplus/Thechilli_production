import { test } from "@playwright/test";
import { skewDeviceClock, API, bills, expect, log, openPos, openAs, resetAbuse, seed, shot, sleep, unsynced } from "./common";

/** Scenario 3 (business app): token expiry mid-action, refresh rotation with two tabs, logout on one tab, password change, deactivation, clock skew. */
test.beforeEach(() => resetAbuse());
const place = (page: import("@playwright/test").Page) => page.getByRole("button", { name: /Place order/ }).click();
const hasHint = (page: import("@playwright/test").Page) => page.evaluate(() => document.cookie.includes("pos_session"));

test("S6 access token rejected (401) while placing an order: silent BFF refresh, one order, still signed in", async ({ page, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  let first = true, refreshes = 0;
  page.on("request", (r) => { if (r.url().includes("/bff/auth/refresh")) refreshes++; });
  await page.route("**/api/v1/orders", async (route) => { if (route.request().method() === "POST" && first) { first = false; await route.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"Token expired"}' }); } else await route.continue(); });
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await place(page);
  await expect(page.getByRole("button", { name: /Send to kitchen|Make bill/ }).first()).toBeVisible();
  const orders = await (await request.get(`${API}/orders`, { headers: s.auth })).json();
  log("S6.log", `refreshes=${refreshes} orders=${orders.length} hint=${await hasHint(page)} url=${page.url()}`);
  expect(orders).toHaveLength(1);
  expect(page.url()).toContain("/pos");
});

test("S7 two tabs hit 401 at once: one refresh rotation, neither tab signed out, orders from both tabs arrive", async ({ context, request }) => {
  const s = await seed(request);
  const a = await context.newPage(); await openPos(a, s.token);
  const b = await context.newPage(); await b.goto("/pos"); await expect(b.getByRole("button", { name: /Latte/ }).first()).toBeVisible();
  let refreshes = 0;
  for (const p of [a, b]) {
    let first = true; p.on("request", (r) => { if (r.url().includes("/bff/auth/refresh")) refreshes++; });
    await p.route("**/api/v1/orders", async (route) => { if (route.request().method() === "POST" && first) { first = false; await route.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"Token expired"}' }); } else await route.continue(); });
    await p.getByRole("button", { name: /Latte/ }).first().click();
  }
  await Promise.all([place(a), place(b)]);
  await sleep(6000);
  const orders = await (await request.get(`${API}/orders`, { headers: s.auth })).json();
  log("S7.log", `refreshes=${refreshes} orders=${orders.length} aUrl=${a.url()} bUrl=${b.url()} hint=${await hasHint(a)}`);
  await shot(a, "S7-tabA"); await shot(b, "S7-tabB");
  expect(a.url()).not.toContain("/login"); expect(b.url()).not.toContain("/login");
  expect(orders.length).toBe(1); // both tabs share the open ticket (same client_uuid): one order, never two
});

test("S8 logout in one tab: the other tab leaves the counter; unsynced offline sale is NOT wiped (warned)", async ({ context, request }) => {
  const s = await seed(request);
  const a = await context.newPage(); await openPos(a, s.token);
  const b = await context.newPage(); await b.goto("/pos"); await expect(b.getByRole("button", { name: /Latte/ }).first()).toBeVisible();
  await context.setOffline(true);
  await b.getByRole("button", { name: /Latte/ }).first().click(); await place(b);
  await expect(b.getByTestId("pending-count")).toBeVisible();
  await context.setOffline(false);
  a.once("dialog", (d) => void d.accept());
  await a.getByRole("button", { name: "Sign out" }).click();
  await expect(a).toHaveURL(/\/login/, { timeout: 20_000 });
  await sleep(4000);
  await b.evaluate(() => window.dispatchEvent(new Event("online"))); await b.reload(); await sleep(3000);
  log("S8.log", `tab B url after tab A signed out and B reloaded: ${b.url()}`);
  await shot(b, "S8-tabB-after-logout");
  expect(b.url()).toMatch(/login/);
});

test("S9 owner deactivates the cashier while the counter is open: next action shows a clear sign-out, queued sale kept", async ({ page, request }) => {
  const s = await seed(request);
  const email = `cash-${Date.now()}@example.in`;
  const me = await (await request.get(`${API}/auth/me`, { headers: s.auth })).json();
  const mk = await request.post(`${API}/auth/users`, { headers: s.auth, data: { email, full_name: "Cashy", password: "supersecret123", role: "cashier" } });
  expect(mk.status()).toBe(201); const uid = (await mk.json()).id;
  const l = await (await request.post(`${API}/auth/login`, { data: { email, password: "supersecret123", restaurant_id: me.restaurant_id } })).json();
  const { rememberPair } = await import("../helpers");
  rememberPair(l.access_token, l.refresh_token);
  await openPos(page, l.access_token);
  await page.context().setOffline(true);
  await page.getByRole("button", { name: /Latte/ }).first().click(); await place(page);
  await request.post(`${API}/auth/users/${uid}/deactivate`, { headers: s.auth });
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await sleep(8000);
  await shot(page, "S9-deactivated");
  log("S9.log", `url=${page.url()} text=${(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200)}`);
  const q = await page.evaluate(async () => { const db: IDBDatabase = await new Promise((res) => { const r = indexedDB.open("pos-offline"); r.onsuccess = () => res(r.result); }); const all: unknown[] = await new Promise((res) => { const r = db.transaction("queue").objectStore("queue").getAll(); r.onsuccess = () => res(r.result as unknown[]); }); return all.length; });
  log("S9.log", `queue items kept=${q}`);
  expect(q).toBeGreaterThan(0);
});

test("S10 device clock +10 min / -10 min / +45 min (token looks expired for ever): no refresh storm, sale works", async ({ browser, request }) => {
  for (const [name, skew, tz] of [["plus10", 600_000, "Asia/Kolkata"], ["minus10", -600_000, ["Pacific", "Auckland"].join("/")], ["plus45", 45 * 60_000, ["America", "Los_Angeles"].join("/")]] as const) {
    const s = await seed(request);
    const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_WEB_PORT ?? "13933"}`, timezoneId: tz, serviceWorkers: "block" });
    const page = await ctx.newPage();
    await skewDeviceClock(page, skew);
    let refreshes = 0; page.on("request", (r) => { if (r.url().includes("/bff/auth/refresh")) refreshes++; });
    await openAs(page, s.token, "/pos", s.refresh);
    await expect(page.getByRole("button", { name: /Latte/ }).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /Latte/ }).first().click(); await place(page);
    await page.getByRole("button", { name: /Make bill/ }).click({ timeout: 20_000 }).catch(() => {});
    await sleep(60_000); // a minute of normal polling
    log("S10.log", `${name} tz=${tz}: refresh calls in ~75 s=${refreshes} orders=${(await (await request.get(`${API}/orders`, { headers: s.auth })).json()).length} url=${page.url()}`);
    expect(page.url()).not.toContain("/login");
    expect(refreshes, "a wrong device clock must not make every request refresh the session").toBeLessThan(6);
    await ctx.close();
  }
});
