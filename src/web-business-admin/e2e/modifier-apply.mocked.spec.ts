import { expect, test, type Page, type Route } from "@playwright/test";
import { signIn } from "./helpers";

// Manage > Menu > Modifier groups > "Apply to dishes": one group (e.g. Add on) on a whole category / every dish in one step. API mocked.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = () => `${b64({ alg: "none" })}.${b64({ sub: "u1", rid: "r1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const ME = { id: "u1", email: "o@example.in", full_name: "Owner", role: "owner", is_active: true, restaurant_name: "Roll Express", business_types: ["cloud_kitchen"],
  capabilities: { dine_in: false, outdoor: false, takeaway: true, delivery_orders: true, tables: false, reservations: false } };
const REST = { name: "Spice Garden", currency: "INR", timezone: "Asia/Kolkata", country: "IN", currency_symbol: "₹", prices_include_tax: false };
const TAX = { country: "IN", currency: "INR", currency_symbol: "₹", timezone: "Asia/Kolkata", prices_include_tax: false, vat_registered: true, tax_number_label: "GSTIN", service_charge_percent: "0", max_cashier_discount_percent: "10",
  rates: [{ code: "standard", name: "GST", rate_percent: "5" }], rules: { eat_in: "x", takeaway: {}, eat_in_order_types: ["indoor", "outdoor"] } };
const CATS = [{ id: "c1", name: "Paneer Rolls", sort_order: 1, is_active: true }, { id: "c2", name: "Chicken Rolls", sort_order: 2, is_active: true }];
const item = (id: string, cat: string) => ({ id, category_id: cat, name: id, price: "100.00", is_active: true, variants: [] });
const ITEMS = [item("p1", "c1"), item("p2", "c1"), item("k1", "c2")];
const GROUP = { id: "g1", name: "Add on", min_select: 0, max_select: null, sort_order: 0, is_active: true, item_ids: [],
  options: [{ id: "o1", name: "Cheese", price_delta_paise: 2000, is_default: false, is_active: true, sort_order: 0 }] };

async function open(page: Page, reply: (body: Record<string, unknown>) => { status: number; json: unknown }) {
  await page.setViewportSize({ width: 1280, height: 900 });
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/v1/**", async (route: Route) => {
    const u = new URL(route.request().url()); const path = u.pathname.replace(/^.*\/api\/v1/, "");
    if (path === "/auth/me") return route.fulfill({ json: ME });
    if (path === "/restaurant") return route.fulfill({ json: REST });
    if (path === "/billing/tax-config") return route.fulfill({ json: TAX });
    if (path === "/menu/modifier-groups") return route.fulfill({ json: [GROUP] });
    if (path === "/menu/items") return route.fulfill({ json: ITEMS });
    if (path === "/menu/categories") return route.fulfill({ json: CATS });
    if (path === "/menu/modifier-groups/g1/apply") { const body = JSON.parse(route.request().postData() ?? "{}"); calls.push(body); return route.fulfill(reply(body)); }
    return route.fulfill({ json: [] });
  });
  await signIn(page, fakeJwt());
  await page.goto("/manage?tab=menu&view=modifiers");
  await page.getByTestId("apply-g1").click();
  return { sheet: page.getByTestId("apply-sheet"), calls };
}

test("category scope: pick one category, the API gets exactly that category, the toast says how many dishes", async ({ page }) => {
  const { sheet, calls } = await open(page, () => ({ status: 200, json: { changed: 2, total: 2 } }));
  await expect(sheet.getByTestId("apply-count")).toContainText("3 dishes");        // all dishes by default
  await sheet.getByLabel("All dishes of the menu").uncheck();
  await expect(sheet.getByTestId("apply-count")).toContainText("0 dishes");
  await sheet.getByLabel("Paneer Rolls (2)").check();
  await expect(sheet.getByTestId("apply-count")).toContainText("2 dishes");
  await page.getByTestId("apply-go").click();
  await expect(page.getByText("Add on added to 2 dishes")).toBeVisible();
  expect(calls).toEqual([{ mode: "attach", category_ids: ["c1"] }]);
});

test("all dishes + remove: sends detach with all_items; nothing chosen is refused before the API is called", async ({ page }) => {
  const { sheet, calls } = await open(page, () => ({ status: 200, json: { changed: 3, total: 3 } }));
  await sheet.getByLabel("All dishes of the menu").uncheck();
  await page.getByTestId("apply-go").click();
  await expect(sheet).toContainText("Choose at least one category, or all dishes.");
  expect(calls).toHaveLength(0);
  await sheet.getByLabel("All dishes of the menu").check();
  await sheet.getByLabel("Remove this group from the dishes").check();
  await page.getByTestId("apply-go").click();
  await expect(page.getByText("Add on removed from 3 dishes")).toBeVisible();
  expect(calls).toEqual([{ mode: "detach", all_items: true }]);
});

test("a server refusal is shown in the sheet and the sheet stays open", async ({ page }) => {
  const { sheet } = await open(page, () => ({ status: 404, json: { detail: "Category not found" } }));
  await page.getByTestId("apply-go").click();
  await expect(sheet).toContainText("Category not found");
  await expect(sheet).toBeVisible();
});
