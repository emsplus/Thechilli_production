import { expect, test, type Page, type Route } from "@playwright/test";
import { signIn } from "./helpers";

// Manage > Reviews > "QR codes": a restaurant WITHOUT tables (cloud kitchen) gets ONE common QR (menu page + "Rate your visit"
// button); a restaurant WITH tables still gets the per-table pairs. Every API call is mocked.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = () => `${b64({ alg: "none" })}.${b64({ sub: "u1", rid: "r1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const KITCHEN = { id: "u1", email: "o@example.in", full_name: "Owner", role: "owner", is_active: true, restaurant_name: "Roll Express", business_types: ["cloud_kitchen"],
  capabilities: { dine_in: false, outdoor: false, takeaway: true, delivery_orders: true, tables: false, reservations: false } };
const RESTAURANT = { ...KITCHEN, restaurant_name: "Spice Garden", business_types: ["restaurant"], capabilities: { dine_in: true, outdoor: true, takeaway: true, delivery_orders: true, tables: true, reservations: true } };
const MENU = "https://api.example.in/m/GENERAL-MENU-TOKEN", REVIEW = "https://api.example.in/rv/GENERAL-REVIEW-TOKEN";
const overview = (tables: unknown[]) => ({ restaurant_name: "Roll Express", base_url: "https://api.example.in", menu_enabled: true, reviews_enabled: true, google_review_url: null,
  general: { gen: 1, menu_url: MENU, review_url: REVIEW }, tables });
const REVIEWS = { items: [], total: 0, average: null, distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 }, per_table: [], unread_low: 0 };

async function open(page: Page, me: unknown, tables: unknown[]) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/v1/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/v1/, "");
    if (path === "/auth/me") return route.fulfill({ json: me });
    if (path === "/table-qr") return route.fulfill({ json: overview(tables) });
    if (path === "/table-qr/settings") return route.fulfill({ json: { menu_enabled: true, reviews_enabled: true, google_review_url: null } });
    if (path === "/reviews") return route.fulfill({ json: REVIEWS });
    if (path === "/reviews/summary") return route.fulfill({ json: { unread_low: 0 } });
    return route.fulfill({ json: [] });
  });
  await signIn(page, fakeJwt());
  await page.goto("/manage?tab=reviews");
  await page.getByTestId("reviews-qr-open").click();
}

test("no tables (cloud kitchen): ONE common QR that opens the menu page, no separate review QR, no per-table sections", async ({ page }) => {
  await open(page, KITCHEN, []);
  const common = page.getByTestId("qr-common");
  await expect(common).toBeVisible();
  await expect(common).toContainText("Menu & review QR");
  await expect(common).toContainText("Rate your visit");
  await expect(page.getByTestId("qr-menu-general")).toHaveAttribute("data-url", MENU);
  await expect(page.getByTestId("qr-review-general")).toHaveCount(0);
  await expect(page.getByText("Print for all tables")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Open/ }).first()).toHaveAttribute("href", MENU);
});

test("with tables: the per-table pairs and the restaurant-wide pair stay as before", async ({ page }) => {
  await open(page, RESTAURANT, [{ table_id: "t1", label: "AC1", area: "indoor", seats: 4, gen: 1, regenerated_at: null,
    menu_url: "https://api.example.in/m/T1M", review_url: "https://api.example.in/rv/T1R" }]);
  await expect(page.getByTestId("table-qr-panel")).toBeVisible();
  await expect(page.getByTestId("qr-common")).toHaveCount(0);
  await expect(page.getByTestId("qr-menu-t1")).toBeVisible();
  await expect(page.getByTestId("qr-review-t1")).toBeVisible();
  await expect(page.getByTestId("qr-menu-general")).toHaveAttribute("data-url", MENU);
  await expect(page.getByTestId("qr-review-general")).toHaveAttribute("data-url", REVIEW);
});
