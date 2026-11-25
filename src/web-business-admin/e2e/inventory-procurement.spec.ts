import { expect, test, type Page } from "@playwright/test";
import { openAs, seed } from "./helpers";

// Procurement UI (purchase orders, receipts, wastage, batches, counts, locations) against mocked endpoints:
// the server these specs run against may predate phase2/inventory. Contract: docs/INVENTORY.md on that branch.

const PERMS = ["purchases.manage", "purchases.receive", "inventory.manage", "wastage.record", "inventory.count"];
const withPerms = (page: Page) => page.route("**/auth/me", async (route) => {
  const res = await route.fetch(); const me = await res.json();
  await route.fulfill({ response: res, json: { ...me, permissions: [...new Set([...(me.permissions ?? []), ...PERMS])] } });
});
const GONE = { status: 404, json: { detail: "Not Found" } };
const po = { id: "11111111-0000-4000-8000-000000000001", outlet_id: "o1", supplier_id: "s1", number: "PO-000042", status: "sent", expected_date: null, notes: null, subtotal: "100.00", tax_total: "5.00", total: "105.00", sent_at: null, closed_at: null, cancelled_at: null, lines: [] };

test("a server without the stock service: the page says so instead of failing", async ({ page, request }) => {
  const s = await seed(request);
  await withPerms(page);
  for (const p of ["**/purchase-orders*", "**/goods-receipts*", "**/inventory/wastage*", "**/stock/batches*", "**/stock/counts*", "**/stock/locations*"]) await page.route(p, (r) => r.fulfill(GONE));
  await openAs(page, s.token, "/procurement", s.refresh);
  await expect(page.getByText("Not available on this server")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0); // no error banner (the toast region is an empty alert)
});

test("purchase orders list from the real path; a section that 404s is hidden", async ({ page, request }) => {
  const s = await seed(request);
  await withPerms(page);
  await page.route("**/purchase-orders*", (r) => r.request().method() === "GET" ? r.fulfill({ json: [po] }) : r.fulfill(GONE));
  for (const p of ["**/goods-receipts*", "**/inventory/wastage*", "**/stock/batches*", "**/stock/counts*", "**/stock/locations*"]) await page.route(p, (r) => r.fulfill(GONE));
  await openAs(page, s.token, "/procurement", s.refresh);
  await expect(page.getByRole("heading", { name: "Orders & receiving", level: 1 })).toBeVisible();
  await expect(page.getByText("PO-000042")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Wastage" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Purchase orders" })).toBeVisible();
});
