import { expect, test, type Page, type Route } from "@playwright/test";
import { signIn } from "./helpers";

// Mic on/off switch, in-app bill-scan camera, bonus Chilli, "+ Add recipe". Every API call is mocked; the camera is Chromium's fake device.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = () => `${b64({ alg: "none" })}.${b64({ sub: "u1", rid: "r1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const PERMS = ["settings.owner", "settings.view", "billing.view", "billing.topup", "orders.create", "orders.view", "menu.view", "menu.edit", "inventory.view", "inventory.edit", "purchases.view", "purchases.edit"];
const BILLING = { state: "trial", model: "payg", balance_paise: 150_000, per_bill_paise: 500, low_balance_paise: 10_000, min_topup_paise: 200_000, max_topup_paise: 10_000_000, topup_online: true, days_left: 5, trial_ends_at: "2026-11-26T00:00:00Z" };
const me = { id: "u1", email: "o@example.in", full_name: "Owner", role: "owner", is_active: true, restaurant_name: "Spice Garden", permissions: PERMS, business_types: ["restaurant"], capabilities: { dine_in: true, tables: true }, billing: BILLING };
const MENU = [
  { id: "m1", category_id: "c1", name: "Paneer Tikka", price: "260.00", is_active: true, variants: [] },
  { id: "m2", category_id: "c1", name: "Butter Naan", price: "50.00", is_active: true, variants: [] },
];
const INV = [{ id: "i1", name: "Paneer", base_unit: "g", reorder_level: "500", balance: "2000", low_stock: false }];

async function mock(page: Page) {
  await page.route("**/api/v1/**", (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/v1/, "");
    if (path === "/auth/me") return route.fulfill({ json: me });
    if (path === "/billing/wallet") return route.fulfill({ json: { billing: BILLING, source: "live" } });
    if (path === "/billing/ledger") return route.fulfill({ json: { items: [
      { id: 2, kind: "promo", amount_paise: 25_000, balance_after_paise: 150_000, created_at: "2026-11-20T10:00:00Z", ref: null },
      { id: 1, kind: "promo", amount_paise: 100_000, balance_after_paise: 125_000, created_at: "2026-11-19T10:00:00Z", ref: null }], total: 2, limit: 200, offset: 0 } });
    if (path === "/restaurant") return route.fulfill({ json: { name: "Spice Garden", currency: "INR", timezone: "Asia/Kolkata", country: "IN", currency_symbol: "₹", prices_include_tax: false } });
    if (path === "/menu/items") return route.fulfill({ json: MENU });
    if (path === "/inventory/items") return route.fulfill({ json: INV });
    return route.fulfill({ json: [] });
  });
}
async function open(page: Page, url: string) {
  await mock(page);
  await signIn(page, fakeJwt());
  await page.goto(url);
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, permissions: ["camera"] });

test("Mic switch is visible on the counter without any setting, starts ON, and toggles OFF/ON", async ({ page }) => {
  await open(page, "/pos");
  const sw = page.getByTestId("hands-free");
  await expect(sw).toBeVisible();
  await expect(sw).toHaveAttribute("aria-pressed", "true");
  await expect(sw).toContainText("Mic on");
  await expect(sw.locator("svg")).toHaveCount(1);   // a mic icon, not an ear
  await sw.click();
  await expect(sw).toHaveAttribute("aria-pressed", "false");
  await expect(sw).toContainText("Mic off");
  await page.reload();                       // a new app open: ON again (off is for this session only)
  await expect(page.getByTestId("hands-free")).toHaveAttribute("aria-pressed", "true");
});

test("Scan with camera opens the in-app camera and a photo becomes a bill page", async ({ page }) => {
  await open(page, "/manage?tab=suppliers&view=invoices");
  await page.getByRole("button", { name: "Scan with camera" }).click();
  const cam = page.getByRole("dialog", { name: "Camera" });
  await expect(cam).toBeVisible();
  const take = cam.getByRole("button", { name: "Take photo" });
  await expect(take).toBeEnabled({ timeout: 15_000 });
  await take.click();
  await expect(cam).toHaveCount(0);
  await expect(page.getByText("Page 1")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Read invoice" })).toBeVisible();
});

test("Bonus Chilli shows on Today and on Billing", async ({ page }) => {
  await open(page, "/today");
  await expect(page.getByTestId("credit-bonus")).toContainText("1,250 Chilli bonus included");
  await page.goto("/manage?tab=billing");
  await expect(page.getByText("Bonus Chilli received")).toBeVisible();
  await expect(page.getByText("+1,250 Chilli").first()).toBeVisible();
});

test("Recipes: every dish without a recipe has a '+ Add recipe' button and no inventory shortcuts", async ({ page }) => {
  await open(page, "/manage?tab=recipes");
  await expect(page.getByText("Add recipe")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Go to inventory|Scan a supplier bill/ })).toHaveCount(0);
  await page.getByText("Add recipe").first().click();
  await expect(page.getByRole("button", { name: "Add ingredient" })).toBeVisible();
});

test("A blocked camera says why (and the file picker stays one tap away) instead of doing nothing", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
  });
  await open(page, "/manage?tab=suppliers&view=invoices");
  await page.getByRole("button", { name: "Scan with camera" }).click();
  await expect(page.getByText("The camera is blocked for this site")).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose file" })).toBeVisible();
});
