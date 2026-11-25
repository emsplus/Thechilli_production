import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { API, seedIn, signIn, type Seed } from "./helpers";

// Table QR codes (pos-service docs/TABLE_QR_REVIEWS.md) against the live e2e API: the owner's QR sheet (PNG card, A4 PDF,
// regenerate), the public view-only menu page and the review page (served by pos-service at /m/<token> and /rv/<token>, phone
// 390 px and desktop), the owner's Reviews page and the low-rating entry on Alerts. SHOT_DIR=<dir> writes screenshots.

const SHOT = process.env.SHOT_DIR;
const shot = async (page: Page, name: string) => { if (SHOT) await page.screenshot({ path: `${SHOT}/${name}.png`, fullPage: true }); };

async function richMenu(request: APIRequestContext, s: Seed) {
  const h = { headers: s.auth };
  const starters = await (await request.post(`${API}/menu/categories`, { ...h, data: { name: "Starters" } })).json();
  const add = async (data: Record<string, unknown>) => { const r = await request.post(`${API}/menu/items`, { ...h, data }); expect(r.status(), await r.text()).toBe(201); return r.json(); };
  await add({ category_id: starters.id, name: "Hara Bhara Kabab", price: "180.00", food_type: "veg", description: "Spinach and green pea patties" });
  const chicken = await add({ category_id: starters.id, name: "Chicken 65", price: "260.00", food_type: "non_veg" });
  await add({ category_id: s.catId, name: "Dal Makhani", price: "220.00", food_type: "veg", variants: [{ name: "Half", price_delta: "0" }, { name: "Full", price_delta: "120.00" }] });
  for (const n of ["Jeera Rice", "Butter Naan", "Gulab Jamun"]) await add({ category_id: s.catId, name: n, price: "90.00", food_type: "veg" });
  expect((await request.patch(`${API}/menu/items/${chicken.id}/sold-out`, { ...h, data: { sold_out: true } })).status()).toBe(200);
  expect((await request.post(`${API}/tables`, { ...h, data: { label: "T2" } })).status()).toBe(201);
}

async function links(request: APIRequestContext, s: Seed) {
  const r = await request.get(`${API}/table-qr`, { headers: s.auth });
  expect(r.status(), await r.text()).toBe(200);
  return r.json() as Promise<{ general: { menu_url: string; review_url: string }; tables: { label: string; table_id: string; menu_url: string; review_url: string }[] }>;
}

