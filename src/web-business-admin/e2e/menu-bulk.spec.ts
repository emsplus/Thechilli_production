import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { API, openAs, seed, type Seed } from "./helpers";

type Item = { id: string; name: string; price: string; category_id: string; is_active: boolean };
const items = async (request: APIRequestContext, s: Seed) => (await (await request.get(`${API}/menu/items?include_inactive=true`, { headers: s.auth })).json()) as Item[];
const byName = async (request: APIRequestContext, s: Seed, n: string) => (await items(request, s)).find((i) => i.name === n)!;

async function menu(request: APIRequestContext, s: Seed, extra: [string, string][] = [["Chai", "20.00"], ["Samosa", "30.00"]]) {
  for (const [name, price] of extra) {
    const r = await request.post(`${API}/menu/items`, { headers: s.auth, data: { category_id: s.catId, name, price } });
    expect(r.status()).toBe(201);
  }
}
// One at a time: the bulk bar changes the layout after the first tick.
const pick = async (page: Page, ...names: string[]) => { for (const n of names) await page.getByLabel(`Select ${n}`, { exact: true }).check(); };

test("bulk: change price by a percentage and by a set amount, exactly", async ({ page, request }) => {
  const s = await seed(request, "100.00");
  await menu(request, s);
  await openAs(page, s.token, "/manage?tab=menu", s.refresh);
  await expect(page.getByRole("button", { name: "Edit Chai" })).toBeVisible();
  await pick(page, "Latte", "Chai");
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("button", { name: "Change price" }).click();
  const sheet = page.getByRole("dialog", { name: "Change price" });
  await sheet.getByLabel(/^Percentage/).fill("10");
  await expect(sheet.getByRole("list", { name: "New prices" })).toContainText("110.00");
  await sheet.getByRole("button", { name: "Apply to 2 items" }).click();
  await expect.poll(async () => (await byName(request, s, "Latte")).price).toBe("110.00");
  expect((await byName(request, s, "Chai")).price).toBe("22.00");
  expect((await byName(request, s, "Samosa")).price).toBe("30.00"); // not selected, untouched

  await pick(page, "Samosa");
  await page.getByRole("button", { name: "Change price" }).click();
  await sheet.getByLabel("How to change").selectOption("set");
  await sheet.getByLabel("New price").fill("-5");
  await sheet.getByRole("button", { name: /^Apply to/ }).click();
  await expect(sheet.getByText("Enter a price like 120 or 120.50")).toBeVisible();
  await sheet.getByLabel("New price").fill("45.50");
  await sheet.getByRole("button", { name: /^Apply to/ }).click();
  await expect.poll(async () => (await byName(request, s, "Samosa")).price).toBe("45.50");
});

