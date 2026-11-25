import { expect, test, type Download, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { API, openAs, seedMenu } from "./helpers";
import { insightDay } from "./insights-seed";

// Reports -> the insight tabs (Leakage, Staff, Food cost, Profit & loss, Customers), the GST summary, PDF downloads for every tab,
// the cashier gate, the empty range, and Manage -> Overview "Needs attention". One day seeded through the API (see insights-seed.ts).

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const slug = (kind: string) => kind.replace(/_/g, "-");

async function openReports(page: Page, token: string, refresh: string, query = "") {
  await openAs(page, token, `/reports${query}`, refresh);
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
  await expect(tab(page, "Leakage")).toBeVisible(); // the first detail tab (daily sales, items, order types and purchases live above)
}
async function expectPdf(d: Download) {
  expect(readFileSync(await d.path()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
}

test("Leakage tab: flags by colour, KPIs, by-staff / by-reason / biggest, after-kitchen voids and the usage-gap explanation", async ({ page, request }) => {
  const d = await insightDay(request);
  await openReports(page, d.s.token, d.s.refresh);
  await tab(page, "Leakage").click();
  const r = page.getByTestId("leakage-report");
  await expect(r).toBeVisible();

  const flags = r.getByTestId("leakage-flags");
  await expect(flags).toContainText("Discounts are 8.8% of sales");
  await expect(flags).toContainText("cancelled after the kitchen ticket was sent");
  await expect(flags).toContainText("Refunds are 5.7% of sales");
  await expect(flags.getByRole("alert").first()).toContainText("Medium priority"); // medium = warning colour

  await expect(r.getByText("Discounts", { exact: true }).first()).toBeVisible();
  const disc = r.getByTestId("leak-discounts-staff");
  await expect(disc).toContainText("Mina Manager");
  await expect(disc).toContainText("3.40");
  await expect(disc).toContainText("20%");
  await expect(r.getByText("Regular customer").first()).toBeVisible();

  const after = r.getByTestId("leak-after-kitchen");
  await expect(after).toContainText("Mina Manager");
  await expect(after).toContainText("Customer left");
  await expect(after).toContainText("8.50");
  await expect(r.getByTestId("leak-voids-staff")).toContainText("Mina Manager");
  await expect(r.getByTestId("leak-refunds-staff")).toContainText("2.00");
  await expect(r.getByText("Cold food").first()).toBeVisible();
  await expect(r.getByTestId("leak-unpaid")).toContainText("No bills are waiting for payment");

  // no stock count in the period -> the report says why the usage gap is missing, and the API warning is shown once
  await expect(r.getByTestId("usage-gap")).toContainText("Usage gap not available");
  await expect(r.getByTestId("usage-gap")).toContainText("No stock count was done in this period");
  await expect(r.getByTestId("report-notices")).toContainText("Stock usage gap not computed");
});

test("Staff tab: sales and the discounts / cancelled / refunds each person handled", async ({ page, request }) => {
  const d = await insightDay(request);
  await openReports(page, d.s.token, d.s.refresh);
  await tab(page, "Staff").click();
  const t = page.getByRole("table", { name: "Sales by staff" });
  const mina = t.getByRole("row", { name: /Mina Manager/ });
  await expect(mina).toContainText("13.60");
  await expect(mina).toContainText("1 · 3.40"); // discounts
  await expect(mina).toContainText("1 · 8.50"); // the order she cancelled after the kitchen had it
  await expect(t.getByRole("row", { name: /owner/ })).toContainText("1 · 2.00"); // the refund
  await expect(t.getByRole("row", { name: /^Total/ })).toContainText("35.10");
});

test("Food cost tab: dishes with no recipe or no ingredient cost are listed apart as 'cost unknown'", async ({ page, request }) => {
  const d = await insightDay(request);
  await openReports(page, d.s.token, d.s.refresh);
  await tab(page, "Food cost").click();
  const list = page.getByTestId("no-recipe-list");
  await expect(list).toContainText("No recipe: cost unknown");
  await expect(list.getByRole("row", { name: /Cucumber Salad/ })).toContainText("No recipe");
  await expect(list.getByRole("row", { name: /Lamb Karahi/ })).toContainText("Ingredients without a cost: Lamb");
  await expect(page.getByTestId("report-notices")).toContainText("have no recipe");
});

test("Food cost tab: table with food-cost % and class badges (mocked report)", async ({ page, request }) => {
  const d = await insightDay(request);
  const base = await (await request.get(`${API}/reports/food-cost?from=${d.day}&to=${d.day}`, { headers: d.s.auth })).json();
  const dish = (item: string, cls: string | null, pct: string) => ({ item, has_recipe: true, cost_known: true, quantity: 10, revenue_excl_vat: "100.00", revenue_per_portion: "10.00", cost_per_portion: "3.00", food_cost_percent: pct, margin_per_portion: "7.00", total_cost: "30.00", total_margin: "70.00", classification: cls });
  await page.route("**/reports/food-cost*", (route: Route) => route.request().method() === "OPTIONS" ? route.fulfill({ status: 204, headers: CORS }) : route.fulfill({
    status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ ...base, warnings: [], dishes: [dish("Lamb Karahi", "star", "30.0"), dish("Garlic Naan", "dog", "55.0")], dishes_without_recipe: [],
      totals: { dishes_costed: 2, dishes_without_recipe: 0, portions: 20, revenue_excl_vat: "200.00", ingredient_cost: "60.00", gross_margin: "140.00", food_cost_percent: "30.0", revenue_without_recipe: "0.00" } }) }));
  await openReports(page, d.s.token, d.s.refresh);
  await tab(page, "Food cost").click();
  const t = page.getByRole("table", { name: "Food cost by dish" });
  await expect(t.getByRole("row", { name: /Lamb Karahi/ })).toContainText("30%");
  await expect(t.getByRole("row", { name: /Lamb Karahi/ })).toContainText("Star");
  await expect(t.getByRole("row", { name: /Garlic Naan/ })).toContainText("Dog");
  await expect(page.getByTestId("no-recipe-list")).toHaveCount(0);
});

test("Profit & loss tab: net sales, expenses by category, operating profit and the warnings", async ({ page, request }) => {
  const d = await insightDay(request);
  await openReports(page, d.s.token, d.s.refresh);
  await tab(page, "Profit & loss").click();
  const r = page.getByTestId("pnl-report");
  // sales excl. 5% GST and the operating profit come from the server (17.00 + 4.50 + 13.60 sold, 2.00 refunded, no ingredient cost, 74.29 expenses)
  const pl = await (await request.get(`${API}/reports/profit-and-loss?from=${d.day}&to=${d.day}`, { headers: d.s.auth })).json() as { net_sales_excl_vat: string; operating_profit: string };
  expect(Number(pl.net_sales_excl_vat)).toBeGreaterThan(30);
  await expect(r).toContainText("Net sales");
  await expect(r).toContainText(pl.net_sales_excl_vat);
  await expect(r).toContainText("Gross profit");
  await expect(r).toContainText("Telecom");
  await expect(r).toContainText("74.29");
  await expect(r).toContainText("Operating profit");
  await expect(r.getByText(pl.operating_profit.replace(/^-/, "")).first()).toBeVisible();
  await expect(r.getByText("Items without a recipe")).toBeVisible();
  await expect(r).toContainText("Expenses come from the Expenses list only");
});

test("GST summary: output GST by rate, and input GST from the expense when the server sends it", async ({ page, request }) => {
  const d = await insightDay(request);
  const g = await (await request.get(`${API}/reports/gst-summary?from=${d.day}&to=${d.day}`, { headers: d.s.auth })).json() as {
    by_rate: { rate_percent: string; tax: string }[]; input_tax?: { expenses: string; total: string } | null; net_payable?: string | null };
  const five = g.by_rate.find((x) => Number(x.rate_percent) === 5)!;
  expect(five).toBeTruthy();
  await openReports(page, d.s.token, d.s.refresh);
  const block = page.getByTestId("mis-gst");
  await expect(block).toContainText("GST summary");
  await expect(block.getByRole("table", { name: "GST summary" }).getByRole("row", { name: /^5%/ })).toContainText(five.tax);
  await expect(page.getByRole("tab", { name: "GST", exact: true })).toHaveCount(0); // one GST view, not a second tab
  if (g.input_tax) {
    const input = block.getByTestId("gst-input");
    await expect(input.getByRole("table", { name: "Input GST" }).getByRole("row", { name: /Expenses/ })).toContainText("13.37");
    await expect(input).toContainText(g.net_payable != null ? "Net GST payable" : "Input GST");
  }
});

test("Customers tab: KPIs and top customers", async ({ page, request }) => {
  const d = await insightDay(request);
  await openReports(page, d.s.token, d.s.refresh);
  await tab(page, "Customers").click();
  const r = page.getByTestId("customers-report");
  await expect(r.getByRole("table", { name: "Top customers" }).getByRole("row", { name: /Sam Regular/ })).toContainText("4.50");
  await expect(r).toContainText("New customers");
  await expect(r).toContainText("bills without one");
});

test("every tab has a Download PDF button that downloads a real PDF for the current range", async ({ page, request }) => {
  const d = await insightDay(request);
  await openReports(page, d.s.token, d.s.refresh);
  // Daily sales, items, order types and purchases are shown once (no duplicate tabs); their PDFs sit on those sections.
  for (const tabName of ["Daily sales", "Items", "Order types", "Purchases"]) await expect(tab(page, tabName)).toHaveCount(0);
  const cases: [string, string][] = [
    ["Leakage", "leakage"], ["Staff", "staff_sales"], ["Food cost", "food_cost"], ["Profit & loss", "profit_and_loss"], ["Customers", "customers"],
  ];
  const seen = new Set<string>();
  for (const [name, kind] of cases) {
    await tab(page, name).click();
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId(`pdf-${slug(kind)}`).click()]);
    expect(dl.suggestedFilename(), name).toMatch(new RegExp(`${slug(kind)}_\\d{4}-\\d{2}-\\d{2}_${d.day}\\.pdf$`));
    await expectPdf(dl);
    seen.add(kind);
  }
  for (const kind of ["sales_summary", "item_sales", "purchases"]) {
    const btn = page.getByTestId(`pdf-${slug(kind)}`);
    if (kind === "item_sales" && !(await btn.count())) continue; // the item ranking block is absent on servers without it
    const [dl] = await Promise.all([page.waitForEvent("download"), btn.click()]);
    expect(dl.suggestedFilename(), kind).toMatch(new RegExp(`^${slug(kind)}_`));
    await expectPdf(dl);
    seen.add(kind);
  }
  expect(seen.size).toBeGreaterThanOrEqual(7);
  // the daily sales CSV is on the daily sales chart, once
  await expect(page.getByRole("button", { name: "Download CSV" })).toHaveCount(1);

  // sales by category has its own PDF
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("sales-by-category").getByTestId("pdf-category-sales").click()]);
  expect(dl.suggestedFilename()).toMatch(/^category-sales_/);
  await expectPdf(dl);
});

