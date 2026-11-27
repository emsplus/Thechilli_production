import { expect, test, type Page, type Route } from "@playwright/test";
import { signIn } from "./helpers";

// POS on a phone: the "View order" sheet fills (almost) the whole screen, the items get the room and "Place order" stays on screen. API mocked.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = () => `${b64({ alg: "none" })}.${b64({ sub: "u1", rid: "r1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const ME = { id: "u1", email: "o@example.in", full_name: "Owner", role: "owner", is_active: true, restaurant_name: "Roll Express", business_types: ["cloud_kitchen"],
  capabilities: { dine_in: false, outdoor: false, takeaway: true, delivery_orders: false, tables: false, reservations: false, order_types: ["takeaway"] } };
const BILLING = { state: "trial", model: "payg", balance_paise: 0, per_bill_paise: 500, can_bill: true, days_left: 30, low_balance_paise: 10000, min_topup_paise: 200000 };
const CATS = [{ id: "c1", name: "Rolls", sort_order: 1, is_active: true }];
const MENU = ["Paneer Roll", "Chicken Roll", "Egg Roll", "Veg Roll"].map((name, i) => ({ id: `m${i}`, category_id: "c1", name, price: "100.00", is_active: true, variants: [] }));

async function open(page: Page) {
  await page.route("**/api/v1/**", (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/v1/, "");
    if (path === "/auth/me") return route.fulfill({ json: ME });
    if (path === "/billing/wallet") return route.fulfill({ json: { billing: BILLING, source: "live" } });
    if (path === "/restaurant") return route.fulfill({ json: { name: "Roll Express", currency: "INR", timezone: "Asia/Kolkata", country: "IN", currency_symbol: "₹", prices_include_tax: false } });
    if (path === "/billing/tax-config") return route.fulfill({ json: { country: "IN", currency: "INR", currency_symbol: "₹", timezone: "Asia/Kolkata", prices_include_tax: false, vat_registered: false, tax_number_label: "GSTIN", service_charge_percent: "0",
      rates: [{ code: "standard", name: "GST", rate_percent: "5" }], rules: { eat_in: "x", takeaway: {}, eat_in_order_types: [] } } });
    if (path === "/menu/items") return route.fulfill({ json: MENU });
    if (path === "/menu/categories") return route.fulfill({ json: CATS });
    return route.fulfill({ json: [] });
  });
  await signIn(page, fakeJwt());
  await page.goto("/pos");
}

for (const vp of [{ width: 430, height: 932 }, { width: 390, height: 700 }]) {
  test(`phone ${vp.width}x${vp.height}: the order sheet reaches the top and Place order is on screen`, async ({ page }) => {
    await page.setViewportSize(vp);
    await open(page);
    await page.getByRole("button", { name: /^Add/ }).first().click();
    await page.getByRole("button", { name: /View order/ }).click();
    const sheet = page.getByRole("dialog", { name: "Current order" });
    await expect(sheet).toBeVisible();
    await expect.poll(async () => (await sheet.boundingBox())!.y, { timeout: 5000 }).toBeLessThanOrEqual(14);   // after the slide-up: starts at the top (small gap), not a short card at the bottom
    await expect.poll(async () => { const b = (await sheet.boundingBox())!; return b.y + b.height; }, { timeout: 5000 }).toBeGreaterThanOrEqual(vp.height - 2);  // reaches the bottom edge
    const box = (await sheet.boundingBox())!;
    const place = sheet.getByRole("button", { name: /Place order/ });
    await expect(place).toBeVisible();
    const pb = (await place.boundingBox())!;
    await expect.poll(async () => { const b = (await place.boundingBox())!; return b.y + b.height; }, { timeout: 5000 }).toBeGreaterThanOrEqual(vp.height - 48); // anchored at the bottom: no empty band under it
    expect(pb.y + pb.height).toBeLessThanOrEqual(vp.height + 1);  // and inside the screen (1px for rounding)
    expect(pb.y).toBeGreaterThan(box.y + box.height / 2);         // and sits in the lower half, below the items
    await expect(sheet.getByText("Paneer Roll")).toBeVisible();   // the added dish is shown in the (larger) list
    await page.waitForTimeout(600);   // let the slide-up animation finish before the picture
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/pos-order-sheet-${vp.width}x${vp.height}.png` });
  });
}
