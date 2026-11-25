import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { API, openAs, seed, type Seed } from "./helpers";

async function order(request: APIRequestContext, s: Seed, tableId: string, kot = false) {
  const r = await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "indoor", table_id: tableId, lines: [{ item_id: s.itemId, quantity: 2 }] } });
  expect(r.status()).toBe(201);
  const o = await r.json();
  if (kot) expect((await request.post(`${API}/orders/${o.id}/kot`, { headers: s.auth })).status()).toBe(201);
  return o as { id: string };
}
const mkTable = async (request: APIRequestContext, s: Seed, label: string, seats: number, area: "indoor" | "outdoor") => {
  const r = await request.post(`${API}/tables`, { headers: s.auth, data: { label, seats, area } });
  expect(r.status()).toBe(201);
  return (await r.json()) as { id: string };
};

test("floor plan shows each table's live status from the server and refreshes on reload", async ({ page, request }) => {
  const s = await seed(request);
  const t2 = await mkTable(request, s, "T2", 2, "outdoor");
  await mkTable(request, s, "T3", 6, "indoor");
  await order(request, s, s.tableId);
  await openAs(page, s.token, "/manage?tab=tables", s.refresh);
  const tile = (l: string) => page.getByRole("button", { name: new RegExp(`^Table ${l},`) });
  await expect(tile("T1")).toHaveAccessibleName(/^Table T1, 4 seats, Order open, .*\d/); // the visible open total is in the name too (Label in Name)
  await expect(tile("T2")).toHaveAccessibleName("Table T2, 2 seats, Free");
  await expect(tile("T3")).toHaveAccessibleName("Table T3, 6 seats, Free");
  await expect(page.getByTestId("table-counts")).toHaveText("2 free · 1 open · 0 with kitchen");
  await expect(page.getByRole("region", { name: "Outdoor tables" }).getByRole("button", { name: /T2/ })).toBeVisible();

  await order(request, s, t2.id, true);
  await page.reload();
  await expect(tile("T2")).toHaveAccessibleName(/^Table T2, 2 seats, With kitchen(, .*\d)?(, Taken by O)?$/); // who took it (GET /tables/status waiter_name)
  await expect(page.getByTestId("table-counts")).toHaveText("1 free · 1 open · 1 with kitchen");

  // Tap a table: details with the unbilled amount, no drag involved
  await tile("T1").click();
  const sheet = page.getByRole("dialog", { name: "Table T1" });
  await expect(sheet).toContainText("1 order, 1 line");
  await expect(sheet).toContainText("not yet billed");
  await expect(sheet.getByRole("link", { name: /Open Chilli Agent/ })).toBeVisible();
});

