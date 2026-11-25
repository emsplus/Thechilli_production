import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { signIn } from "./helpers";

// Simple sidebar (docs/testing/SIMPLE_SIDEBAR_REPORT.md): the sidebar lists only Chilli Agent, Orders, Kitchen, Inventory and Manage;
// Reservations, Customers, Reports, Cash drawer and End of day are entries of Manage and keep their own URLs.
// Every API call is mocked (playwright.mocked.config.ts): no stack. Roles carry the permissions pos-service gives them.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = () => `${b64({ alg: "none" })}.${b64({ sub: "u1", rid: "r1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

const POS = ["orders.create", "kot.view", "crm.read", "crm.write"];
const ADMIN = ["reports.view", "reports.close_day", "menu.manage", "tables.manage", "inventory.manage", "purchases.manage", "staff.view", "settings.manage", "printing.manage", "system.view", "delivery.manage", "billing.view"];
const PERMS: Record<string, string[]> = {
  owner: [...POS, "cashier.shift", "reservations.manage", ...ADMIN],
  manager: [...POS, "cashier.shift", "reservations.manage", ...ADMIN],
  cashier: [...POS, "cashier.shift", "reservations.manage"],
  waiter: [...POS, "reservations.manage"],
  kitchen: ["kot.view"],
};
const meOf = (role: string, extra: Record<string, unknown> = {}) => ({ id: "u1", email: `${role}@example.in`, full_name: role, role, is_active: true, restaurant_name: "Spice Garden", business_types: ["restaurant"],
  capabilities: { dine_in: true, tables: true, reservations: true }, permissions: PERMS[role], ...extra });
const REST = { name: "Spice Garden", currency: "INR", timezone: "Asia/Kolkata", country: "IN", currency_symbol: "₹", prices_include_tax: false };
const TAX = { country: "IN", currency: "INR", currency_symbol: "₹", timezone: "Asia/Kolkata", prices_include_tax: false, vat_registered: true, tax_number_label: "GSTIN", service_charge_percent: "0", max_cashier_discount_percent: "10",
  rates: [{ code: "standard", name: "GST", rate_percent: "5" }], rules: { eat_in: "x", takeaway: {}, eat_in_order_types: ["indoor", "outdoor"] } };
const SUMMARY = { menu_items: 12, categories: 3, tables: 4, inventory_items: 9, suppliers: 2, staff_active: 3, staff_inactive: 0, open_alerts: 0, items_without_recipe: 2, low_stock: 3 };

async function mock(page: Page, me: Record<string, unknown>, h: (path: string) => unknown | undefined = () => undefined) {
  await page.route("**/api/v1/**", async (route: Route) => {
    const u = new URL(route.request().url()); const path = u.pathname.replace(/^.*\/api\/v1/, "");
    const mine = await h(path);
    if (mine !== undefined) return route.fulfill({ json: mine });
    if (path === "/auth/me") return route.fulfill({ json: me });
    if (path === "/restaurant") return route.fulfill({ json: REST });
    if (path === "/billing/tax-config") return route.fulfill({ json: TAX });
    if (path === "/manage/summary") return route.fulfill({ json: SUMMARY });
    if (path === "/tables") return route.fulfill({ json: [] });
    // Report data is not what these specs are about: "not available" makes the Today strip and the report screens draw their quiet states
    if (path === "/billing/wallet" || path === "/cash-sessions/current" || path.startsWith("/reports/")) return route.fulfill({ status: 404, json: { detail: "n/a" } });
    return route.fulfill({ json: [] });
  });
}
const start = (page: Page | BrowserContext) => signIn(page, fakeJwt());
const side = (page: Page) => page.getByRole("complementary", { name: "Primary" });
const sideLinks = (page: Page) => side(page).locator("nav").getByRole("link");
const rail = (page: Page) => page.getByRole("navigation", { name: "Manage sections" });
const bar = (page: Page) => page.getByRole("navigation", { name: "Primary" });
const current = "aria-current";

