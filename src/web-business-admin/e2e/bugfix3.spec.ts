import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, openAs } from "./helpers";

// Bug-fix round 3 (docs/UI_REVIEW.md leftovers, business types, delivery admin, offline clock). Registers India restaurants
// directly (no dependency on legacy-country registration).

interface Biz { token: string; refresh: string; auth: Record<string, string>; itemId: string; email: string }
async function register(request: APIRequestContext, types?: string[]): Promise<Biz> {
  const email = `b3-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.in`;
  const reg = await request.post(`${API}/auth/register-restaurant`, { data: {
    restaurant_name: "Bugfix Dhaba", country: "IN", trn: "27AAPFU0939F1ZV", owner_email: email, owner_name: "Owner", owner_password: "supersecret123",
    ...(types ? { business_types: types } : {}) } });
  expect(reg.status(), await reg.text()).toBe(201);
  const pair = await reg.json();
  const auth = { Authorization: `Bearer ${pair.access_token}` };
  const cat = await (await request.post(`${API}/menu/categories`, { headers: auth, data: { name: "Mains" } })).json();
  const item = await (await request.post(`${API}/menu/items`, { headers: auth, data: { category_id: cat.id, name: "Paneer Tikka", price: "250.00" } })).json();
  return { token: pair.access_token, refresh: pair.refresh_token, auth, itemId: item.id, email };
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("Customers empty state: one primary action per view (the empty-state action is secondary)", async ({ page, request }) => {
  const s = await register(request);
  await openAs(page, s.token, "/manage?tab=customers", s.refresh);
  await expect(page.getByRole("button", { name: /add your first customer|add first customer/i })).toBeVisible();
  const primaries = page.locator("main .ch-btn--primary:visible");
  await expect(primaries).toHaveCount(1);
});

test("Procurement: no lone disabled Export CSV; the top bar names the page", async ({ page, request }) => {
  const s = await register(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAs(page, s.token, "/procurement", s.refresh);
  await expect(page.getByRole("button", { name: "New purchase order" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Export CSV" })).toHaveCount(0);
  await expect(page.locator(".vt-topbar")).toContainText("Orders & receiving");
  await page.goto("/audit");
  await expect(page.locator(".vt-topbar")).toContainText("Audit log");
});

test("Restaurant: GST rates heading has no '(set by system)' next to the chip; kitchen target is a remembered setting", async ({ page, request }) => {
  const s = await register(request);
  await openAs(page, s.token, "/manage?tab=restaurant", s.refresh);
  await expect(page.getByText("Set by system", { exact: true })).toBeVisible();
  await expect(page.getByText(/\(set by system\)/i)).toHaveCount(0);
  const target = page.getByTestId("kitchen-target");
  await expect(target).toHaveValue("15");
  await target.fill("3");
  await expect(page.getByText("Enter 5 to 90 minutes")).toBeVisible();
  await target.fill("20");
  await page.getByRole("button", { name: "Save target" }).click();
  await expect(page.getByText("Getting late from")).toContainText("20 min");
  await page.reload();
  await expect(page.getByTestId("kitchen-target")).toHaveValue("20");
  expect(await page.evaluate(() => localStorage.getItem("pos.kitchen.targetMin"))).toBe("20");
});

test("AI drawer subtitle is not cut off; Reports KPI hints sit inside their cards", async ({ page, request }) => {
  const s = await register(request);
  const o = await (await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "takeaway", lines: [{ item_id: s.itemId, quantity: 1 }] } })).json();
  const bill = await (await request.post(`${API}/orders/${o.id}/bill`, { headers: s.auth })).json();
  expect((await request.post(`${API}/bills/${bill.id}/payments`, { headers: s.auth, data: { idempotency_key: crypto.randomUUID(), method: "cash", amount: bill.total } })).ok()).toBeTruthy();
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAs(page, s.token, "/reports", s.refresh);
  const card = page.getByRole("group", { name: /^Gross sales/ }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Before refunds");
  await page.getByRole("button", { name: "AI assistant" }).click();
  const sub = page.getByText("Ask plain questions about your restaurant.");
  await expect(sub).toBeVisible();
  expect(await sub.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});

test("POS totals and dish cards are axe clean with a dish in the cart (360 and 1280, light only)", async ({ page, request }) => {
  const s = await register(request);
  for (const [w, h, scheme] of [[1280, 800, "light"], [360, 740, "light"]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.emulateMedia({ colorScheme: scheme });
    await openAs(page, s.token, "/pos", s.refresh);
    await page.getByRole("button", { name: /^Paneer Tikka,/ }).first().click();
    await page.waitForTimeout(800);
    expect(await axe(page), `axe /pos @${w} ${scheme}`).toEqual([]);
    expect(await noHScroll(page)).toBe(true);
  }
});

test("Clock in works offline: queued with client_uuid and device time, shows 'Will sync', syncs when back online", async ({ page, request, context }) => {
  const s = await register(request);
  await openAs(page, s.token, "/manage", s.refresh);
  await expect(page.getByRole("button", { name: "Clock in/out" })).toBeVisible();
  await context.setOffline(true);
  const sent: unknown[] = [];
  page.on("request", (r) => { if (r.url().includes("/attendance/clock-in")) sent.push(r.postDataJSON()); });
  await page.getByRole("button", { name: "Clock in/out" }).click();
  await page.getByRole("dialog", { name: "Clock in/out" }).getByTestId("clock-action").click();
  await expect(page.getByText(/Will sync when online/)).toBeVisible();
  await page.getByRole("button", { name: "Clock in/out" }).click();
  const dlg = page.getByRole("dialog", { name: "Clock in/out" });
  await expect(dlg.getByTestId("clock-will-sync")).toContainText("Will sync");
  await expect(dlg).toContainText("Clocked in since");
  await expect(dlg.getByTestId("clock-action")).toHaveText("Clock out");
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.getByText("Clock time synced")).toBeVisible({ timeout: 20_000 });
  const body = sent.at(-1) as { client_uuid: string; at: string };
  expect(body.client_uuid).toMatch(/^[0-9a-f-]{36}$/);
  expect(Date.now() - Date.parse(body.at)).toBeLessThan(10 * 60_000);
  const me = await (await request.get(`${API}/attendance/me`, { headers: s.auth })).json();
  expect(me.open?.client_uuid).toBe(body.client_uuid);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("pos.clockQueue:")).length)).toBe(0);
});

test("Cloud kitchen: no Dine-in/Outdoor, no Tables, no Reservations; Delivery section with link, QR and orders", async ({ page, request }) => {
  const s = await register(request, ["cloud_kitchen"]);
  const me = await (await request.get(`${API}/auth/me`, { headers: s.auth })).json();
  test.skip(!me.capabilities, "server without business types");
  await page.setViewportSize({ width: 1280, height: 800 });
  // The server has no public ordering link yet: the page shows one when it does (mocked here).
  await page.route("**/api/v1/delivery/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const r = await route.fetch(); const j = await r.json();
    await route.fulfill({ status: 200, json: { ...j, public_order_enabled: true, public_order_url: "https://order.example.in/r/bugfix-dhaba" } }); // link switched on (ordering-link card)
  });
  let accepted = "";
  await page.route("**/api/v1/delivery/admin/orders", (route) => route.fulfill({ json: [
    { order_id: "o1", order_code: "D0042", status: "placed", version: 1, subtotal: 25000, delivery_fee: 3000, tax: 1250, total: 29250, channel: "web", payment_mode: "cod", claimed_paid: false, payment_confirmed: false, customer: { name: "Asha", wa_number: "+919876543210" }, address: { text: "12 MG Road" } },
    { order_id: "o2", order_code: "D0043", status: "ready", version: 3, subtotal: 10000, delivery_fee: 0, tax: 500, total: 10500, channel: "web", payment_mode: "online", claimed_paid: true, payment_confirmed: false, customer: { name: "Ravi", wa_number: null }, address: { text: "" } },
  ] }));
  await page.route("**/api/v1/delivery/admin/orders/*/accept", (route) => { accepted = route.request().url(); return route.fulfill({ json: {} }); });

  await openAs(page, s.token, "/pos", s.refresh);
  const types = page.getByRole("radiogroup", { name: "Order type" }).getByRole("radio");
  await expect(types).toHaveText(["Takeaway", "Delivery"]);
  await expect(page.getByRole("link", { name: "Reservations" })).toHaveCount(0);

  await page.goto("/manage?tab=tables");
  await expect(page.getByRole("navigation", { name: "Manage sections" }).getByRole("link", { name: "Tables" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Manage sections" }).getByRole("link", { name: "Reservations" })).toHaveCount(0); // Reservations is a Manage entry: absent for a cloud kitchen
  await expect(page.getByRole("navigation", { name: "Manage sections" }).getByRole("link", { name: "Reports", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible(); // Tables is not a section here
  await page.goto("/reservations");
  await expect(page.getByText("Reservations are not part of your business type")).toBeVisible();

  await page.goto("/manage?tab=delivery");
  await expect(page.getByRole("heading", { level: 1, name: "Delivery" })).toBeVisible();
  await expect(page.getByTestId("order-link")).toHaveText("https://order.example.in/r/bugfix-dhaba");
  await expect(page.getByTestId("order-qr")).toBeVisible();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByText("Ordering link copied")).toBeVisible();
  const toggle = page.getByTestId("delivery-enabled");
  const was = await toggle.isChecked();
  await toggle.click({ force: true });
  await expect(page.getByText(was ? "Delivery orders are off" : "Delivery orders are on")).toBeVisible();
  const settings = await (await request.get(`${API}/delivery/settings`, { headers: s.auth })).json();
  expect(settings.enabled).toBe(!was);
  const table = page.getByRole("table", { name: "Delivery orders" });
  await expect(table).toContainText("D0042");
  await expect(table).toContainText("₹292.50");
  await expect(table).toContainText("Says paid online");
  await page.getByRole("radio", { name: /^New \(/ }).click();
  await expect(table).not.toContainText("D0043");
  await table.getByRole("button", { name: "Accept" }).click();
  await expect.poll(() => accepted).toContain("/delivery/admin/orders/o1/accept");

  for (const [w, h, scheme] of [[1280, 800, "light"], [360, 740, "light"]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/manage?tab=delivery");
    await expect(page.getByTestId("order-qr")).toBeVisible();
    expect(await axe(page), `axe delivery @${w} ${scheme}`).toEqual([]);
    expect(await noHScroll(page)).toBe(true);
  }
});

test("Owner changes the business type in Manage > Restaurant (warning when screens get hidden)", async ({ page, request }) => {
  const s = await register(request, ["restaurant"]);
  const me = await (await request.get(`${API}/auth/me`, { headers: s.auth })).json();
  test.skip(!me.capabilities, "server without business types");
  await openAs(page, s.token, "/manage?tab=restaurant", s.refresh);
  const card = page.getByTestId("business-type");
  await expect(card.getByRole("checkbox", { name: /Restaurant/ })).toBeChecked();
  await card.getByRole("checkbox", { name: /Cloud kitchen/ }).check();
  await card.getByRole("checkbox", { name: /Restaurant/ }).uncheck();
  await card.getByRole("button", { name: "Save business type" }).click();
  const confirm = page.getByRole("dialog", { name: "Change the business type?" });
  await expect(confirm).toContainText("Tables");
  await expect(confirm).toContainText("Reservations");
  await confirm.getByRole("button", { name: "Change business type" }).click();
  await expect.poll(async () => (await (await request.get(`${API}/restaurant`, { headers: s.auth })).json()).business_types).toEqual(["cloud_kitchen"]);
  await page.waitForLoadState("load");
  await expect(page.getByRole("navigation", { name: "Manage sections" }).getByRole("link", { name: "Delivery" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("navigation", { name: "Manage sections" }).getByRole("link", { name: "Tables" })).toHaveCount(0);
  // and back: Restaurant + Cloud kitchen brings Tables back
  await page.getByTestId("business-type").getByRole("checkbox", { name: /Restaurant/ }).check();
  await page.getByTestId("business-type").getByRole("button", { name: "Save business type" }).click();
  await expect(page.getByRole("navigation", { name: "Manage sections" }).getByRole("link", { name: "Tables" })).toBeVisible({ timeout: 20_000 });
});

test("New screens are axe clean and fit at 360 and 1280, light only", async ({ page, request }) => {
  test.setTimeout(6 * 60_000); // 6 pages x 4 viewports
  const s = await register(request, ["restaurant", "cloud_kitchen"]);
  for (const path of ["/manage", "/manage?tab=restaurant", "/manage?tab=customers", "/procurement", "/manage?tab=menu", "/reports"]) {
    for (const [w, h, scheme] of [[1280, 800, "light"], [360, 740, "light"]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme });
      await openAs(page, s.token, path, s.refresh);
      await page.waitForTimeout(1200);
      expect.soft(await axe(page), `axe ${path} @${w} ${scheme}`).toEqual([]);
      expect.soft(await noHScroll(page), `no horizontal scroll ${path} @${w}`).toBe(true);
    }
  }
});
