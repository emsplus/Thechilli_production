import { test } from "@playwright/test";
import { API, bills, billsFull, dumpQueue, expect, log, openPos, payCash, resetAbuse, seed, shot, sleep, unsynced } from "./common";

/** Scenario 1 (business app counter): offline at each step of place -> KOT -> bill -> pay, lost responses, reload / kill. */
test.describe.configure({ mode: "serial" });
test.beforeEach(() => resetAbuse());
const place = (page: import("@playwright/test").Page) => page.getByRole("button", { name: /Place order/ }).click();

test("B1 online place, then offline at KOT, bill and pay: queue shows status, sync exactly once, correct totals", async ({ page, context, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: "increase" }).click();
  await place(page);
  await expect(page.getByRole("button", { name: /Send to kitchen/ })).toBeVisible();
  await context.setOffline(true);                                       // offline right after the order is placed
  await expect(page.getByTestId("conn")).toHaveText("Offline");
  await page.getByRole("button", { name: /Send to kitchen/ }).click();   // KOT offline
  await shot(page, "B1-1-kot-offline");
  await expect(page.getByRole("button", { name: "Make bill" })).toHaveCount(0); // online-only step is not offered offline
  await shot(page, "B1-2-bill-offline");
  await page.getByRole("button", { name: "Cash (offline)" }).click();     // settle offline: finalize + payment queued
  await expect(page.getByTestId("provisional")).toContainText("NOT A TAX INVOICE");
  await shot(page, "B1-3-settled-offline");
  const q = await dumpQueue(page);
  log("B1.log", `queue offline: ${JSON.stringify(q.map((o) => [o.type, o.status]))}`);
  await page.reload();                                                     // app restart while offline
  await expect(page.getByTestId("pending-count")).toBeVisible();
  expect((await bills(request, s)).length).toBe(0);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("pending-count")).toHaveCount(0, { timeout: 40_000 });
  const b = (await billsFull(request, s)) as any[];
  log("B1.log", `bills=${b.length} total=${b[0]?.total} payments=${b[0]?.payments.length} balance=${b[0]?.balance_due}`);
  expect(b).toHaveLength(1);
  expect(b[0].total).toBe("26.25");
  expect(b[0].payments).toHaveLength(1);
  expect(Number(b[0].balance_due)).toBe(0);
  const orders = await (await request.get(`${API}/orders?status=billed`, { headers: s.auth })).json();
  expect(orders.length).toBe(1);
  expect(orders[0].kots.length).toBe(1);
});