test.describe("1280: owner", () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1280, height: 900 }); await mock(page, meOf("owner")); await start(page); });

  test("the sidebar is exactly Chilli Agent, Orders, Kitchen, Inventory, Manage; nothing that moved is left in it", async ({ page }) => {
    await page.goto("/manage");
    await expect(sideLinks(page)).toHaveText(["Chilli Agent", "Orders", "Kitchen", "Inventory", "Manage"]);
    for (const gone of ["Reservations", "Customers", "Reports", "Cash drawer", "End of day"]) await expect(side(page).getByRole("link", { name: gone, exact: true })).toHaveCount(0);
    await expect(side(page).getByRole("link", { name: "Manage", exact: true })).toHaveAttribute(current, "page");
    // the product name is Chilli Agent everywhere in the navigation, never the word POS
    await expect(side(page).getByText(/\bPOS\b/)).toHaveCount(0);
    await expect(rail(page).getByText(/\bPOS\b/)).toHaveCount(0);
  });

  test("Manage's navigation: Overview, Operations (Reservations, Customers, Reports, Cash drawer, End of day), Set up; Customers once", async ({ page }) => {
    await page.goto("/manage");
    await expect(rail(page).getByRole("link")).toHaveText(["Overview", "Reservations", "Customers", "Reports", "Cash drawer", "End of day", "Menu", "Tables", "Reviews", /^Recipes/, /^Inventory/, "Staff", "Restaurant", "Billing", "Printers"]);
    await expect(rail(page).getByRole("heading", { level: 2 })).toHaveText(["Operations", "Set up"]);
    await expect(rail(page).getByRole("link", { name: "Customers", exact: true })).toHaveCount(1);
    await expect(rail(page).getByRole("link", { name: "Overview" })).toHaveAttribute(current, "page");
  });

  test("Inventory opens the inventory tab; it lights Inventory (not Manage); any other tab lights Manage; Inventory stays in Manage's list", async ({ page }) => {
    await page.goto("/manage");
    await side(page).getByRole("link", { name: "Inventory", exact: true }).click();
    await expect(page).toHaveURL(/\/manage\?tab=inventory/);
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible();
    await expect(side(page).getByRole("link", { name: "Inventory", exact: true })).toHaveAttribute(current, "page");
    await expect(side(page).getByRole("link", { name: "Manage", exact: true })).not.toHaveAttribute(current, "page");
    await expect(rail(page).getByRole("link", { name: /^Inventory/ })).toHaveAttribute(current, "page");
    for (const tab of ["Menu", "Staff", "Overview"]) {
      await rail(page).getByRole("link", { name: tab, exact: true }).click();
      await expect(side(page).getByRole("link", { name: "Manage", exact: true })).toHaveAttribute(current, "page");
      await expect(side(page).getByRole("link", { name: "Inventory", exact: true })).not.toHaveAttribute(current, "page");
    }
    await rail(page).getByRole("link", { name: /^Inventory/ }).click();
    await expect(side(page).getByRole("link", { name: "Inventory", exact: true })).toHaveAttribute(current, "page");
  });

  test("each moved screen opens from Manage, keeps its URL, and lights Manage with its own entry current", async ({ page }) => {
    await page.goto("/manage");
    for (const [name, url, h1] of [["Reservations", /\/reservations$/, "Reservations"], ["Reports", /\/reports$/, "Reports"], ["Cash drawer", /\/cash$/, "Cash drawer"], ["End of day", /\/end-of-day$/, "End of day"]] as const) {
      await rail(page).getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(url);
      await expect(page.getByRole("heading", { level: 1, name: h1 })).toHaveCount(1);
      await expect(rail(page).getByRole("link", { name, exact: true })).toHaveAttribute(current, "page");
      await expect(rail(page).getByRole("link", { name: "Overview" })).not.toHaveAttribute(current, "page");
      await expect(side(page).getByRole("link", { name: "Manage", exact: true })).toHaveAttribute(current, "page");
      await expect(page.locator(".vt-topbar")).toContainText(new RegExp(`Manage\\s*›\\s*${h1}`)); // the top bar says "Manage › <screen>"
    }
    await rail(page).getByRole("link", { name: "Customers", exact: true }).click();
    await expect(page).toHaveURL(/\/manage\?tab=customers/); // the existing Customers tab, not a second copy
    await expect(rail(page).getByRole("link", { name: "Customers", exact: true })).toHaveAttribute(current, "page");
  });

  test("deep links, bookmarks and old URLs still open (inside the Manage frame)", async ({ page }) => {
    for (const [path, h1] of [["/reports", "Reports"], ["/reports?tab=leakage", "Reports"], ["/cash", "Cash drawer"], ["/end-of-day", "End of day"], ["/end-of-day?tab=history", "End of day"], ["/reservations", "Reservations"]] as const) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path.split("?")[0]}`));
      await expect(page.getByRole("heading", { level: 1, name: h1 })).toHaveCount(1);
      await expect(rail(page)).toBeVisible();
      await expect(side(page).getByRole("link", { name: "Manage", exact: true })).toHaveAttribute(current, "page");
    }
    await page.goto("/reports?tab=leakage");
    await expect(page).toHaveURL(/\/reports\?tab=leakage$/); // query kept
    await page.goto("/today");
    await expect(page).toHaveURL(/\/manage$/);
    await page.goto("/customers");
    await expect(page).toHaveURL(/\/manage\?tab=customers/);
    await page.goto("/manage?tab=inventory");
    await expect(side(page).getByRole("link", { name: "Inventory", exact: true })).toHaveAttribute(current, "page");
    for (const [old, to] of [["/modifiers", /tab=menu&view=modifiers/], ["/offers", /tab=menu&view=offers/], ["/attendance", /tab=staff&view=attendance/]] as const) {
      await page.goto(old);
      await expect(page).toHaveURL(to);
      await expect(side(page).getByRole("link", { name: "Manage", exact: true })).toHaveAttribute(current, "page");
    }
  });

  test("the attention counts stay on Manage's Inventory and Recipes entries", async ({ page }) => {
    await page.goto("/manage");
    await expect(rail(page).getByRole("link", { name: /Inventory/ })).toContainText("3");
    await expect(rail(page).getByRole("link", { name: /Recipes/ })).toContainText("2");
  });

  test("the sidebar draws skeleton rows (never a short list) while the permissions answer is slow, then the full five", async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mock(page, meOf("owner"), (path) => (path === "/auth/me" ? new Promise((r) => setTimeout(() => r(meOf("owner")), 2500)) : undefined));
    await page.goto("/reports");
    await expect(side(page).getByTestId("nav-skeleton")).toBeVisible();
    await expect(side(page).getByTestId("nav-skeleton").locator(":scope > div")).toHaveCount(5);
    await expect(side(page).getByRole("link", { name: "Manage", exact: true })).toHaveCount(0);
    await expect(sideLinks(page)).toHaveText(["Chilli Agent", "Orders", "Kitchen", "Inventory", "Manage"], { timeout: 15_000 });
    await expect(side(page).getByTestId("nav-skeleton")).toHaveCount(0);
    await expect(rail(page).getByRole("link", { name: "Reports", exact: true })).toBeVisible();
  });
});

test.describe("1280: other roles (the role matrix)", () => {
  for (const role of ["manager"] as const) {
    test(`${role}: the same five and the same Manage entries as the owner`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 }); await mock(page, meOf(role)); await start(page);
      await page.goto("/manage");
      await expect(sideLinks(page)).toHaveText(["Chilli Agent", "Orders", "Kitchen", "Inventory", "Manage"]);
      await expect(rail(page).getByRole("link")).toHaveCount(18);
    });
  }

  test("cashier: Chilli Agent, Orders, Kitchen, Manage; Manage opens Customers and lists only Customers and Cash drawer (no reports.view)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 }); await mock(page, meOf("cashier")); await start(page);
    await page.goto("/pos");
    await expect(sideLinks(page)).toHaveText(["Chilli Agent", "Orders", "Kitchen", "Manage"]);
    await side(page).getByRole("link", { name: "Manage", exact: true }).click();
    await expect(page).toHaveURL(/\/customers$/);
    await expect(rail(page).getByRole("link")).toHaveText(["Customers", "Cash drawer"]);
    await expect(rail(page).getByRole("link", { name: "Customers" })).toHaveAttribute(current, "page");
    await rail(page).getByRole("link", { name: "Cash drawer" }).click();
    await expect(page).toHaveURL(/\/cash$/);
    await expect(page.getByRole("heading", { level: 1, name: "Cash drawer" })).toHaveCount(1);
    await expect(side(page).getByRole("link", { name: "Manage", exact: true })).toHaveAttribute(current, "page");
    // the owner-only tabs are not theirs
    await page.goto("/manage?tab=menu");
    await expect(page).toHaveURL(/\/customers$/);
    await expect(rail(page).getByRole("link", { name: "Menu" })).toHaveCount(0);
  });

  test("cashier who also holds reports.view (custom role) reaches Reports through Manage", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 }); await mock(page, meOf("cashier", { permissions: [...PERMS.cashier, "reports.view"] })); await start(page);
    await page.goto("/reports");
    await expect(rail(page).getByRole("link")).toHaveText(["Customers", "Reports", "Cash drawer"]);
    await expect(rail(page).getByRole("link", { name: "Reports" })).toHaveAttribute(current, "page");
  });

  test("waiter: Chilli Agent, Orders, Kitchen, Manage; Manage holds Customers only (no cashier.shift)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 }); await mock(page, meOf("waiter")); await start(page);
    await page.goto("/pos");
    await expect(sideLinks(page)).toHaveText(["Chilli Agent", "Orders", "Kitchen", "Manage"]);
    await side(page).getByRole("link", { name: "Manage", exact: true }).click();
    await expect(page).toHaveURL(/\/customers$/);
    await expect(rail(page).getByRole("link")).toHaveText(["Customers"]);
  });

  test("kitchen: no Manage at all; /manage is the friendly dead end; /reports shows its own lock panel without a Manage navigation", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 }); await mock(page, meOf("kitchen")); await start(page);
    await page.goto("/orders");
    await expect(sideLinks(page)).toHaveText(["Kitchen"]);
    await page.goto("/manage");
    await expect(page.getByRole("heading", { name: "Ask the owner or manager" })).toBeVisible();
    await page.goto("/reports");
    await expect(rail(page)).toHaveCount(0);
  });

  test("an owner on a plan without inventory has no Inventory item; the tab (kept in Manage) lights Manage instead of nothing", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await mock(page, meOf("owner", { entitlements: { features: { inventory: { enabled: false, limit: null } } } })); await start(page);
    await page.goto("/manage?tab=inventory");
    await expect(sideLinks(page)).toHaveText(["Chilli Agent", "Orders", "Kitchen", "Manage"]);
    await expect(side(page).getByRole("link", { name: "Manage", exact: true })).toHaveAttribute(current, "page");
    await expect(rail(page).getByRole("link", { name: /^Inventory/ })).toHaveCount(1); // the tab inside Manage is unchanged
  });

  test("a cloud kitchen has no Reservations entry", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await mock(page, meOf("owner", { capabilities: { dine_in: false, outdoor: false, tables: false, reservations: false } })); await start(page);
    await page.goto("/manage");
    await expect(rail(page).getByRole("link", { name: "Reservations" })).toHaveCount(0);
    await expect(rail(page).getByRole("link", { name: "Reports", exact: true })).toBeVisible();
  });
});

test.describe("390: phone", () => {
  test("owner: bottom bar Chilli Agent, Orders, Inventory, Manage; Kitchen in More; the picker lists the moved screens; a back link to Manage on them", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await mock(page, meOf("owner")); await start(page);
    await page.goto("/manage");
    await expect(bar(page).getByRole("link")).toHaveText(["Chilli Agent", "Orders", "Inventory", "Manage"]);
    await expect(bar(page).getByRole("link", { name: "Manage" })).toHaveAttribute(current, "page");
    await bar(page).getByRole("button", { name: "More" }).click();
    const more = page.getByRole("dialog", { name: "More" });
    await expect(more.getByRole("link", { name: "Kitchen" })).toBeVisible();
    for (const gone of ["Reservations", "Reports", "Cash drawer", "End of day", "Customers"]) await expect(more.getByRole("link", { name: gone })).toHaveCount(0);
    await page.keyboard.press("Escape");
    const picker = page.getByRole("combobox", { name: "Manage section" });
    expect(await picker.locator("option").allInnerTexts()).toEqual(expect.arrayContaining(["Reservations", "Customers", "Reports", "Cash drawer", "End of day", "Inventory", "Menu"]));
    expect(await picker.locator("optgroup").evaluateAll((g) => g.map((x) => x.getAttribute("label")))).toEqual(["Operations", "Set up"]);
    await picker.selectOption({ label: "Reports" });
    await expect(page).toHaveURL(/\/reports$/);
    await expect(bar(page).getByRole("link", { name: "Manage" })).toHaveAttribute(current, "page");
    const crumb = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumb.getByRole("link", { name: "Manage" })).toBeVisible();
    await expect(crumb).toContainText("Reports");
    await expect(picker).toHaveValue("reports");
    await picker.selectOption({ label: "Inventory" });
    await expect(page).toHaveURL(/\/manage\?tab=inventory/);
    await expect(bar(page).getByRole("link", { name: "Inventory" })).toHaveAttribute(current, "page");
    await expect(bar(page).getByRole("link", { name: "Manage" })).not.toHaveAttribute(current, "page");
    await picker.selectOption({ label: "Menu" });
    await expect(bar(page).getByRole("link", { name: "Manage" })).toHaveAttribute(current, "page");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("cashier and waiter: Chilli Agent, Orders, Kitchen, Manage", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const role of ["cashier", "waiter"]) {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await mock(page, meOf(role)); await start(page);
      await page.goto("/pos");
      await expect(bar(page).getByRole("link")).toHaveText(["Chilli Agent", "Orders", "Kitchen", "Manage"]);
      await bar(page).getByRole("link", { name: "Manage" }).click();
      await expect(page).toHaveURL(/\/customers$/);
      const picker = page.getByRole("combobox", { name: "Manage section" });
      expect(await picker.locator("option").allInnerTexts()).toEqual(role === "cashier" ? ["Customers", "Cash drawer"] : ["Customers"]);
    }
  });

  test("the bottom bar draws skeletons while the role is unknown", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mock(page, meOf("owner"), (path) => (path === "/auth/me" ? new Promise((r) => setTimeout(() => r(meOf("owner")), 2500)) : undefined));
    await start(page);
    await page.goto("/reports");
    await expect(page.getByTestId("tab-skeleton").first()).toBeVisible();
    await expect(bar(page).getByRole("link", { name: "Manage" })).toHaveCount(0);
    await expect(bar(page).getByRole("link")).toHaveText(["Chilli Agent", "Orders", "Inventory", "Manage"], { timeout: 15_000 });
  });
});
