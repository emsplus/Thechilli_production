import { expect, test } from "@playwright/test";
import { payCash, API, bills, openPos, seed } from "./helpers";

test("online happy path: order, KOT, finalize, pay", async ({ page, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: "increase" }).click();
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: /Send to kitchen/ }).click();
  await expect(page.getByRole("button", { name: /Kitchen ticket #1 sent/ })).toBeVisible();
  await page.getByRole("button", { name: "Make bill" }).click();
  await expect(page.getByText(/INV[-/]\d{4}[-/]000001/)).toBeVisible();
  await payCash(page);
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible(); // only shown once balance is 0
  const b = await bills(request, s);
  expect(b).toHaveLength(1);
  expect(b[0].total).toBe("26.25");
  expect(Number(b[0].balance_due)).toBe(0);
});

test("offline sale survives reload and syncs exactly once on reconnect", async ({ page, context, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);

  await context.setOffline(true);
  await expect(page.getByTestId("conn")).toHaveText("Offline");

  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: "increase" }).click();
  await page.getByRole("button", { name: /Place order/ }).click();
  await expect(page.getByTestId("order-line")).toContainText("Saved offline");
  await page.getByRole("button", { name: /Send to kitchen \(offline\)/ }).click();
  await page.getByRole("button", { name: "Cash (offline)" }).click();

  const prov = page.getByTestId("provisional");
  await expect(prov).toContainText("NOT A TAX INVOICE");
  await expect(prov).toContainText("OFF-");
  await expect(prov).toContainText("26.25"); // 2 x 12.50 + 5% GST estimate
  await expect(page.getByTestId("pending-count")).toHaveText("4 pending");

  // App restart while offline: shell comes from the service worker, queue from IndexedDB.
  await page.reload();
  await expect(page.getByTestId("pending-count")).toHaveText("4 pending");
  await expect(page.getByTestId("stale-banner")).toBeVisible();
  expect(await bills(request, s)).toHaveLength(0); // nothing reached the server while offline

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("pending-count")).toHaveCount(0, { timeout: 30_000 });

  const b = await bills(request, s);
  expect(b).toHaveLength(1);
  expect(b[0].invoice_number).toMatch(/^INV\/\d{4}\/000001$/);
  expect(b[0].total).toBe("26.25");
  expect(Number(b[0].balance_due)).toBe(0);
  expect(b[0].payments).toHaveLength(1);

  // A second reload must not resend anything.
  await page.reload();
  await page.waitForTimeout(1500);
  expect(await bills(request, s)).toHaveLength(1);
});

test("price changed while offline becomes a conflict that a human resolves", async ({ page, context, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await context.setOffline(true);
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: /Place order/ }).click();
  await page.getByRole("button", { name: "Cash (offline)" }).click();
  await expect(page.getByTestId("provisional")).toBeVisible();

  // Manager raises the price from another device in the meantime.
  await request.put(`${API}/menu/items/${s.itemId}`, { headers: s.auth, data: { category_id: s.catId, name: "Latte", price: "15.00" } });

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByText(/need attention/)).toBeVisible({ timeout: 30_000 });
  expect(await bills(request, s)).toHaveLength(0);

  await page.goto("/sync");
  await expect(page.getByText(/price was 12.50 when taken, now 15.00/)).toBeVisible();
  await page.getByRole("button", { name: "Accept current prices" }).click();
  await expect.poll(async () => (await bills(request, s)).length, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => Number((await bills(request, s))[0].balance_due), { timeout: 30_000 }).toBe(0);
  await expect(page.getByText(/need attention/)).toHaveCount(0);

  const b = await bills(request, s);
  expect(b[0].total).toBe("15.75"); // server price 15.00 + 5% GST, not the stale 12.50
});

test("sign out warns before discarding unsynced sales", async ({ page, context, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await context.setOffline(true);
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: /Place order/ }).click();
  await expect(page.getByTestId("pending-count")).toBeVisible();

  let message = "";
  page.once("dialog", async (d) => { message = d.message(); await d.dismiss(); });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect.poll(() => message).toContain("have not synced");
  await expect(page).toHaveURL(/\/pos$/);                       // still signed in
  await expect(page.getByTestId("pending-count")).toBeVisible(); // queue intact

  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
});

test("response lost after the server applied the order does not create a duplicate", async ({ page, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);

  // The request reaches the server, but the browser never sees the response.
  await page.route("**/api/v1/orders", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch();
    await route.abort("connectionreset");
  });
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: /Place order/ }).click();
  await expect(page.getByTestId("order-line")).toContainText("Saved offline"); // fell back to the queue

  await page.unroute("**/api/v1/orders");
  // The queued order syncs (same client_uuid: the server returns the order it already has) and the ticket flips to its
  // server state with "Order sent (synced)" (audit C-12); the sale then finishes online.
  await expect(page.getByText("Order sent (synced)")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Make bill" }).click();
  await page.getByRole("button", { name: "Pay cash" }).click();
  await expect.poll(async () => (await bills(request, s)).length, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => Number((await bills(request, s))[0].balance_due), { timeout: 30_000 }).toBe(0);

  const orders = await (await request.get(`${API}/orders`, { headers: s.auth })).json();
  expect(orders).toHaveLength(1);
});
