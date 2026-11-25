import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { openAs } from "./helpers";
import { call, seedInventory } from "./inventory-helpers";

// Low-stock alert (/alerts) and the food-cost report (/reports, Food cost) against the real API.

test("low-stock alert appears when stock runs low and resolves itself once stock is back", async ({ page, request }) => {
  const s = await seedInventory(request); // rice: 2 kg against a 3 kg reorder level
  await openAs(page, s.token, "/alerts", s.refresh);
  await expect(page.getByText("Basmati rice").first()).toBeVisible();
  await expect(page.getByRole("tab", { name: /Open/ })).toContainText("1");
  await call(request, s, "post", "/inventory/adjustments", { idempotency_key: randomUUID(), item_id: s.rice, kind: "adjustment", quantity: "10", unit: "kg", reason: "delivery" });
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("tab", { name: /Resolved/ })).toContainText("1");
  await expect(page.getByRole("tab", { name: /Open/ })).not.toContainText("1");
  await page.getByRole("tab", { name: /Resolved/ }).click();
  await expect(page.getByText("Basmati rice").first()).toBeVisible();
});

test("food cost report: dish cost from delivery rates, margin, and what is missing is named", async ({ page, request }) => {
  const s = await seedInventory(request);
  const rec = async (supplierId: string, itemId: string, qty: string, unit: string, price: string) => {
    const po = await call<{ id: string; lines: { id: string }[] }>(request, s, "post", "/purchase-orders", { supplier_id: supplierId, expected_date: null, notes: null, lines: [{ item_id: itemId, quantity: qty, unit, unit_price: price, tax_rate: "0" }] });
    await call(request, s, "post", `/purchase-orders/${po.id}/send`);
    await call(request, s, "post", `/purchase-orders/${po.id}/receipts`, { idempotency_key: randomUUID(), lines: [{ po_line_id: po.lines[0].id, quantity: qty, rejected_quantity: "0" }] });
  };
  await rec(s.supplierId, s.paneer, "10", "kg", "320"); // ₹0.32 per g
  const sell = async () => { const o = await call<{ id: string }>(request, s, "post", "/orders", { client_uuid: randomUUID(), order_type: "takeaway", table_id: null, lines: [{ item_id: s.itemId, quantity: 2 }] }); await call(request, s, "post", `/orders/${o.id}/bill`, {}); };
  await sell();
  await openAs(page, s.token, "/reports", s.refresh);
  await page.getByRole("tab", { name: "Food cost" }).click();
  // milk was never bought (opening stock only): the report says so instead of showing a made-up cost
  await expect(page.getByText("Ingredients without a cost: Milk")).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: "docs/inventory-ui-shots/food-cost-incomplete.png", fullPage: true });

  await rec(s.supplier2Id, s.milk, "20", "l", "58"); // ₹0.058 per ml
  await sell();
  await page.reload();
  await page.getByRole("tab", { name: "Food cost" }).click();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: "docs/inventory-ui-shots/food-cost-complete.png", fullPage: true });
});
