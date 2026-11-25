import { expect, test, type Page, type Route } from "@playwright/test";
import { signIn } from "./helpers";

// Smoke finding: the header said "Kolkata · INR" for a Bengaluru restaurant. It must say "India (IST) · INR", from the backend's
// `timezone_label` or, when an older server lacks it, from the frontend mapping. Every API call is mocked (playwright.mocked.config.ts).
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = () => `${b64({ alg: "none" })}.${b64({ sub: "u1", rid: "r1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const ME = { id: "u1", email: "owner@example.in", full_name: "Owner", role: "owner", is_active: true, restaurant_name: "Spice Garden Bengaluru",
  permissions: ["settings.owner", "settings.view", "staff.manage"], business_types: ["restaurant"], capabilities: { dine_in: true, tables: true } };
const REST = { name: "Spice Garden Bengaluru", trn: null, address: "12 MG Road, Bengaluru", currency: "INR", timezone: "Asia/Kolkata", country: "IN", currency_symbol: "₹", prices_include_tax: false };

async function open(page: Page, rest: Record<string, unknown>, url: string, w = 1280) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.addInitScript(() => { try { localStorage.setItem("pos.restaurantName", "Spice Garden Bengaluru"); localStorage.setItem("pos.restaurantSubtitle", "Kolkata · INR"); } catch { /* ignore */ } }); // a cache written by the old build
  await page.route("**/api/v1/**", (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/v1/, "");
    if (path === "/auth/me") return route.fulfill({ json: ME });
    if (path === "/restaurant" && route.request().method() === "GET") return route.fulfill({ json: rest });
    return route.fulfill({ status: 404, json: { detail: "Not Found" } });
  });
  await signIn(page, fakeJwt());
  await page.goto(url);
}
const shot = async (page: Page, name: string) => { if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` }); };

test("desktop header shows India (IST) with the backend timezone_label", async ({ page }) => {
  await open(page, { ...REST, timezone_label: "India (IST)" }, "/manage?tab=restaurant");
  await expect(page.getByText("India (IST) · INR").first()).toBeVisible();
  await expect(page.getByText("Kolkata")).toHaveCount(0);
  await expect(page.getByText("Time zone")).toBeVisible();
  await expect(page.getByText("India (IST)", { exact: true })).toBeVisible(); // Manage > Restaurant
  await shot(page, "tz-1280");
});

test("an older server without timezone_label: the frontend maps Asia/Kolkata to India (IST)", async ({ page }) => {
  await open(page, REST, "/manage?tab=restaurant");
  await expect(page.getByText("India (IST) · INR").first()).toBeVisible();
  await expect(page.getByText("Kolkata")).toHaveCount(0);
  await expect(page.getByText("Asia/Kolkata")).toHaveCount(0);
});

test("phone: the label is in the More sheet", async ({ page }) => {
  await open(page, { ...REST, timezone_label: "India (IST)" }, "/manage?tab=restaurant", 390);
  await page.getByRole("button", { name: /^More/ }).click();
  await expect(page.getByRole("dialog").getByText("India (IST) · INR")).toBeVisible();
  await expect(page.getByText("Kolkata")).toHaveCount(0);
  await page.waitForTimeout(600); // the sheet animates in
  await shot(page, "tz-390");
});
