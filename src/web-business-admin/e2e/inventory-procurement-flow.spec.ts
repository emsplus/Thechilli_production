import { expect, test } from "@playwright/test";
import { API, openAs } from "./helpers";
import { call, seedInventory } from "./inventory-helpers";

// Orders & receiving (/procurement) against the real API: purchase order -> send -> partial receipt with the supplier's bill number -> second receipt -> return.

const items = async (request: import("@playwright/test").APIRequestContext, auth: Record<string, string>) =>
  (await (await request.get(`${API}/inventory/items`, { headers: auth })).json()) as { id: string; balance: string; last_cost: string | null }[];

test("purchase order, partial receipt with the bill number, rest later, return", async ({ page, request }) => {
  const s = await seedInventory(request);
  await openAs(page, s.token, "/procurement", s.refresh);
  await expect(page.getByRole("tab", { name: "Purchase orders" })).toBeVisible();
  await expect(page.getByText("No purchase orders yet")).toBeVisible();

  // create: 20 kg paneer at ₹320 + 5% GST, 40 l milk at ₹58
  await page.getByRole("button", { name: "New purchase order" }).first().click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Supplier").selectOption({ label: "Sharma Dairy" });
  await dlg.getByLabel("Item 1", { exact: true }).selectOption({ label: "Paneer" });
  await dlg.getByLabel("Unit 1", { exact: true }).selectOption("kg");
  await dlg.getByLabel("Quantity 1", { exact: true }).fill("20");
  await dlg.getByLabel("Price per unit 1", { exact: true }).fill("320");
  await dlg.getByLabel("GST % 1", { exact: true }).fill("5");
  await dlg.getByRole("button", { name: "Add item" }).click();
  await dlg.getByLabel("Item 2", { exact: true }).selectOption({ label: "Milk" });
  await dlg.getByLabel("Unit 2", { exact: true }).selectOption("l");
  await dlg.getByLabel("Quantity 2", { exact: true }).fill("40");
  await dlg.getByLabel("Price per unit 2", { exact: true }).fill("58");
  await expect(dlg).toContainText("₹8,720.00"); // 6,400 + 2,320 before tax
  await dlg.getByRole("button", { name: "Save" }).click();
  const row = page.getByRole("row").filter({ hasText: "PO-000001" });
  await expect(row).toContainText("Draft");
  await expect(row).toContainText("₹9,040.00"); // + 5% on the paneer

  // send
  await row.getByRole("button", { name: "Send" }).click();
  await expect(row).toContainText("Sent");

  // partial receipt: 8 of 20 kg paneer, none of the milk, with the supplier's bill number
  await row.getByRole("button", { name: "Receive goods" }).click();
  const rec = page.getByRole("dialog");
  await rec.getByLabel("Supplier invoice no.").fill("SD-9001");
  await rec.getByLabel("Accepted Paneer").fill("8");
  await rec.getByLabel("Accepted Milk").fill("");
  await rec.getByRole("button", { name: "Receive goods" }).click();
  await expect(row).toContainText("Part received");
  let now = await items(request, s.auth);
  expect(Number(now.find((i) => i.id === s.paneer)!.balance)).toBe(20000); // 12 kg + 8 kg
  expect(Number(now.find((i) => i.id === s.milk)!.balance)).toBe(30000);   // untouched
  expect(Number(now.find((i) => i.id === s.paneer)!.last_cost)).toBeCloseTo(0.32, 4);

  // the rest later: 12 kg paneer (one kg rejected is not stock) and the milk
  await row.getByRole("button", { name: "Receive goods" }).click();
  await expect(page.getByRole("dialog")).toContainText("12 kg remaining");
  await page.getByRole("dialog").getByLabel("Accepted Paneer").fill("11");
  await page.getByRole("dialog").getByLabel("Rejected Paneer").fill("1");
  await page.getByRole("dialog").getByLabel("Accepted Milk").fill("40");
  await page.getByRole("dialog").getByRole("button", { name: "Receive goods" }).click();
  // a rejected kilo is not received: 1 kg is still open, so the order stays "Part received" until it is short-closed
  await expect(row).toContainText("Part received");
  await row.getByRole("button", { name: "View" }).click();
  await expect(page.getByRole("dialog")).toContainText("1 kg");
  await page.getByRole("dialog").getByRole("button", { name: "Close order" }).click();
  await page.getByRole("alertdialog").or(page.getByRole("dialog")).last().getByRole("button", { name: "Close order" }).click();
  await expect(row).toContainText("Closed");
  now = await items(request, s.auth);
  expect(Number(now.find((i) => i.id === s.paneer)!.balance)).toBe(31000);
  expect(Number(now.find((i) => i.id === s.milk)!.balance)).toBe(70000);

  // goods received: both receipts, the first carries the bill number; return 2 kg of the first
  await page.getByRole("tab", { name: "Goods received" }).click();
  await expect(page.getByRole("row").filter({ hasText: "GRN-000001" })).toContainText("SD-9001");
  await page.getByRole("button", { name: "GRN-000001" }).click();
  await expect(page.getByRole("dialog")).toContainText("Accepted 8 kg");
  await page.getByRole("button", { name: "Return goods" }).click();
  await page.getByLabel("Reason for the return").fill("Damaged packs");
  await page.getByLabel(/Quantity Paneer/).fill("2000");
  await page.getByRole("dialog").getByRole("button", { name: "Return goods" }).click();
  await expect(page.getByRole("heading", { name: "Returns to suppliers" })).toBeVisible();
  const ret = page.getByRole("row").filter({ hasText: "DN-000001" });
  await expect(ret).toContainText("Damaged packs");
  await expect(ret).toContainText("₹672.00"); // 2 kg at ₹320 + 5% GST
  now = await items(request, s.auth);
  expect(Number(now.find((i) => i.id === s.paneer)!.balance)).toBe(29000);
});

test("rupee amounts use lakh / crore grouping everywhere on the screen", async ({ page, request }) => {
  const s = await seedInventory(request);
  // 1,000 kg of rice at ₹1,250 = ₹12,50,000 (twelve lakh fifty thousand); 10,000 kg of paneer at ₹320 = ₹32,00,000; together ₹44,50,000
  await call(request, s, "post", "/purchase-orders", { supplier_id: s.supplierId, expected_date: null, notes: null, lines: [
    { item_id: s.rice, quantity: "1000", unit: "kg", unit_price: "1250", tax_rate: "0" }, { item_id: s.paneer, quantity: "10000", unit: "kg", unit_price: "320", tax_rate: "0" }] });
  await openAs(page, s.token, "/procurement", s.refresh);
  await expect(page.getByRole("row").filter({ hasText: "PO-000001" })).toContainText("₹44,50,000.00");
  await page.getByRole("button", { name: "PO-000001" }).click();
  await expect(page.getByRole("dialog")).toContainText("₹12,50,000.00");
  await expect(page.getByRole("dialog")).toContainText("₹32,00,000.00");
  await expect(page.locator("body")).not.toContainText(/₹\s?4,450,000|₹\s?1,250,000/);
});
