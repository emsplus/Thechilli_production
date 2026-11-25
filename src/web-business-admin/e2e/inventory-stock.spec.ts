import { expect, test } from "@playwright/test";
import { API, openAs } from "./helpers";
import { seedActivity, seedInventory } from "./inventory-helpers";

// Stock levels (Manage > Inventory) against the real API: add an item, adjust, count, ledger, low-stock.

test("add an item, adjust it, count it, read its ledger; low stock shows and clears", async ({ page, request }) => {
  const s = await seedInventory(request);
  await openAs(page, s.token, "/manage?tab=inventory", s.refresh);
  const row = (name: string) => page.getByRole("listitem").filter({ hasText: name }).filter({ hasText: "Reorder at" });
  await expect(row("Paneer")).toContainText("12 kg");
  await expect(row("Basmati rice")).toContainText("Low stock"); // 2 kg against a 3 kg reorder level

  // add an item
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await page.getByLabel("Name").fill("Cooking oil");
  await page.getByRole("radio", { name: "ml" }).check({ force: true }).catch(async () => { await page.getByText("ml", { exact: true }).click(); });
  await page.getByLabel(/Reorder level/).fill("2000");
  await page.getByRole("dialog").getByRole("button", { name: "Add item" }).click();
  await expect(row("Cooking oil")).toContainText("Out of stock");

  // adjustment: +5 l of oil as opening stock
  await page.getByRole("button", { name: "Wastage or adjustment for Cooking oil" }).click();
  await page.getByRole("radio", { name: /Adjustment/ }).check({ force: true }).catch(async () => { await page.getByText("Adjustment", { exact: true }).click(); });
  await page.getByLabel("Quantity").fill("5");
  await page.getByLabel("Unit").selectOption("l");
  await page.getByLabel("Reason").fill("opening stock");
  await page.getByRole("button", { name: "Post adjustment" }).click();
  await expect(row("Cooking oil")).toContainText("5 l");
  await expect(row("Cooking oil")).toContainText("In stock");

  // wastage reduces the balance
  await page.getByRole("button", { name: "Wastage or adjustment for Cooking oil" }).click();
  await page.getByLabel("Quantity").fill("1");
  await page.getByLabel("Unit").selectOption("l");
  await page.getByLabel("Reason").fill("spilled");
  await page.getByRole("button", { name: "Record wastage" }).click();
  await expect(row("Cooking oil")).toContainText("4 l");

  // a count: rice counted 5 kg, was 2 kg (above its 3 kg reorder level)
  await page.getByRole("button", { name: "Stock count", exact: true }).click();
  await page.getByLabel("Counted Basmati rice").fill("5");
  await page.getByLabel("Unit for Basmati rice").selectOption("kg");
  await page.getByRole("button", { name: /Post count/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Count results");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(row("Basmati rice")).toContainText("5 kg");

  // the ledger tells where the stock came from
  await page.getByRole("button", { name: "Ledger for Cooking oil" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("Cooking oil ledger");
  await expect(sheet).toContainText("opening stock");
  await expect(sheet).toContainText("spilled");
  await page.keyboard.press("Escape");

  // low-stock filter and counter
  await page.getByRole("radio", { name: /Low only/ }).check({ force: true }).catch(async () => { await page.getByText(/Low only/).click(); });
  await expect(page.getByText("Nothing is running low")).toBeVisible();
  const low = await (await request.get(`${API}/inventory/low-stock`, { headers: s.auth })).json();
  expect(low.map((i: { name: string }) => i.name)).not.toContain("Basmati rice");
});

test("ledger words a goods receipt, a return and a sale for what they are; the Purchases filter holds the return", async ({ page, request }) => {
  const s = await seedInventory(request);
  await seedActivity(request, s);
  await openAs(page, s.token, "/manage?tab=inventory", s.refresh);
  await page.getByRole("button", { name: "Ledger for Paneer" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("Goods received on a purchase order");
  await expect(sheet).toContainText("Returned to supplier");
  await expect(sheet).toContainText("DN-000001");
  await expect(sheet).not.toContainText("Purchase invoice");
  await sheet.getByRole("radio", { name: "Purchases" }).click();
  await expect(sheet).toContainText("Returned to supplier");
  await expect(sheet).not.toContainText("opening stock");
});
