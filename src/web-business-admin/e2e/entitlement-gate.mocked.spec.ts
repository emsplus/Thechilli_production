import { expect, test, type Route } from "@playwright/test";
import { signIn } from "./helpers";

// UI E2E finding: on a plan without the inventory module, opening the item editor (and the Manage overview) asked for
// /inventory/items, /recipes and /purchases, and every answer was 403 feature_not_entitled: red console errors on every edit.
// A plan without inventory must not make those calls. Every API call is mocked (playwright.mocked.config.ts).
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = () => `${b64({ alg: "none" })}.${b64({ sub: "u1", rid: "r1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const ME = { id: "u1", email: "owner@example.in", full_name: "Owner", role: "owner", is_active: true, restaurant_name: "Spice Garden",
  permissions: ["settings.owner", "settings.view", "menu.manage", "menu.view"], business_types: ["restaurant"], capabilities: { dine_in: true, tables: true },
  entitlements: { features: { inventory: { enabled: false } } } };
const REST = { name: "Spice Garden", trn: null, address: "12 MG Road", currency: "INR", timezone: "Asia/Kolkata", country: "IN", currency_symbol: "₹", prices_include_tax: false };
const CAT = { id: "c1", name: "Mains", sort_order: 0, is_active: true };
const ITEM = { id: "i1", category_id: "c1", name: "Paneer Tikka", price: "250.00", tax_kind: "standard", hsn: null, supply_type: "restaurant", gst_rate_code: null, food_type: "veg", description: null,
  is_active: true, variants: [], modifier_group_ids: [], is_combo: false, image_url: null, thumb_url: null, sold_out: false };

test("plan without inventory: editing a dish never calls the inventory, recipe or purchase APIs", async ({ page }) => {
  const gated: string[] = [];
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/v1/**", (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/v1/, "");
    if (/^\/(inventory|recipes|purchases)/.test(path)) { gated.push(path); return route.fulfill({ status: 403, json: { detail: "Your plan does not include inventory", error: { code: "feature_not_entitled" } } }); }
    if (path === "/auth/me") return route.fulfill({ json: ME });
    if (path === "/restaurant") return route.fulfill({ json: REST });
    if (path.startsWith("/menu/categories")) return route.fulfill({ json: [CAT] });
    if (path.startsWith("/menu/items")) return route.fulfill({ json: [ITEM] });
    if (path.startsWith("/menu/modifier-groups")) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "Not Found" } });
  });
  await signIn(page, fakeJwt());
  await page.goto("/manage?tab=menu");
  await page.getByRole("button", { name: "Edit Paneer Tikka" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(1000);
  expect(gated, "plan-gated endpoints called").toEqual([]);
});
