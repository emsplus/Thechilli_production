import { expect, test } from "@playwright/test";
import { API, openAs, seed, setKitchenMode } from "./helpers";

test("Manage > Overview Today strip shows real numbers for the owner: sales, open orders, unpaid bills, kitchen, stock", async ({ page, request }) => {
  const s = await seed(request);
  await setKitchenMode(request, s.auth, "track"); // the late-ticket tile belongs to the Preparing / Ready / Served workflow (KOT only has no late warnings)
  // one open order (not billed) and one unpaid bill
  const o1 = await (await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "takeaway", lines: [{ item_id: s.itemId, quantity: 1 }] } })).json();
  const o2 = await (await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "takeaway", lines: [{ item_id: s.itemId, quantity: 2 }] } })).json();
  expect((await request.post(`${API}/orders/${o2.id}/bill`, { headers: s.auth })).ok()).toBeTruthy();
  expect(o1.id).toBeTruthy();

  await openAs(page, s.token, "/today", s.refresh); // old link: redirects to Manage (Overview)
  await expect(page).toHaveURL(/\/manage$/);
  const tiles = page.getByTestId("today-tiles");
  // Today = today's calendar date (daily-sales / order-summary for from = to = today), not "since the last close".
  await expect(tiles.getByRole("link", { name: /Sales today/ })).toContainText("1 bill");
  await expect(tiles.getByRole("link", { name: /Orders today/ })).toContainText("2");
  await expect(tiles.getByRole("link", { name: /Open orders/ })).toContainText("1");
  await expect(tiles.getByRole("link", { name: /Unpaid bills/ })).toContainText("1");
  await expect(tiles.getByRole("link", { name: /Late kitchen tickets/ })).toContainText("0");
  await expect(tiles.getByRole("link", { name: /Low stock/ })).toBeVisible();
  expect(await tiles.getByRole("listitem").count()).toBeLessThanOrEqual(6);
  await tiles.getByRole("link", { name: /Late kitchen tickets/ }).click();
  await expect(page).toHaveURL(/\/kitchen$/);
});

test("No request storm: Manage Overview (Today strip) and /cash ask for the cash drawer once, not in a loop (404 = no drawer open)", async ({ page, request }) => {
  const s = await seed(request);
  const hits: string[] = [];
  page.on("request", (r) => { if (/\/cash-sessions(\/current|\?)/.test(r.url())) hits.push(r.url()); });
  // "No drawer open" is the normal state: no 404 response and no console error for it (UI_REVIEW BA-21).
  const notFound: string[] = []; const consoleErrors: string[] = [];
  page.on("response", (r) => { if (r.url().includes("/cash-sessions") && r.status() === 404) notFound.push(r.url()); });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  const all: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/v1/")) all.push(r.url()); });
  await openAs(page, s.token, "/manage", s.refresh);
  await expect(page.getByTestId("today-tiles")).toBeVisible();
  await page.waitForTimeout(3000);
  expect(hits.length, `cash-sessions/current requests on /manage: ${hits.length}`).toBeLessThanOrEqual(1);
  // Manage Overview (about 17 reads) now also carries the Today strip (x-report, kot, daily-sales, order-summary, cash drawer):
  // a fixed set, not a loop. A storm would be far above this.
  expect(all.length, `API requests on /manage in ~3 s: ${all.length}\n${all.map((u) => new URL(u).pathname).join("\n")}`).toBeLessThan(26);
  // The Cash page reuses the cached answer (same query, 30 s fresh): no new request when moving between them.
  await page.goto("/cash");
  await expect(page.getByText("No shift open")).toBeVisible();
  await page.waitForTimeout(3000);
  expect(hits.length, `cash-sessions/current requests after /cash: ${hits.length}`).toBeLessThanOrEqual(2);
  expect(notFound, "cash drawer 404s").toEqual([]);
  expect(consoleErrors.filter((e) => /cash-sessions|404/.test(e)), "console errors about the drawer").toEqual([]);
});

test("Today strip collapses and stays collapsed (remembered on this device); the sidebar has no Today item", async ({ page, request }) => {
  const s = await seed(request);
  await openAs(page, s.token, "/manage", s.refresh);
  await expect(page.getByTestId("today-tiles")).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Today", exact: true })).toHaveCount(0);
  await page.getByTestId("today-strip").getByRole("button", { name: "Hide" }).click();
  await expect(page.getByTestId("today-tiles")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("today-strip")).toBeVisible();
  await expect(page.getByTestId("today-tiles")).toHaveCount(0);
  await page.getByTestId("today-strip").getByRole("button", { name: "Show" }).click();
  await expect(page.getByTestId("today-tiles")).toBeVisible();
});