test("B2 lost responses: bill and payment reach the server but the answer never arrives; retry must not double bill or charge", async ({ page, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await place(page);
  await page.getByRole("button", { name: /Send to kitchen/ }).click();
  await expect(page.getByText(/Kitchen ticket #1 sent/).first()).toBeVisible();
  // 1) the bill is created but the response is lost
  let billCalls = 0;
  await page.route(/\/orders\/[^/]+\/bill$/, async (route) => { billCalls++; if (route.request().method() === "POST" && billCalls === 1) { await route.fetch(); await route.abort("connectionreset"); } else await route.continue(); });
  await page.getByRole("button", { name: "Make bill" }).click();
  await shot(page, "B2-1-bill-response-lost");
  log("B2.log", `after lost bill response: bills on server=${(await bills(request, s)).length}`);
  await page.getByRole("button", { name: "Make bill" }).click();       // the cashier taps again
  await sleep(1500);
  await shot(page, "B2-2-bill-retry");
  const afterRetry = (await billsFull(request, s)) as any[];
  log("B2.log", `after retry: bills=${afterRetry.map((b) => b.invoice_number + ":" + b.status)}`);
  // 2) pay: the payment is booked but the answer is lost
  let payCalls = 0;
  await page.route(/\/bills\/[^/]+\/payments$/, async (route) => { payCalls++; if (payCalls <= 2) { await route.fetch(); await route.abort("connectionreset"); } else await route.continue(); });
  const dialog = page.getByRole("dialog");
  if (await dialog.count()) { // bill_already_exists dialog: use the existing bill
    await shot(page, "B2-3-bill-exists-dialog");
    await dialog.getByRole("button").first().click().catch(() => {});
  }
  if (await page.getByRole("button", { name: "Pay cash" }).count()) await payCash(page);
  await sleep(2500);
  await shot(page, "B2-4-after-pay-lost");
  if (await page.getByRole("button", { name: "Pay cash" }).count()) { await payCash(page); await sleep(1500); }
  await expect.poll(async () => (await unsynced(page)).length, { timeout: 60_000 }).toBe(0);
  const b = ((await billsFull(request, s)) as any[]).filter((x) => x.status === "active");
  const paid = b.flatMap((x) => x.payments as { amount: string }[]).reduce((n, p) => n + Number(p.amount), 0);
  log("B2.log", `final: active bills=${b.length} invoice=${b.map((x) => x.invoice_number)} payments=${b.flatMap((x) => x.payments as unknown[]).length} paid=${paid} total=${b[0]?.total} payCalls=${payCalls}`);
  expect(b).toHaveLength(1);
  expect(Math.abs(paid - Number(b[0].total))).toBeLessThan(0.01);
});

test("B3 app killed mid-sync (context closed while the sync request is in flight) then reopened: nothing lost, nothing doubled", async ({ browser, request }) => {
  const s = await seed(request);
  const dir = `/private/tmp/claude-501/-Users-saurabh-Downloads-thechilli/041d269b-bfea-44d8-8ade-66aeb28a8068/scratchpad/chaos/profile-b3-${Date.now()}`;
  const { chromium } = await import("@playwright/test");
  let ctx = await chromium.launchPersistentContext(dir, { baseURL: `http://localhost:${process.env.E2E_WEB_PORT ?? "13933"}`, serviceWorkers: "allow" });
  let page = ctx.pages()[0] ?? (await ctx.newPage());
  await openPos(page, s.token);
  await ctx.setOffline(true);
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: /Place order/ }).click();
  await page.getByRole("button", { name: /Send to kitchen \(offline\)/ }).click();
  await page.getByRole("button", { name: "Cash (offline)" }).click();
  await expect(page.getByTestId("pending-count")).toHaveText("4 pending");
  // go online but hold the sync request: the server gets it, the app dies before the answer
  let held = 0;
  await page.route("**/sync/operations", async (route) => { held++; await route.fetch(); /* server applied it */ await sleep(60_000); });
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => held, { timeout: 20_000 }).toBeGreaterThan(0);
  await sleep(1000);
  const during = await dumpQueue(page);
  log("B3.log", `queue during held sync: ${JSON.stringify(during.map((o) => [o.type, o.status, o.attempts]))}`);
  await ctx.close();                                                       // app kill
  log("B3.log", `server bills right after kill: ${(await bills(request, s)).length}`);
  ctx = await chromium.launchPersistentContext(dir, { baseURL: `http://localhost:${process.env.E2E_WEB_PORT ?? "13933"}`, serviceWorkers: "allow" });
  page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("/pos");
  await expect(page.getByRole("button", { name: /Latte/ }).first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await unsynced(page)).length, { timeout: 60_000 }).toBe(0);
  const b = (await billsFull(request, s)) as any[];
  log("B3.log", `after reopen: bills=${b.length} payments=${b[0]?.payments.length} total=${b[0]?.total}`);
  expect(b).toHaveLength(1);
  expect(b[0].payments).toHaveLength(1);
  const orders = await (await request.get(`${API}/orders?status=billed`, { headers: s.auth })).json();
  expect(orders.length).toBe(1);
  expect(orders[0].kots.length).toBe(1);
  await ctx.close();
});

test("B5 bill made online, payment taken offline: after it syncs the ticket must not offer to pay again", async ({ page, context, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await place(page);
  await page.getByRole("button", { name: "Make bill" }).click();
  await expect(page.getByRole("button", { name: "Pay cash" })).toBeVisible();
  await context.setOffline(true);
  await page.getByRole("button", { name: "Pay cash" }).click();           // the connection dies on the payment tap: settles through the queue
  await expect(page.getByTestId("provisional")).toBeVisible({ timeout: 15_000 }).catch(() => {});
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(async () => (await unsynced(page)).length, { timeout: 40_000 }).toBe(0);
  await sleep(3000);
  await shot(page, "B5-paid-after-offline-sync");
  const payButtons = await page.getByRole("button", { name: /^(Pay cash|Cash|Card|UPI)$/ }).count();
  const b = (await billsFull(request, s)) as any[];
  log("B5.log", `payments on server=${b[0].payments.length} balance=${b[0].balance_due}; pay buttons still shown on the paid ticket: ${payButtons}`);
  expect(b[0].payments).toHaveLength(1);
  expect(payButtons, "a paid ticket still offers Cash / Card / UPI").toBe(0);
});
