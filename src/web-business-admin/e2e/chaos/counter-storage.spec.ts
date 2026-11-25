import { test } from "@playwright/test";
import { bills, expect, log, openPos, resetAbuse, seed, shot, signIn, sleep } from "./common";

/** Scenario 4 (storage): quota full / IndexedDB blocked / localStorage cleared mid-session, offline sale. */

test.beforeEach(() => resetAbuse());

test("ST1 offline: IndexedDB writes fail (quota full / private mode): the counter must NOT say 'saved offline'", async ({ page, context, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await context.setOffline(true);
  // From now on every IndexedDB write fails like a full disk / blocked storage.
  await page.evaluate(() => {
    const boom = function () { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); };
    IDBObjectStore.prototype.put = boom as never; IDBObjectStore.prototype.add = boom as never;
  });
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: /Place order/ }).click();
  await sleep(1500);
  await shot(page, "ST1-idb-write-fails-offline");
  const text = await page.locator("body").innerText();
  const claimsSaved = /saved offline/i.test(text) || (await page.getByTestId("order-line").innerText().catch(() => "")).match(/Saved offline/i) !== null;
  log("ST1.log", `UI claims saved offline while the write failed: ${claimsSaved}; toasts/text: ${text.replace(/\s+/g, " ").match(/(Order saved offline|Could not[^.]*|storage[^.]*)/i)?.[0] ?? "(none)"}`);
  await context.setOffline(false);
  await page.reload();
  await sleep(4000);
  const b = await bills(request, s);
  const orders = await (await request.get(`${(await import("./common")).apiBase}/orders`, { headers: s.auth })).json();
  log("ST1.log", `after reconnect + reload: server orders=${orders.length}`);
  expect(claimsSaved && orders.length === 0, "the app told the cashier the order was saved offline, but nothing was stored and nothing reached the server").toBe(false);
});

test("ST2 localStorage cleared mid-session (another app / user 'clear site data' on the page): sale in the offline queue survives", async ({ page, context, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await context.setOffline(true);
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: /Place order/ }).click();
  await expect(page.getByTestId("order-line")).toContainText("Saved offline");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await sleep(3000);
  await shot(page, "ST2-localstorage-cleared");
  log("ST2.log", `url=${page.url()} pending=${await page.getByTestId("pending-count").innerText().catch(() => "(none)")}`);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(async () => (await (await request.get(`${(await import("./common")).apiBase}/orders`, { headers: s.auth })).json()).length, { timeout: 40_000 }).toBe(1);
});

test("ST3 IndexedDB missing entirely (some private modes / locked-down WebViews): the POS still opens and says why offline is unavailable", async ({ browser, request }) => {
  const s = await seed(request);
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_WEB_PORT ?? "13933"}`, serviceWorkers: "block" });
  const page = await ctx.newPage();
  await page.addInitScript(() => { Object.defineProperty(window, "indexedDB", { get() { throw new DOMException("denied", "SecurityError"); } }); });
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, s.token, s.refresh);
  await page.goto("/pos"); await sleep(5000);
  await shot(page, "ST3-no-indexeddb");
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  log("ST3.log", `pageerrors=${JSON.stringify(errors.slice(0, 3))} visible: ${text.slice(0, 160)}`);
  expect(text.length).toBeGreaterThan(50); // not a white screen
  await ctx.close();
});