test("filter by status and area, list view sorts, CSV export", async ({ page, request }) => {
  const s = await seed(request);
  await mkTable(request, s, "T2", 2, "outdoor");
  await mkTable(request, s, "T10", 8, "indoor");
  await order(request, s, s.tableId);
  await openAs(page, s.token, "/manage?tab=tables", s.refresh);
  await expect(page.getByRole("button", { name: /^Table T10,/ })).toBeVisible();

  await page.getByLabel("Status").selectOption("free");
  await expect(page.getByRole("button", { name: /^Table T1,/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Table T2,/ })).toBeVisible();
  await page.getByLabel("Area").selectOption("outdoor");
  await expect(page.getByRole("button", { name: /^Table T10,/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.getByRole("button", { name: /^Table T1,/ })).toBeVisible();

  await page.getByRole("radio", { name: "List" }).check({ force: true });
  const table = page.getByRole("table", { name: "Tables" });
  await table.getByRole("button", { name: /Seats/ }).click();
  await expect.poll(async () => (await table.locator("tbody tr").allInnerTexts()).map((r) => r.split("\t")[1])).toEqual(["2", "4", "8"]);

  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  const csv = (await readFile((await dl.path())!, "utf8")).replace(/^﻿/, "");
  expect(csv.split("\r\n")[0]).toBe("Table,Seats,Area,Status,Open amount,Active");
  expect(csv).toMatch(/T1,4,indoor,Order open,\d+(\.\d+)?,Yes/);
});

test("add, rename and archive a table; a duplicate label is refused; a table with an open order cannot be archived", async ({ page, request }) => {
  const s = await seed(request);
  await order(request, s, s.tableId);
  await openAs(page, s.token, "/manage?tab=tables", s.refresh);
  await page.getByRole("button", { name: "Add table" }).click();
  let form = page.getByRole("dialog", { name: "Add a table" });
  await form.getByLabel("Label").fill("T1");
  await form.getByRole("button", { name: "Add table" }).click();
  await expect(form.getByRole("alert")).toContainText(/already exists/i);
  await form.getByLabel("Label").fill("Patio 2");
  await form.getByLabel("Seats").fill("0");
  await form.getByRole("button", { name: "Add table" }).click();
  await expect(form.getByText("1 to 99 seats")).toBeVisible();
  await form.getByLabel("Seats").fill("6");
  await form.getByRole("radio", { name: "Outdoor" }).check({ force: true });
  await form.getByRole("button", { name: "Add table" }).click();
  await expect(page.getByRole("button", { name: "Table Patio 2, 6 seats, Free" })).toBeVisible();

  await page.getByRole("button", { name: /^Table Patio 2,/ }).click();
  await page.getByRole("dialog", { name: "Table Patio 2" }).getByRole("button", { name: "Edit table Patio 2" }).click();
  form = page.getByRole("dialog", { name: "Edit table Patio 2" });
  await form.getByLabel("Label").fill("Garden 2");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: /^Table Garden 2,/ })).toBeVisible();

  await page.getByRole("button", { name: /^Table Garden 2,/ }).click();
  await page.getByRole("dialog", { name: "Table Garden 2" }).getByRole("button", { name: "Archive table Garden 2" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Table Garden 2,/ })).toHaveCount(0);
  await page.getByLabel(/Show archived tables/).check();
  await expect(page.getByRole("button", { name: /^Table Garden 2, 6 seats, archived/ })).toBeVisible();
  await page.getByRole("button", { name: /^Table Garden 2,/ }).click();
  await page.getByRole("dialog", { name: "Table Garden 2" }).getByRole("button", { name: "Restore table Garden 2" }).click();
  await expect(page.getByRole("button", { name: "Table Garden 2, 6 seats, Free" })).toBeVisible();

  // T1 has an open order: the server refuses and says why
  await page.getByRole("button", { name: /^Table T1,/ }).click();
  await page.getByRole("dialog", { name: "Table T1" }).getByRole("button", { name: "Archive table T1" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive", exact: true }).click();
  const tables = (await (await request.get(`${API}/tables`, { headers: s.auth })).json()) as { label: string }[];
  expect(tables.map((t) => t.label)).toContain("T1");
});

test("without tables.manage the floor plan is view-only; a server failure on orders keeps the tables", async ({ page, request }) => {
  const s = await seed(request);
  await page.route("**/auth/me", async (route) => {
    const res = await route.fetch(); const me = await res.json();
    me.permissions = (me.permissions as string[]).filter((p) => p !== "tables.manage");
    await route.fulfill({ response: res, json: me });
  });
  await page.route("**/orders?status=*", (route) => route.fulfill({ status: 500, json: { detail: "boom" } }));
  await openAs(page, s.token, "/manage?tab=tables", s.refresh);
  await expect(page.getByRole("button", { name: "Table T1, 4 seats, status not available" })).toBeVisible();
  await expect(page.getByText("Table status is not available right now")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add table" })).toHaveCount(0);
  await page.getByRole("button", { name: /^Table T1,/ }).click();
  const sheet = page.getByRole("dialog", { name: "Table T1" });
  await expect(sheet.getByRole("button", { name: /Edit table|Archive table/ })).toHaveCount(0);
});

test("empty and error states", async ({ page, request }) => {
  const s = await seed(request);
  await request.patch(`${API}/tables/${s.tableId}`, { headers: s.auth, data: { is_active: false } });
  await openAs(page, s.token, "/manage?tab=tables", s.refresh);
  await expect(page.getByText("No tables match")).toBeVisible(); // only an archived table exists, hidden by default
  await page.getByLabel(/Show archived tables/).check();
  await expect(page.getByRole("button", { name: /^Table T1,/ })).toBeVisible();

  await page.route("**/tables?*", (route) => route.fulfill({ status: 500, json: { detail: "Tables are down" } }));
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Tables are down" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});