test("a failing PDF shows a friendly message, not a broken page", async ({ page, request }) => {
  const d = await insightDay(request);
  await openReports(page, d.s.token, d.s.refresh);
  await page.route("**/reports/pdf*", (route) => route.request().method() === "OPTIONS" ? route.fulfill({ status: 204, headers: CORS }) : route.fulfill({ status: 500, headers: CORS, contentType: "application/json", body: JSON.stringify({ detail: "boom" }) }));
  await page.getByTestId("pdf-sales-summary").click();
  await expect(page.getByText("boom").or(page.getByText("Could not create the PDF")).first()).toBeVisible();
  await expect(page.getByTestId("pdf-sales-summary")).toBeEnabled();
});

test("deep link /reports?tab=leakage opens the Leakage tab", async ({ page, request }) => {
  const d = await insightDay(request);
  await openAs(page, d.s.token, "/reports?tab=leakage", d.s.refresh);
  await expect(tab(page, "Leakage")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("leakage-report")).toBeVisible();
});

test("a cashier cannot open the new data: friendly screen on /reports and 403 from every API", async ({ page, request }) => {
  const d = await insightDay(request);
  const h = { Authorization: `Bearer ${d.cashier.access_token}` };
  for (const p of ["leakage", "staff-sales", "food-cost", "profit-and-loss", "customers"]) {
    expect((await request.get(`${API}/reports/${p}?from=${d.day}&to=${d.day}`, { headers: h })).status(), p).toBe(403);
  }
  expect((await request.get(`${API}/reports/pdf?kind=leakage&from=${d.day}&to=${d.day}`, { headers: h })).status()).toBe(403);
  await openAs(page, d.cashier.access_token, "/reports", d.cashier.refresh_token);
  await expect(page.getByText("Ask the owner or manager")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Leakage" })).toHaveCount(0);
  await expect(page.getByText("Could not load reports")).toHaveCount(0);
});

test("an empty range shows a clean empty state; a manager can use the reports", async ({ page, request }) => {
  const d = await insightDay(request);
  await openReports(page, d.manager.access_token, d.manager.refresh_token);
  await page.getByRole("radio", { name: "Custom" }).click();
  await page.getByRole("textbox", { name: "From", exact: true }).fill("2020-01-01");
  await page.getByRole("textbox", { name: "To", exact: true }).fill("2020-01-02");
  await expect(page.getByText("No sales in this range")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Leakage" })).toHaveCount(0);
});

// ---- Manage -> Overview: Needs attention

test("Overview 'Needs attention' lists low stock, leakage flags and dishes without a recipe, and links to the right place", async ({ page, request }) => {
  const d = await insightDay(request);
  await openAs(page, d.s.token, "/manage", d.s.refresh);
  const card = page.getByTestId("needs-attention");
  await expect(card.getByRole("heading", { name: "Needs attention" })).toBeVisible();
  await expect(card).toContainText("running low");
  await expect(card).toContainText("Leakage check, last 7 days: 3 medium flags");
  await expect(card).toContainText("sold this week have no recipe");
  expect(await card.getByRole("link").count()).toBeLessThanOrEqual(5);
  await expect(page.getByText("Needs your attention")).toBeVisible(); // the existing card is untouched
  await card.getByRole("link", { name: /Open leakage report/ }).click();
  await expect(page).toHaveURL(/\/reports\?tab=leakage/);
  await expect(tab(page, "Leakage")).toHaveAttribute("aria-selected", "true");
});

test("Overview 'Needs attention' shows failed print jobs of the last day, only for printers that exist", async ({ page, request }) => {
  const d = await insightDay(request);
  const now = new Date().toISOString();
  const job = (id: string, printer_id: string, status: string) => ({ id, printer_id, printer_name: "Bar", kind: "kot", ref_id: null, copy_no: 1, reprint_no: 0, status, attempts: 3, last_error: "offline", created_by: null, created_at: now, sent_at: null, printed_at: null });
  const json = (body: unknown) => (route: Route) => route.request().method() === "OPTIONS" ? route.fulfill({ status: 204, headers: CORS }) : route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/print/printers", json([{ id: "p1", name: "Bar" }]));
  await page.route("**/print/jobs*", json([job("j1", "p1", "failed"), job("j2", "p1", "printed"), job("j3", "deleted-printer", "failed")]));
  await openAs(page, d.s.token, "/manage", d.s.refresh);
  const card = page.getByTestId("needs-attention");
  await expect(card).toContainText("1 print job failed in the last day");
  await expect(card.getByRole("link", { name: /Check printers/ })).toHaveAttribute("href", /tab=printers/);
});

test("Overview 'Needs attention': one failing request does not break the card", async ({ page, request }) => {
  const d = await insightDay(request);
  await page.route("**/reports/leakage*", (route) => route.request().method() === "OPTIONS" ? route.fulfill({ status: 204, headers: CORS }) : route.fulfill({ status: 500, headers: CORS, contentType: "application/json", body: JSON.stringify({ detail: "boom" }) }));
  await openAs(page, d.s.token, "/manage", d.s.refresh);
  const card = page.getByTestId("needs-attention");
  await expect(card).toContainText("running low");
  await expect(card).not.toContainText("Leakage check");
});

test("Overview 'Needs attention' all clear on a quiet restaurant", async ({ page, request }) => {
  const s = await seedMenu(request);
  await openAs(page, s.token, "/manage", s.refresh);
  await expect(page.getByTestId("needs-attention")).toContainText("Nothing needs attention");
});