test("bulk: make items unavailable and available again, and move them to another category", async ({ page, request }) => {
  const s = await seed(request);
  await menu(request, s);
  const snacks = await (await request.post(`${API}/menu/categories`, { headers: s.auth, data: { name: "Snacks" } })).json();
  await openAs(page, s.token, "/manage?tab=menu", s.refresh);
  await expect(page.getByRole("button", { name: "Edit Chai" })).toBeVisible();
  await pick(page, "Chai", "Samosa");
  await page.getByRole("button", { name: "Make unavailable" }).click();
  await expect.poll(async () => (await items(request, s)).filter((i) => !i.is_active).map((i) => i.name).sort()).toEqual(["Chai", "Samosa"]);
  await expect(page.getByRole("button", { name: "Edit Chai" })).toHaveCount(0); // hidden until "Show archived"
  await page.getByLabel(/Show archived items/).check();
  await pick(page, "Chai", "Samosa");
  await page.getByRole("button", { name: "Make available" }).click();
  await expect.poll(async () => (await items(request, s)).every((i) => i.is_active)).toBe(true);

  await pick(page, "Chai", "Samosa");
  await page.getByRole("button", { name: "Move to category" }).click();
  const sheet = page.getByRole("dialog", { name: "Move to category" });
  await sheet.getByRole("button", { name: "Apply to 2 items" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Choose a category");
  await sheet.getByLabel("Move to").selectOption({ label: "Snacks" });
  await sheet.getByRole("button", { name: "Apply to 2 items" }).click();
  await expect.poll(async () => (await byName(request, s, "Chai")).category_id).toBe(snacks.id);
  expect((await byName(request, s, "Samosa")).category_id).toBe(snacks.id);
  expect((await byName(request, s, "Latte")).category_id).toBe(s.catId);
});

test("list view sorts on the raw price, searches, filters by category and exports CSV", async ({ page, request }) => {
  const s = await seed(request, "100.00");
  await menu(request, s, [["Chai", "20.00"], ["Samosa", "3000.00"]]);
  await openAs(page, s.token, "/manage?tab=menu", s.refresh);
  await expect(page.getByRole("button", { name: "Edit Chai" })).toBeVisible();
  await page.getByRole("radio", { name: "List" }).check({ force: true });
  const table = page.getByRole("table", { name: "Menu items" });
  await table.getByRole("button", { name: /Price/ }).click();
  const names = async () => (await table.locator("tbody tr").allInnerTexts()).map((t) => t.split("\n").find((l) => ["Latte", "Chai", "Samosa"].includes(l.trim()))?.trim());
  await expect.poll(names).toEqual(["Chai", "Latte", "Samosa"]);
  await table.getByRole("button", { name: /Price/ }).click();
  await expect.poll(names).toEqual(["Samosa", "Latte", "Chai"]);

  await page.getByLabel("Search items").fill("sam");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("Search items").fill("zzz");
  await expect(page.getByText("No matching items").first()).toBeVisible();
  await page.getByLabel("Search items").fill("");

  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  expect(dl.suggestedFilename()).toBe("menu.csv");
  const csv = (await readFile((await dl.path())!, "utf8")).replace(/^﻿/, "");
  expect(csv.split("\r\n")[0]).toBe("Name,Category,Price,Status,Options,Food type,Description"); // food type + description came with ux/menu-meta
  expect(csv).toContain("Samosa,Drinks,3000,Available");
});

test("without menu.manage the menu is read-only (no add, edit, archive or bulk actions)", async ({ page, request }) => {
  const s = await seed(request);
  await menu(request, s);
  await page.route("**/auth/me", async (route) => {
    const res = await route.fetch();
    const me = await res.json();
    me.permissions = (me.permissions as string[]).filter((p) => p !== "menu.manage");
    await route.fulfill({ response: res, json: me });
  });
  await openAs(page, s.token, "/manage?tab=menu", s.refresh);
  await expect(page.getByText("Chai").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Add item" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage categories" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit Chai" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Archive Chai" })).toHaveCount(0);
  await expect(page.getByLabel("Select Chai")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled(); // reading and exporting stay allowed
});

test("long Hindi and Hinglish names wrap instead of overflowing, on a phone", async ({ page, request }) => {
  const s = await seed(request);
  await menu(request, s, [["पनीर बटर मसाला विद एक्स्ट्रा चीज़ एंड बटर नान कॉम्बो थाली", "349.00"], ["ChholeBhatureWithExtraLassiAndPickleSpecialFamilyPackOfFour", "499.00"]]);
  await page.setViewportSize({ width: 360, height: 740 });
  await openAs(page, s.token, "/manage?tab=menu", s.refresh);
  await page.getByRole("button", { name: /^Drinks/ }).click(); // phones show one collapsed section per category (BA-5)
  await expect(page.getByRole("button", { name: /^Edit पनीर/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  // Phones have no Grid / List switch (compact grouped list only): both long names are shown in it, wrapped.
  await expect(page.getByText(/^पनीर बटर/).first()).toBeVisible();
  await expect(page.getByText(/^ChholeBhature/).first()).toBeVisible();
});
