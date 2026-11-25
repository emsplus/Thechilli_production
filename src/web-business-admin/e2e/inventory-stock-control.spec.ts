import { expect, test } from "@playwright/test";
import { API, openAs } from "./helpers";
import { seedActivity, seedInventory } from "./inventory-helpers";

// Orders & receiving, the stock-control tabs against the real API: wastage, batches and expiry, stock counts, locations.

const balance = async (request: import("@playwright/test").APIRequestContext, auth: Record<string, string>, id: string) =>
  Number(((await (await request.get(`${API}/inventory/items`, { headers: auth })).json()) as { id: string; balance: string }[]).find((i) => i.id === id)!.balance);

test("wastage: record with a reason, totals by reason and item, stock goes down", async ({ page, request }) => {
  const s = await seedInventory(request);
  await seedActivity(request, s); // paneer was received at ₹320 / kg, so wastage of it has a value
  await openAs(page, s.token, "/procurement?tab=wastage", s.refresh);
  const before = await balance(request, s.auth, s.paneer);
  await page.getByRole("button", { name: "Record wastage" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Item", { exact: true }).selectOption({ label: "Paneer" });
  await dlg.getByLabel("Quantity", { exact: true }).fill("500");
  await dlg.getByLabel("Unit", { exact: true }).selectOption("g");
  await dlg.getByLabel("Reason", { exact: true }).selectOption("breakage");
  await dlg.getByLabel("Note").fill("Dropped tray");
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("table", { name: "By reason" }).getByRole("row").filter({ hasText: "Breakage" })).toContainText("₹160.00"); // 500 g at ₹320 / kg
  await expect(page.getByRole("table", { name: "By item" }).getByRole("row").filter({ hasText: "Paneer" })).toContainText("500 g");
  expect(before - (await balance(request, s.auth, s.paneer))).toBe(500);
});

test("batches: an expiring batch is flagged and can be written off", async ({ page, request }) => {
  const s = await seedInventory(request);
  const a = await seedActivity(request, s);
  await openAs(page, s.token, "/procurement?tab=batches", s.refresh);
  const row = page.getByRole("row").filter({ hasText: "CD-1" });
  await expect(row).toContainText("Curd");
  await expect(row).toContainText("Expires in 3 d");
  await expect(row).toContainText("5 kg");
  await expect(row).toContainText("₹450.00");
  await page.getByLabel("Expiring within").selectOption({ index: 1 });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /Write off/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Write off" }).click();
  await expect(page.getByText("Batch written off")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "CD-1" }).getByRole("button", { name: /Write off/ })).toHaveCount(0);
  expect(await balance(request, s.auth, a.batchItem)).toBe(0);
});

test("stock count: start, enter counts, save, post; the difference changes the stock", async ({ page, request }) => {
  const s = await seedInventory(request);
  await openAs(page, s.token, "/procurement?tab=counts", s.refresh);
  await expect(page.getByText("No stock counts yet")).toBeVisible();
  await page.getByRole("button", { name: "Start a count" }).click();
  await page.getByLabel("Count name (optional)").fill("Month end");
  await page.getByRole("dialog").getByRole("button", { name: "Start a count" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("Month end");
  await sheet.getByLabel("Counted Basmati rice (g)").fill("4500");
  await sheet.getByRole("button", { name: "Save counts" }).click();
  await expect(page.getByText("Counts saved")).toBeVisible();
  await sheet.getByRole("button", { name: "Post count" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Post count" }).click();
  await expect(page.getByText("Count posted").first()).toBeVisible();
  expect(await balance(request, s.auth, s.rice)).toBe(4500); // was 2 kg
  await page.keyboard.press("Escape");
  await expect(page.getByRole("row").filter({ hasText: "Month end" })).toContainText("Posted");
});

test("locations: add, rename, switch off; the default cannot be switched off", async ({ page, request }) => {
  const s = await seedInventory(request);
  await openAs(page, s.token, "/procurement?tab=locations", s.refresh);
  const main = page.getByRole("row").filter({ hasText: "Main store" });
  await expect(main).toContainText("Default");
  await expect(main.getByRole("button", { name: /Switch off/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Add location" }).click();
  await page.getByLabel("Location name").fill("Bar fridge");
  await page.getByLabel("Kind").selectOption("bar");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  const bar = page.getByRole("row").filter({ hasText: "Bar fridge" });
  await expect(bar).toContainText("Bar");
  await bar.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Location name").fill("Bar cooler");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Bar cooler" })).toBeVisible();
  await page.getByRole("row").filter({ hasText: "Bar cooler" }).getByRole("button", { name: "Switch off" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Bar cooler" })).toHaveCount(0);
  await page.getByLabel("Show switched-off locations").check({ force: true });
  await expect(page.getByRole("row").filter({ hasText: "Bar cooler" })).toContainText("Switched off");
});