async function axe(page: Page) {
  const res = await new AxeBuilder({ page }).analyze();
  return res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.length}`);
}

test.describe("table QR codes", () => {
  test("owner prints menu and review QR codes: PNG card, A4 PDF sheet, regenerate", async ({ page, request }) => {
    const s = await seedIn(request);
    await richMenu(request, s);
    await signIn(page, s.token);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/manage?tab=tables");
    await page.getByTestId("table-qr-open").click();
    const panel = page.getByTestId("table-qr-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("qr-row-general")).toBeVisible();
    const before = await links(request, s);
    const t1 = before.tables.find((t) => t.label === "T1")!;
    await expect(panel.getByTestId(`qr-menu-${t1.table_id}`)).toHaveAttribute("data-url", t1.menu_url);
    expect(t1.menu_url).toMatch(/\/m\/[A-Za-z0-9_-]{63}$/);
    expect(t1.menu_url).not.toContain(t1.table_id);
    await shot(page, "qr-panel-1280");

    // One card as PNG
    const [png] = await Promise.all([page.waitForEvent("download"), panel.getByRole("button", { name: "Download Menu QR for Table T1 (PNG)" }).click()]);
    expect(png.suggestedFilename()).toBe("menu-qr-table-t1.png");
    expect(readFileSync((await png.path())!).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

    // Every table on A4 (restaurant-wide + T1 + T2 = 3 cards = 1 page)
    const [pdf] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), panel.getByRole("button", { name: "Menu QR sheet (A4 PDF)" }).click()]);
    expect(pdf.suggestedFilename()).toBe("menu-qr-all-tables.pdf");
    const bytes = readFileSync((await pdf.path())!);
    const txt = bytes.toString("latin1");
    expect(txt.startsWith("%PDF-1.4")).toBe(true);
    expect(txt).toContain("/Count 1");
    expect(txt).toContain("/MediaBox [0 0 595.28 841.89]");
    expect(txt).toContain("/Width 1654 /Height 2339");
    if (SHOT) writeFileSync(`${SHOT}/menu-qr-all-tables.pdf`, bytes);
    const [rpdf] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), panel.getByRole("button", { name: "Review QR sheet (A4 PDF)" }).click()]);
    expect(rpdf.suggestedFilename()).toBe("review-qr-all-tables.pdf");
    if (SHOT) writeFileSync(`${SHOT}/review-qr-all-tables.pdf`, readFileSync((await rpdf.path())!));

    // Regenerate T1: confirm, new code, the old one is dead at once, T2 untouched
    await panel.getByRole("button", { name: "Regenerate the QR codes of Table T1" }).click();
    await page.getByRole("button", { name: "Regenerate QR" }).click();
    await expect(page.getByText("New QR codes for Table T1. Print them now.")).toBeVisible();
    const after = await links(request, s);
    const t1b = after.tables.find((t) => t.label === "T1")!;
    expect(t1b.menu_url).not.toBe(t1.menu_url);
    await expect(panel.getByTestId(`qr-menu-${t1.table_id}`)).toHaveAttribute("data-url", t1b.menu_url);
    const tok = (u: string) => u.split("/").pop();
    expect((await request.get(`${API}/table-qr/public/menu/${tok(t1.menu_url)}`)).status()).toBe(404);
    expect((await request.get(`${API}/table-qr/public/menu/${tok(t1b.menu_url)}`)).status()).toBe(200);
    expect((await request.get(`${API}/table-qr/public/menu/${tok(before.tables.find((t) => t.label === "T2")!.menu_url)}`)).status()).toBe(200);
    await expect(page.getByText(/\bPOS\b/)).toHaveCount(0);
  });

  for (const size of [{ name: "390", width: 390, height: 844 }, { name: "1280", width: 1280, height: 900 }]) {
    test(`public menu page is view only, mobile first @${size.name}`, async ({ page, request }) => {
      const s = await seedIn(request);
      await richMenu(request, s);
      const t1 = (await links(request, s)).tables.find((t) => t.label === "T1")!;
      await page.setViewportSize(size);
      const errors: string[] = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      const res = await page.goto(t1.menu_url);
      expect(res!.headers()["content-security-policy"]).toContain("script-src 'self'");
      await expect(page.getByRole("heading", { level: 1, name: "Chilli Test Dhaba" })).toBeVisible();
      await expect(page.getByText("Table T1")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Starters" })).toBeVisible();
      await expect(page.getByText("Spinach and green pea patties")).toBeVisible();
      await expect(page.getByText("₹180")).toBeVisible();
      await expect(page.getByText("Half ₹220 · Full ₹340")).toBeVisible();
      await expect(page.getByRole("img", { name: "Vegetarian" }).first()).toBeVisible();
      await expect(page.getByRole("img", { name: "Non-vegetarian" })).toBeVisible();
      const sold = page.locator(".item.sold-out");
      await expect(sold).toHaveCount(1);
      await expect(sold).toContainText("Chicken 65");
      await expect(sold).toContainText("Sold out today");
      await expect(page.getByText("This menu is for viewing. Please order with your server.")).toBeVisible();
      await expect(page.getByText(/^(Prices include GST\.|GST extra as applicable\.)$/)).toBeVisible();
      await expect(page.getByRole("link", { name: "Rate your visit" })).toHaveAttribute("href", /^\/rv\//);
      // View only: no cart, no add, no order button.
      await expect(page.getByRole("button", { name: /add|cart|order|place/i })).toHaveCount(0);
      await expect(page.locator("text=/\\bPOS\\b/")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await page.evaluate(() => document.cookie)).toBe("");
      expect(await axe(page)).toEqual([]);
      await shot(page, `menu-page-${size.name}`);
      // Search
      await page.getByLabel("Search the menu").fill("naan");
      await expect(page.locator(".item:visible")).toHaveCount(1);
      await expect(page.getByText("Butter Naan")).toBeVisible();
      await page.getByLabel("Search the menu").fill("zzz");
      await expect(page.getByText("No dishes match your search.")).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  test("a revoked or bad menu code degrades to a friendly message", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${API.replace(/\/api\/v1$/, "")}/m/${"A".repeat(63)}`);
    await expect(page.getByRole("heading", { name: "This QR code is not active" })).toBeVisible();
    await expect(page.getByText("Please ask the staff for help or for a new QR code.")).toBeVisible();
    await shot(page, "menu-inactive-390");
  });

  test("guest reviews from a table; the owner sees it on Alerts and Reviews, exports CSV", async ({ page, browser, request }) => {
    const s = await seedIn(request);
    await richMenu(request, s);
    const put = await request.put(`${API}/table-qr/settings`, { headers: s.auth, data: { google_review_url: "https://g.page/r/chilli-test/review" } });
    expect(put.status(), await put.text()).toBe(200);
    const l = await links(request, s);
    const t2 = l.tables.find((t) => t.label === "T2")!;

    // Guest phone (no login, own context): 2 stars with a comment and contact
    const guest = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const g = await guest.newPage();
    await g.goto(t2.review_url);
    await expect(g.getByRole("heading", { level: 1, name: "Chilli Test Dhaba" })).toBeVisible();
    await expect(g.getByText("Table T2")).toBeVisible();
    await g.getByRole("button", { name: "Send review" }).click();
    await expect(g.getByText("Please choose 1 to 5 stars.")).toBeVisible();
    expect(await axe(g)).toEqual([]);
    await g.getByLabel("2 stars, poor").check({ force: true });
    await expect(g.getByText("2 of 5 · Poor")).toBeVisible();
    await g.getByLabel(/Anything to tell us/).fill("Food was cold. See www.spam.example for more");
    await g.getByLabel(/Your name/).fill("Asha");
    await g.getByLabel(/Phone or email/).fill("98765 43210");
    await shot(g, "review-form-390");
    await g.getByRole("button", { name: "Send review" }).click();
    await expect(g.getByRole("heading", { name: "Thank you!" })).toBeVisible();
    await expect(g.getByRole("link", { name: "Also share it on Google" })).toHaveCount(0);
    expect(g.url()).toContain("/rv/");
    await shot(g, "review-thanks-390");
    // A 5-star review from the restaurant-wide QR offers the Google link
    await g.goto(l.general.review_url);
    await g.getByLabel("5 stars, excellent").check({ force: true });
    await g.getByRole("button", { name: "Send review" }).click();
    await expect(g.getByRole("link", { name: "Also share it on Google" })).toHaveAttribute("href", "https://g.page/r/chilli-test/review");
    await shot(g, "review-thanks-google-390");
    await guest.close();

    // Owner: the bell's Alerts page shows the low rating, Reviews lists both, newest first
    await signIn(page, s.token);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/alerts");
    await expect(page.getByTestId("low-ratings-alert")).toContainText("1 new low rating");
    await page.getByRole("link", { name: "Open reviews" }).click();
    await expect(page).toHaveURL(/tab=reviews/);
    const list = page.getByTestId("review-list");
    await expect(list.getByTestId("review-item")).toHaveCount(2);
    await expect(list.getByTestId("review-item").first()).toHaveAttribute("data-rating", "5");
    const low = list.locator('[data-rating="2"]');
    await expect(low).toContainText("Table T2");
    await expect(low).toContainText("Food was cold. See for more");
    await expect(low).toContainText("Asha · +919876543210");
    await expect(page.getByTestId("reviews-average")).toContainText("3.5");
    await expect(page.getByTestId("reviews-total")).toHaveText("2");
    await expect(page.getByTestId("per-table")).toContainText("T2");
    await shot(page, "reviews-page-1280");
    // Filter by table and rating
    await page.getByLabel("Table", { exact: true }).selectOption({ label: "T2" });
    await expect(list.getByTestId("review-item")).toHaveCount(1);
    await page.getByLabel("Table", { exact: true }).selectOption({ label: "All tables" });
    await page.getByLabel("Rating", { exact: true }).selectOption("low");
    await expect(list.getByTestId("review-item")).toHaveCount(1);
    await page.getByLabel("Rating", { exact: true }).selectOption("");
    await expect(list.getByTestId("review-item")).toHaveCount(2);
    // CSV
    const [csv] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
    const text = readFileSync((await csv.path())!, "utf8");
    expect(text).toContain("Date and time,Table,Rating,Comment,Guest name,Guest phone or email");
    expect(text).toContain("T2,2,Food was cold. See for more,Asha,+919876543210");
    expect(text).toContain("Restaurant-wide QR,5");
    // Seen: the low rating no longer counts
    await expect.poll(async () => (await (await request.get(`${API}/reviews/summary`, { headers: s.auth })).json()).unread_low).toBe(0);
    await page.goto("/alerts");
    await expect(page.getByRole("heading", { name: "Alerts" })).toBeVisible();
    await expect(page.getByTestId("low-ratings-alert")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/manage?tab=reviews");
    await expect(page.getByTestId("review-list")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, "reviews-page-390");
    await expect(page.locator("text=/\\bPOS\\b/")).toHaveCount(0);
  });

  test("a waiter cannot open the QR codes or the reviews", async ({ request }) => {
    const s = await seedIn(request);
    const email = `w-${Date.now()}@example.in`;
    expect((await request.post(`${API}/auth/users`, { headers: s.auth, data: { email, full_name: "W", password: "supersecret123", role: "waiter" } })).status()).toBe(201);
    const login = await (await request.post(`${API}/auth/login`, { data: { email, password: "supersecret123" } })).json();
    const h = { Authorization: `Bearer ${login.access_token}` };
    expect((await request.get(`${API}/table-qr`, { headers: h })).status()).toBe(403);
    expect((await request.get(`${API}/reviews`, { headers: h })).status()).toBe(403);
  });
});
