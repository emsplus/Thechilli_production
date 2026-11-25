import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { signIn } from "./helpers";

// Tester round (docs/testing/TESTER_BUGS_COUNTER_REPORT.md): seven counter / business-app defects, every API call mocked (no stack).
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = () => `${b64({ alg: "none" })}.${b64({ sub: "u1", rid: "r1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const ME = { id: "u1", email: "o@example.in", full_name: "Owner", role: "owner", is_active: true, restaurant_name: "Spice Garden", business_types: ["restaurant"], capabilities: { dine_in: true, tables: true } };
const REST = { name: "Spice Garden", currency: "INR", timezone: "Asia/Kolkata", country: "IN", currency_symbol: "₹", prices_include_tax: false };
const TAX = { country: "IN", currency: "INR", currency_symbol: "₹", timezone: "Asia/Kolkata", prices_include_tax: false, vat_registered: true, tax_number_label: "GSTIN", service_charge_percent: "0", max_cashier_discount_percent: "10",
  rates: [{ code: "standard", name: "GST", rate_percent: "5" }], rules: { eat_in: "x", takeaway: {}, eat_in_order_types: ["indoor", "outdoor"] } };
const TABLES = [{ id: "t1", label: "AC1", seats: 4, area: "indoor", is_active: true }, { id: "t2", label: "G1", seats: 2, area: "outdoor", is_active: true }];
const line = (id: string) => ({ id, item_id: "i1", item_name: "Paneer Tikka", unit_price: "270.00", quantity: 2, note: null });
const order = (id: string, status: string, over: Record<string, unknown> = {}) => ({ id, client_uuid: `c-${id}`, order_type: "indoor", table_id: "t1", status, lines: [line(`l-${id}`)], subtotal: "540.00", created_at: new Date().toISOString(), ...over });
const bill = (id: string, orderId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ id, order_id: orderId, invoice_number: `INV-${id}`, seller_name: "Spice Garden", seller_trn: null, currency: "INR", tax_name: "GST", tax_rate_percent: "5",
  subtotal: "540.00", tax_amount: "27.00", total: "567.00", country: "IN", vat_registered: true, prices_include_tax: false, lines: [{ id: "bl", description: "Paneer Tikka", quantity: 2, unit_price: "270.00", line_total: "540.00" }],
  payments: [], refunds: [], paid: "0.00", balance_due: "567.00", status: "active", table_label: "AC1", order_type: "indoor", sale_at: new Date().toISOString(), ...over });
const kot = (id: string, orderId: string, number: number) => ({ id, order_id: orderId, number, status: "pending", created_at: new Date().toISOString(), payload: [{ item: "Paneer Tikka", qty: 2, note: null }] });

type Handler = (path: string, search: URLSearchParams, route: Route) => unknown | undefined;
/** Mocks the whole API: known paths through `h` (return undefined to fall through), the common ones built in, the rest `[]`. */
async function mock(page: Page, h: Handler, me: Record<string, unknown> = ME) {
  await page.route("**/api/v1/**", async (route: Route) => {
    const u = new URL(route.request().url()); const path = u.pathname.replace(/^.*\/api\/v1/, "");
    const mine = await h(path, u.searchParams, route);
    if (mine === "handled") return;
    if (mine !== undefined) return route.fulfill({ json: mine });
    if (path === "/auth/me") return route.fulfill({ json: me });
    if (path === "/restaurant") return route.fulfill({ json: REST });
    if (path === "/billing/tax-config") return route.fulfill({ json: TAX });
    if (path === "/tables") return route.fulfill({ json: TABLES });
    if (path === "/billing/wallet") return route.fulfill({ status: 404, json: { detail: "n/a" } });
    return route.fulfill({ json: [] });
  });
}
async function start(page: Page | BrowserContext) { await signIn(page, fakeJwt()); }

// ---------------------------------------------------------------- 1. Take payment from Orders
test("1 Orders: every awaiting-payment bill has Take payment (card and bill dialog), the same pay sheet, list refreshes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const state: Record<string, Record<string, unknown>> = { b1: bill("b1", "o1"), b2: bill("b2", "o2", { invoice_number: "INV-b2", total: "100.00", balance_due: "100.00" }), b3: bill("b3", "o3", { balance_due: "0.00", paid: "567.00" }) };
  const posts: { path: string; body: Record<string, string> }[] = []; let orderLoads = 0;
  await mock(page, (path, _q, route) => {
    if (path === "/orders") { orderLoads++; return [order("o1", "billed"), order("o2", "billed", { table_id: "t2" }), order("o3", "billed")]; }
    if (path === "/bills") return [state.b1, state.b2, state.b3];
    if (/^\/bills\/b[12]\/payments$/.test(path)) {
      const id = path.split("/")[2]; const body = JSON.parse(route.request().postData() ?? "{}"); posts.push({ path, body });
      state[id] = { ...state[id], paid: state[id].total, balance_due: "0.00", payments: [{ id: "p", method: body.method, amount: body.amount }] };
      return { id: "p", method: body.method, amount: body.amount };
    }
    const m = /^\/bills\/(b[123])$/.exec(path); if (m) return state[m[1]];
    return undefined;
  });
  await start(page); await page.goto("/orders");
  const cards = page.getByTestId("order-card");
  await expect(cards).toHaveCount(3);
  // awaiting-payment cards (2) have the button, the paid one does not
  await expect(page.getByTestId("take-payment")).toHaveCount(2);
  await expect(cards.filter({ hasText: "INV-b3" }).getByTestId("take-payment")).toHaveCount(0);
  // pay b1 from the card: the counter's pay sheet (cash / card / UPI), cash exact
  await cards.filter({ hasText: "INV-b1" }).getByTestId("take-payment").click();
  const sheet = page.getByRole("dialog", { name: "Take payment" });
  await expect(sheet).toBeVisible();
  for (const k of ["Cash", "Card", "UPI"]) await expect(sheet.getByRole("radio", { name: k })).toBeVisible();
  await sheet.getByRole("radio", { name: "UPI" }).click();
  const before = orderLoads;
  await sheet.getByRole("button", { name: /Confirm payment/ }).click();
  await expect(sheet).toBeHidden();
  expect(posts[0].body).toMatchObject({ method: "upi", amount: "567.00" });
  await expect(page.getByTestId("take-payment")).toHaveCount(1); // the list refreshed
  expect(orderLoads).toBeGreaterThan(before);
  await expect(cards.filter({ hasText: "INV-b1" })).toContainText("Paid");
  // the bill dialog of the other bill has Take payment too
  await cards.filter({ hasText: "INV-b2" }).getByRole("button", { name: "View bill" }).click();
  const dlg = page.getByRole("dialog", { name: "INV-b2" });
  await expect(dlg.getByText("Awaiting payment")).toBeVisible();
  await dlg.getByTestId("bill-take-payment").click();
  const sheet2 = page.getByRole("dialog", { name: "Take payment" });
  await sheet2.getByRole("button", { name: /Confirm payment/ }).click();
  await expect(sheet2).toBeHidden();
  expect(posts[1]).toMatchObject({ path: "/bills/b2/payments", body: { method: "cash", amount: "100.00" } });
  await expect(page.getByTestId("take-payment")).toHaveCount(0);
  await expect(dlg.getByText("Paid in full")).toBeVisible(); // the open dialog shows the paid bill
});

// ---------------------------------------------------------------- 2. In kitchen: one rule for Orders and Kitchen; bill removes the ticket
test("2 Orders 'In kitchen' counts the same active tickets the Kitchen board shows; a billed order's ticket is not on the board", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // o1: open, its ticket is live (status of the order lags: the old tile said 0); o2: billed but a stale ticket is still served by an older server
  const kots = [kot("k1", "o1", 1), kot("k2", "o2", 2)];
  const api = (path: string) => {
    if (path === "/orders") return [order("o1", "open"), order("o2", "billed", { table_id: "t2" })];
    if (path === "/bills") return [bill("b2", "o2", { balance_due: "0.00", paid: "567.00" })];
    if (path === "/kot") return kots;
    return undefined;
  };
  await mock(page, api); await start(page);
  await page.goto("/orders");
  await expect(page.getByRole("radio", { name: /In kitchen/ })).toContainText("1");
  await page.goto("/kitchen");
  await expect(page.getByTestId("kot-ticket")).toHaveCount(1);
  await expect(page.getByTestId("kitchen")).toContainText("#1");
  await expect(page.getByTestId("kitchen-open-tickets")).not.toContainText("#2");
});

test("2 a bill made at the counter reloads the Kitchen board at once (no stale ticket)", async ({ context }) => {
  const kotsLive = [kot("k2", "o2", 2)]; let billed = false; let kotLoads = 0;
  const api = (path: string, _q: URLSearchParams, route: Route) => {
    if (path === "/orders") return [order("o2", billed ? "billed" : "sent_to_kitchen")];
    if (path === "/bills") return billed ? [bill("b2", "o2")] : [];
    if (path === "/kot") { kotLoads++; return billed ? [] : kotsLive; }
    if (path === "/orders/o2/bill") { billed = true; return bill("b2", "o2"); }
    if (path === "/menu/items") return [{ id: "i1", category_id: "c1", name: "Paneer Tikka", price: "270.00", is_active: true, variants: [] }];
    if (path === "/menu/categories") return [{ id: "c1", name: "Starters", sort_order: 1, is_active: true }];
    void route; return undefined;
  };
  const kitchen = await context.newPage(); const counter = await context.newPage();
  for (const p of [kitchen, counter]) await mock(p, api);
  await start(context);
  await kitchen.goto("/kitchen");
  await expect(kitchen.getByTestId("kot-ticket")).toHaveCount(1);
  await counter.setViewportSize({ width: 1280, height: 900 });
  await counter.goto("/pos?order=o2");
  await expect(counter.getByTestId("ticket-badge")).toContainText("Table AC1 · Indoor");
  const before = kotLoads;
  await counter.getByRole("button", { name: "Make bill" }).click();
  await expect(counter.getByRole("button", { name: /Pay cash/ }).or(counter.getByTestId("pay-row"))).toBeVisible();
  await expect(kitchen.getByTestId("kot-ticket")).toHaveCount(0, { timeout: 4000 }); // the kitchen poll is 10 s: this is the signal
  expect(kotLoads).toBeGreaterThan(before);
});

// ---------------------------------------------------------------- 3. Leakage wording
const META = { metric: "x", from_date: "2026-11-01", to_date: "2026-11-03", timezone: "Asia/Kolkata", currency: "INR", data_complete: true, incomplete_reason: null, warnings: [] };
const LEAK = (unpaid: Record<string, unknown>, flags: unknown[]) => ({ ...META,
  discounts: { count: 0, total: "0.00", sales_before_discount: "0.00", percent_of_sales: null, by_staff: [], by_reason: [], biggest: [] },
  voids: { count: 0, value: "0.00", before_kitchen: { count: 0, value: "0.00" }, after_kitchen: { count: 0, value: "0.00", orders: [] }, by_staff: [], by_reason: [] },
  refunds: { count: 0, value: "0.00", percent_of_sales: null, by_staff: [], by_reason: [], biggest: [] },
  corrections: { count: 0, value: "0", by_staff: [], by_reason: [], biggest: [], payout_to_customers: "0", net_change: "0" },
  unpaid_bills: { count: 0, balance: "0.00", min_age_days: 1, bills: [], ...unpaid }, payments_vs_takings: { payments: "0", takings: "0", difference: "0", note: null },
  stock: { total_loss_value: "0.00", by_type: [], items: [], usage_gap: { available: false, note: null } }, flags, warnings: [] });
const SALES = { ...META, days: [{ date: "2026-11-02", bills: 1, subtotal: "540.00", vat: "27.00", gross_total: "567.00", refunds: "0.00", net_total: "567.00" }], totals: { bills: 1, subtotal: "540.00", vat: "27.00", gross_total: "567.00", refunds: "0.00", net_total: "567.00" } };
function reportApi(o: { leak?: unknown; profit?: Record<string, unknown>; payUnpaid?: { bills: number; balance: string }; pnl?: unknown; payVoided?: number }) {
  return (path: string) => {
    if (path === "/reports/daily-sales") return SALES;
    if (path === "/reports/item-sales") return { ...META, items: [{ item: "Paneer Tikka", quantity: 2, revenue_excl_vat: "540.00" }] };
    if (path === "/reports/order-summary") return { ...META, billed_by_order_type: [], total_billed: "567.00", billed_orders: 1, average_bill_value: "567.00" };
    if (path === "/reports/purchases") return { ...META, suppliers: [], total: "0.00" };
    if (path === "/reports/profitability") return { ...META, revenue_excl_vat: "540.00", ingredient_cost: "0.00", gross_profit: "540.00", gross_margin_percent: "100.0", items_without_recipe: [], ingredients_without_cost: [], cost_method: "recipes", ...(o.profit ?? {}) };
    if (path === "/reports/leakage") return o.leak ?? LEAK({}, []);
    if (path === "/reports/profit-and-loss") return o.pnl;
    if (path === "/reports/payments") return (o.payUnpaid || o.payVoided !== undefined) ? { by_method: [{ method: "cash", payments: 1, amount: "10.00", share_percent: "100" }], by_cashier: [], totals: { collected: "10.00", refunds: "0.00", net_collected: "10.00", credit_note_transfers: "0.00" }, voided: { orders: o.payVoided ?? 0, value: "0.00" }, unpaid: o.payUnpaid ?? { bills: 0, balance: "0.00" } } : { status: 404 };
    if (path.startsWith("/reports/")) return "404";
    return undefined;
  };
}
async function mockReports(page: Page, fn: ReturnType<typeof reportApi>) {
  await mock(page, (path, q, route) => {
    const r = fn(path);
    if (r === "404") { void route.fulfill({ status: 404, json: { detail: "Not Found" } }); return "handled"; }
    if (r && typeof r === "object" && (r as { status?: number }).status === 404) { void route.fulfill({ status: 404, json: { detail: "Not Found" } }); return "handled"; }
    void q; return r;
  });
}

test("3 Leakage: a low 'awaiting payment' flag is information, not 'High priority'; never 'No bills are waiting' beside unpaid bills", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const leak = LEAK({ count: 0, balance: "0.00" }, [{ severity: "low", code: "unpaid_bills", message: "2 bills (₹1,134.00) are awaiting payment." }]);
  await mockReports(page, reportApi({ leak, payUnpaid: { bills: 2, balance: "1134.00" } }));
  await start(page); await page.goto("/reports?tab=leakage");
  const flags = page.getByTestId("leakage-flags");
  await expect(flags).toContainText("2 bills (₹1,134.00) are awaiting payment.");
  await expect(flags).toContainText("For your information");
  await expect(flags).not.toContainText("High priority");
  await expect(page.getByTestId("mis-payments")).toContainText("Unpaid bills");
  await expect(page.getByTestId("leak-unpaid")).not.toContainText("No bills are waiting for payment");
  await expect(page.getByTestId("leak-unpaid")).toContainText("2 bills are awaiting payment");
});

test("3 Leakage: unpaid bills in the report get an informational row even when the server sent no flag", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const leak = LEAK({ count: 1, balance: "567.00", bills: [{ invoice: "INV-9", total: "567.00", balance: "567.00", part_paid: false, age_days: 2, customer: null }] }, []);
  await mockReports(page, reportApi({ leak }));
  await start(page); await page.goto("/reports?tab=leakage");
  await expect(page.getByTestId("leak-awaiting-row")).toContainText("1 bill is awaiting payment");
  await expect(page.getByTestId("leakage-flags")).not.toContainText("High priority");
  await expect(page.getByTestId("leak-unpaid")).toContainText("INV-9");
});

// ---------------------------------------------------------------- 4. Same table, same area label everywhere
test("4 Table AC1 reads 'Table AC1 · Indoor' on Orders, the bill dialog and the Kitchen, whatever the order's own type says", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mock(page, (path) => {
    if (path === "/orders") return [order("o1", "open", { order_type: "indoor" }), order("o2", "sent_to_kitchen", { order_type: "outdoor" }), order("o3", "billed", { order_type: "outdoor" })];
    if (path === "/bills") return [bill("b3", "o3", { order_type: "outdoor" })];
    if (path === "/kot") return [kot("k2", "o2", 2)];
    return undefined;
  });
  await start(page); await page.goto("/orders");
  const where = page.getByTestId("order-where");
  await expect(where).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(where.nth(i)).toHaveText("Table AC1 · Indoor");
  await expect(page.getByTestId("orders-list")).not.toContainText("Outdoor");
  await expect(page.getByTestId("orders-list")).not.toContainText("Dine-in");
  await page.getByRole("button", { name: "View bill" }).click();
  await expect(page.getByTestId("bill-where")).toHaveText("Table AC1 · Indoor");
  await page.keyboard.press("Escape");
  await page.goto("/kitchen");
  const t = page.getByTestId("kot-ticket");
  await expect(t).toHaveCount(1);
  await expect(t).toContainText("Table AC1");
  await expect(t).toContainText("Indoor");
  await expect(t).not.toContainText("Outdoor");
});

// ---------------------------------------------------------------- 5. Gross profit with no recipes / costs
test("5 Gross profit: no costs set up shows 'Add recipe costs to see profit' (link to Recipes), not a 100% margin", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const pnl = { ...META, net_sales_excl_vat: "540.00", bills: 1, refunds_excl_vat: "0.00", ingredient_cost: "0.00", gross_profit: "540.00", gross_margin_percent: "100.0",
    expenses: { by_category: [], total: "0.00" }, operating_profit: "540.00", operating_margin_percent: "100.0", items_without_recipe: ["Paneer Tikka"], ingredients_without_cost: [], vat: { output_vat: "27.00", input_vat: "0.00", net_vat_due: "27.00", authority: null } };
  await mockReports(page, reportApi({ pnl }));
  await start(page); await page.goto("/reports?tab=pnl");
  const tile = page.getByTestId("gross-profit-unknown");
  await expect(tile).toContainText("Add recipe costs to see profit");
  await expect(tile.getByRole("link", { name: "Add recipe costs to see profit" })).toHaveAttribute("href", "/manage?tab=recipes");
  await expect(page.getByTestId("profit-card-unknown")).toContainText("Add recipe costs to see profit");
  await expect(page.getByTestId("pnl-profit-unknown")).toContainText("Add recipe costs to see profit");
  await expect(page.locator("main")).not.toContainText("100.0% margin");
  await expect(page.locator("main")).not.toContainText("100% margin");
});

test("5 Gross profit: with a real cost the margin still shows", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await mockReports(page, reportApi({ profit: { ingredient_cost: "162.00", gross_profit: "378.00", gross_margin_percent: "70.0" } }));
  await start(page); await page.goto("/reports");
  await expect(page.getByText("70.0% margin")).toBeVisible();
  await expect(page.getByTestId("gross-profit-unknown")).toHaveCount(0);
});

// ---------------------------------------------------------------- 6. Cash drawer
const OPENED = (hoursAgo: number, float = "500.00") => ({ id: "s1", cashier_id: "u1", status: "open", opened_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), opening_float: float, expected_cash: float });
const closedAt = (daysAgo: number, float: string) => ({ id: `c${daysAgo}`, cashier_id: "u1", status: "closed", opened_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(), opening_float: float });
const XREPORT = { kind: "X", empty: true, restaurant: { name: "Spice Garden", address: null, phone: null, country: "IN", tax_number_label: "GSTIN", tax_number: null, currency: "INR", currency_symbol: "₹", timezone: "Asia/Kolkata", prices_include_tax: false, vat_registered: true },
  till: "Till 1", period: { from: "2026-11-03T00:00:00Z", to: "2026-11-03T12:00:00Z", from_local: "03 Nov 2026, 12:00 AM", to_local: "03 Nov 2026, 5:30 PM", timezone: "Asia/Kolkata" }, channels: [],
  grand_total: { orders: 0, items: 0, disc: "0.00", sales: "0.00" },
  deductions: { item_discount: "0.00", bill_discounts: { count: 0, amount: "0.00", by_reason: [] }, gross_returns: { count: 0, amount: "0.00", amount_incl_tax: "0.00", items: [] }, card_commission: "0.00", other_charges: { service_charge: { count: 0, amount: "0.00" }, delivery_charge: { count: 0, amount: "0.00" }, total: "0.00" }, net_sales: "0.00", vat: "0.00", total_takings: "0.00" },
  deposits: { sub_total: "0.00" }, summary: { gross_sales: "0.00", net_sales: "0.00", service_charge: { count: 0, amount: "0.00" }, delivery_charge: { count: 0, amount: "0.00" }, total_charges: "0.00", payments: [], total_payments: "0.00", vat: { shown: false, rows: [], returns: null, total: null }, voids: { count: 0, amount: "0.00" }, deposit_sales: "0.00" },
  voids: { count: 0, amount: "0.00", orders: [] }, open_items: { open_orders: { count: 0, amount: "0.00" }, unpaid_bills: { count: 0, balance: "0.00" } },
  checks: { categories_add_up_to_total: true, takings_match_bill_totals: true, vat_matches_bills: true, vat_base_equals_net_sales: true, net_equals_payments_plus_outstanding: true, single_price_mode: false, all_ok: true }, warnings: [],
  checks_info: { payments_minus_takings: "0.00", note: "", bills_without_tax_breakdown: 0, bills_total: "0.00" }, id: null, number: null, number_label: null, closed_by: null, generated_at: "2026-11-03T12:00:00Z", completeness: { data_complete: true, incomplete_reason: null } };
function cashApi(session: unknown | null, history: unknown[], posts: unknown[]) {
  return (path: string, q: URLSearchParams, route: Route) => {
    if (path === "/cash-sessions" && route.request().method() === "POST") { const b = JSON.parse(route.request().postData() ?? "{}"); posts.push(b); void route.fulfill({ status: 201, json: { ...OPENED(0, b.opening_float) } }); return "handled"; }
    if (path === "/reports/x-report") return XREPORT;
    if (path === "/cash-sessions") return q.get("status") === "open" ? (session ? [session] : []) : history;
    return undefined;
  };
}

test("6 a shift open for over 24 hours: a banner on the counter, Cash drawer and End of day; a fresh shift has none", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mock(page, cashApi(OPENED(30), [], []));
  await start(page);
  for (const url of ["/pos", "/cash", "/end-of-day"]) {
    await page.goto(url);
    const b = page.getByTestId("shift-stale-banner");
    await expect(b).toContainText("This shift has been open for 30 hours. Close it before starting a new day");
  }
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mock(page, cashApi(OPENED(5), [], []));
  await page.goto("/cash");
  await expect(page.getByText("Shift open")).toBeVisible();
  await expect(page.getByTestId("shift-stale-banner")).toHaveCount(0);
});

test("6 opening float: 78,789 rupees asks to confirm (not a block); 500 opens straight away; over 3x the recent average asks too", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const posts: unknown[] = [];
  await mock(page, cashApi(null, [closedAt(1, "1000.00"), closedAt(2, "1000.00"), closedAt(3, "1000.00")], posts));
  await start(page); await page.goto("/cash");
  await page.getByRole("button", { name: "Open shift" }).click();
  const dlg = page.getByRole("dialog", { name: "Open shift" });
  await dlg.getByLabel("Opening float").fill("78789");
  await dlg.getByRole("button", { name: "Open shift" }).click();
  await expect(dlg.getByTestId("float-warning")).toContainText("more than ₹10,000");
  expect(posts).toHaveLength(0); // a confirm step, nothing sent yet
  await dlg.getByTestId("float-confirm").click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ opening_float: "78789" });
  // normal amount: no warning
  await page.reload();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mock(page, cashApi(null, [closedAt(1, "1000.00"), closedAt(2, "1000.00"), closedAt(3, "1000.00")], posts));
  await page.reload();
  await page.getByRole("button", { name: "Open shift" }).click();
  await page.getByRole("dialog", { name: "Open shift" }).getByLabel("Opening float").fill("1500");
  await page.getByRole("dialog", { name: "Open shift" }).getByRole("button", { name: "Open shift" }).click();
  await expect.poll(() => posts.length).toBe(2);
  // 4,000 is under 10,000 but over 3x the 1,000 average
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mock(page, cashApi(null, [closedAt(1, "1000.00"), closedAt(2, "1000.00"), closedAt(3, "1000.00")], posts));
  await page.reload();
  await page.getByRole("button", { name: "Open shift" }).click();
  const d2 = page.getByRole("dialog", { name: "Open shift" });
  await d2.getByLabel("Opening float").fill("4000");
  await d2.getByRole("button", { name: "Open shift" }).click();
  await expect(d2.getByTestId("float-warning")).toContainText("3 times");
  await d2.getByTestId("float-change").click();
  await expect(d2.getByTestId("float-warning")).toHaveCount(0);
});

test("6 an open shift with an unusual opening float shows the 'Unusual opening amount' chip; a normal one does not", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mock(page, cashApi(OPENED(2, "78789.00"), [closedAt(1, "1000.00")], []));
  await start(page); await page.goto("/cash");
  await expect(page.getByTestId("unusual-float-chip")).toHaveText("Unusual opening amount");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mock(page, cashApi(OPENED(2, "1200.00"), [closedAt(1, "1000.00")], []));
  await page.reload();
  await expect(page.getByText("Shift open")).toBeVisible();
  await expect(page.getByTestId("unusual-float-chip")).toHaveCount(0);
});

// ---------------------------------------------------------------- 7. Nav never drops items while loading
test("7 the sidebar keeps Inventory and Manage while the permissions call is slow (skeleton, then the full list)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const orig = ME;
  await mock(page, async (path) => { if (path === "/auth/me") { await new Promise((r) => setTimeout(r, 3000)); return orig; } return undefined; });
  await start(page); await page.goto("/reservations");
  const nav = page.getByRole("complementary", { name: "Primary" });
  await expect(nav.getByTestId("nav-skeleton")).toBeVisible();
  // while loading the nav must not show a shortened list: nothing is hidden because of a role we do not know yet
  await expect(nav.getByRole("link", { name: "Manage" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Orders" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Inventory" })).toBeVisible({ timeout: 15_000 });
  await expect(nav.getByRole("link", { name: "Manage" })).toBeVisible();
  await expect(nav.locator("nav").getByRole("link")).toHaveText(["Chilli Agent", "Orders", "Kitchen", "Inventory", "Manage"]);
  await expect(nav.getByTestId("nav-skeleton")).toHaveCount(0);
  // Reservations and End of day are Manage entries now: the Manage navigation next to the page lists them
  const rail = page.getByRole("navigation", { name: "Manage sections" });
  await expect(rail.getByRole("link", { name: "Reservations" })).toBeVisible();
  await expect(rail.getByRole("link", { name: "End of day" })).toBeVisible();
});

test("7 moving between Customers, Reports and Orders keeps Inventory and Manage; the moved screens open from Manage and keep their URLs", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // report data is not the point here: "not available" keeps the report screens quiet
  await mock(page, (path, _q, route) => { if (path.startsWith("/reports/")) { void route.fulfill({ status: 404, json: { detail: "n/a" } }); return "handled"; } return undefined; }); await start(page);
  await page.goto("/customers"); // an owner is sent to Manage > Customers (existing behaviour)
  await expect(page).toHaveURL(/\/manage\?tab=customers/);
  const nav = page.getByRole("complementary", { name: "Primary" });
  const rail = page.getByRole("navigation", { name: "Manage sections" });
  await expect(nav.getByRole("link", { name: "Inventory" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Manage" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Inventory" })).not.toHaveAttribute("aria-current", "page");
  for (const [name, url] of [["Reports", /\/reports$/], ["Cash drawer", /\/cash$/], ["End of day", /\/end-of-day$/], ["Reservations", /\/reservations$/]] as const) {
    await rail.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(url);
    await expect(rail.getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page"); // still inside the Manage navigation
    await expect(nav.getByRole("link", { name: "Manage", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Inventory" })).toBeVisible();
  }
  await nav.getByRole("link", { name: "Orders" }).click();
  await expect(page).toHaveURL(/\/orders/);
  await expect(nav.getByRole("link", { name: "Manage", exact: true })).not.toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Orders" })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "Inventory" }).click();
  await expect(page).toHaveURL(/\/manage\?tab=inventory/);
  await expect(nav.getByRole("link", { name: "Inventory" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Manage", exact: true })).not.toHaveAttribute("aria-current", "page");
  await expect(rail.getByRole("link", { name: /^Inventory/ })).toHaveAttribute("aria-current", "page"); // and it is still inside Manage's own list
  await rail.getByRole("link", { name: "Menu", exact: true }).click();
  await expect(nav.getByRole("link", { name: "Manage", exact: true })).toHaveAttribute("aria-current", "page"); // any other Manage tab lights Manage
  await expect(nav.getByRole("link", { name: "Inventory" })).not.toHaveAttribute("aria-current", "page");
});

// ---------------------------------------------------------------- X-report contract: takings = money received, billed_total, payments gap
type Json = Record<string, unknown>;
const xNew = (over: { unexplained?: string; closePeriod?: Json | null } = {}): Json => ({ ...XREPORT, empty: false,
  grand_total: { orders: 2, items: 4, disc: "0.00", sales: "960.00" },
  deductions: { ...(XREPORT.deductions as Json), net_sales: "914.29", total_takings: "200.00", billed_total: "960.00", takings: { payments: "200.00", refunds_paid: "0.00", billed_not_received: "760.00" } },
  summary: { ...(XREPORT.summary as Json), payments: [{ method: "cash", count: 1, amount: "200.00" }], total_payments: "200.00" },
  open_items: { open_orders: { count: 0, amount: "0.00" }, unpaid_bills: { count: 1, balance: "760.00" } },
  checks_info: { payments_minus_takings: "-760.00", note: "", bills_without_tax_breakdown: 0, bills_total: "960.00", billed_total: "960.00",
    payments_gap: { difference: "-760.00", causes: [{ code: "unpaid_bills", label: "Unpaid bills of this period", count: 1, amount: "-760.00" }], unexplained: over.unexplained ?? "0.00", explained: !over.unexplained } },
  ...(over.closePeriod === null ? {} : { close_period: over.closePeriod ?? { from: "2026-11-01T04:00:00Z", from_local: "2026-11-01T09:30:00+05:30", days: 3, first_close: true } }) });
const xOld = (): Json => ({ ...XREPORT, empty: false, grand_total: { orders: 2, items: 4, disc: "0.00", sales: "960.00" },
  deductions: { ...(XREPORT.deductions as Json), net_sales: "914.29", total_takings: "960.00" },
  summary: { ...(XREPORT.summary as Json), payments: [{ method: "cash", count: 1, amount: "200.00" }], total_payments: "200.00" },
  checks_info: { payments_minus_takings: "-760.00", note: "", bills_without_tax_breakdown: 0, bills_total: "960.00" } });
const xApi = (x: Json) => (path: string) => (path === "/reports/x-report" ? x : undefined);

test("X report (new server): takings = money received, billed total apart, unpaid bills with Take payment, real gap causes, first close", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await mock(page, xApi(xNew())); await start(page); await page.goto("/end-of-day");
  const tiles = page.getByTestId("eod-stats");
  await expect(tiles).toContainText("Total takings (received)");
  await expect(tiles).toContainText("₹200.00");
  await expect(tiles).toContainText("Billed (incl. unpaid bills)");
  await expect(tiles).toContainText("₹960.00");
  await expect(tiles).not.toContainText("Billed sales");
  const unpaid = page.getByTestId("eod-unpaid-new");
  await expect(unpaid).toContainText("Take payment");
  await expect(unpaid.getByRole("link", { name: "Take payment" })).toHaveAttribute("href", "/orders");
  await expect(tiles).toContainText("₹760.00");
  const paper = page.getByTestId("payments-gap");
  await expect(paper).toContainText("Unpaid bills of this period: 1 bill, -₹760.00");
  await expect(paper).not.toContainText("settled in another period");
  await expect(page.getByTestId("gap-unexplained")).toHaveCount(0);
  await expect(page.getByText("TOTAL BILLED", { exact: true })).toBeVisible();
  await expect(page.getByText("TOTAL TAKINGS (RECEIVED)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Close day/ }).click();
  const dlg = page.getByRole("dialog", { name: "Close the day?" });
  await expect(dlg.getByTestId("close-takings")).toHaveText("₹200.00");
  await expect(dlg.getByTestId("close-billed")).toHaveText("₹960.00");
  await expect(dlg).toContainText("Total takings (received)");
  await expect(dlg.getByTestId("first-close")).toHaveText("This close covers 3 days since 01 Nov 2026.");
});

test("X report (new server): 'Unexplained' only when it is not zero; not a first close says nothing about days", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await mock(page, xApi(xNew({ unexplained: "12.50", closePeriod: { from: "2026-11-03T00:00:00Z", days: 1, first_close: false } }))); await start(page); await page.goto("/end-of-day");
  await expect(page.getByTestId("gap-unexplained")).toHaveText("Unexplained: ₹12.50");
  await page.getByRole("button", { name: /Close day/ }).click();
  await expect(page.getByRole("dialog", { name: "Close the day?" })).toBeVisible();
  await expect(page.getByTestId("first-close")).toHaveCount(0);
});

test("X report (older server without the new fields): labels and the old sentence stay", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await mock(page, xApi(xOld())); await start(page); await page.goto("/end-of-day");
  const tiles = page.getByTestId("eod-stats");
  await expect(tiles).toContainText("Billed sales");
  await expect(tiles).toContainText("₹960.00");
  await expect(tiles).not.toContainText("Total takings (received)");
  await expect(page.getByTestId("eod-unpaid-new")).toHaveCount(0);
  await expect(page.getByText("TOTAL TAKINGS", { exact: true })).toBeVisible();
  await expect(page.getByText(/bills settled in another period or refunds paid out/)).toBeVisible();
  await expect(page.getByTestId("payments-gap")).toHaveCount(0);
  await page.getByRole("button", { name: /Close day/ }).click();
  const dlg = page.getByRole("dialog", { name: "Close the day?" });
  await expect(dlg).toContainText("Net takings");
  await expect(dlg.getByTestId("close-billed")).toHaveCount(0);
  await expect(page.getByTestId("first-close")).toHaveCount(0);
});

test("Leakage: payments vs billed names the causes; an unpaid-only gap is not 'High priority'; another cause keeps High", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const pvt = (causes: Json[]) => ({ payments: "200.00", takings: "960.00", billed_total: "960.00", total_takings: "200.00", difference: "-760.00", note: "Payments are compared with the amount billed.",
    causes: { difference: "-760.00", causes, unexplained: "0.00", explained: true } });
  const flag = { severity: "high", code: "payments_vs_takings", message: "Payments differ from the amount billed by -760.00." };
  const unpaidOnly = { ...LEAK({}, [flag]), payments_vs_takings: pvt([{ code: "unpaid_bills", count: 1, amount: "-760.00" }]) };
  await mockReports(page, reportApi({ leak: unpaidOnly })); await start(page); await page.goto("/reports?tab=leakage");
  await expect(page.getByTestId("payments-vs-takings")).toContainText("Billed ₹960.00");
  await expect(page.getByTestId("payments-vs-takings")).toContainText("total takings (money received, after refunds) ₹200.00");
  await expect(page.getByTestId("payments-vs-takings")).toContainText("Unpaid bills of this period: 1 bill, -₹760.00");
  await expect(page.getByTestId("leakage-flags")).not.toContainText("High priority");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const mixed = { ...LEAK({}, [flag]), payments_vs_takings: pvt([{ code: "unpaid_bills", count: 1, amount: "-760.00" }, { code: "refunds", count: 1, amount: "50.00" }]) };
  await mockReports(page, reportApi({ leak: mixed })); await page.reload();
  await expect(page.getByTestId("leakage-flags")).toContainText("High priority");
  await expect(page.getByTestId("payments-vs-takings")).toContainText("Refunds paid out: 1 refund, +₹50.00");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const old = { ...LEAK({}, []), payments_vs_takings: { payments: "200.00", takings: "960.00", difference: "-760.00", note: "Payments differ." } };
  await mockReports(page, reportApi({ leak: old })); await page.reload();
  await expect(page.getByTestId("payments-vs-takings")).toContainText("Payments 200.00 vs takings 960.00");
});

// ---------------------------------------------------------------- 9. Make bill from Orders
test("9 Orders: an unbilled in-kitchen order has Make bill (card and order dialog), refreshes after; no permission, no button", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let billed = false; let loads = 0; const posts: string[] = [];
  const api = (path: string, _q: URLSearchParams, route: Route) => {
    if (path === "/orders") { loads++; return [order("o1", billed ? "billed" : "sent_to_kitchen", { subtotal: "420.00", table_id: "t2" })]; }
    if (path === "/bills") return billed ? [bill("b1", "o1", { total: "420.00", balance_due: "420.00" })] : [];
    if (path === "/orders/o1/bill") { posts.push(route.request().method()); billed = true; return bill("b1", "o1", { total: "420.00", balance_due: "420.00" }); }
    return undefined;
  };
  await mock(page, api); await start(page); await page.goto("/orders");
  const card = page.getByTestId("order-card");
  await expect(card).toContainText("Table G1 · Outdoor");
  await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(card.getByTestId("take-payment")).toHaveCount(0);
  // via the order dialog
  await card.getByTestId("view-order").click();
  const dlg = page.getByRole("dialog", { name: /^Order #/ });
  await expect(dlg).toContainText("Paneer Tikka");
  const before = loads;
  await dlg.getByTestId("order-make-bill").click();
  await expect(dlg).toBeHidden();
  expect(posts).toEqual(["POST"]);
  await expect(card.getByTestId("take-payment")).toBeVisible(); // refreshed: the order is billed, awaiting payment
  expect(loads).toBeGreaterThan(before);
  await expect(card.getByTestId("make-bill")).toHaveCount(0);
});

test("9 Orders: Make bill on the card itself; a user without bills.finalize does not get it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const posts: string[] = []; let billed = false;
  const api = (path: string, _q: URLSearchParams, route: Route) => {
    if (path === "/orders") return [order("o1", billed ? "billed" : "open", { subtotal: "420.00" })];
    if (path === "/bills") return billed ? [bill("b1", "o1")] : [];
    if (path === "/orders/o1/bill") { posts.push(route.request().postData() ?? ""); billed = true; return bill("b1", "o1"); }
    return undefined;
  };
  await mock(page, api, { ...ME, permissions: ["orders.view", "orders.create", "bills.receipt"] }); await start(page); await page.goto("/orders");
  await expect(page.getByTestId("order-card")).toHaveCount(1);
  await expect(page.getByTestId("make-bill")).toHaveCount(0); // no bills.finalize
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mock(page, api, { ...ME, permissions: ["orders.view", "orders.create", "bills.finalize"] }); await page.reload();
  await page.getByTestId("make-bill").click();
  await expect(page.getByTestId("take-payment")).toBeVisible();
  expect(JSON.parse(posts[0])).toMatchObject({ service_charge: true });
});

// ---------------------------------------------------------------- 10 + 11. Merged orders, All includes everything, chips add up
const UUID = "3f2a9c10-1111-4222-8333-444455556666";
test("10 11 Orders: merged orders show 'Merged' (not Cancelled) with the order number; All is every order and the chips add up", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mock(page, (path) => {
    if (path === "/orders") return [order("o1", "open", { table_id: null, order_type: "takeaway" }), order("o2", "billed"), order("o3", "cancelled", { cancel_reason: "Customer left" }),
      order("o4", "cancelled", { kind: "merged", merged_into_number: 12, cancel_reason: `Merged into order ${UUID}` }), order("o5", "cancelled", { cancel_reason: `Merged into order ${UUID}` }), order("o6", "sent_to_kitchen")];
    if (path === "/bills") return [bill("b2", "o2", { balance_due: "0.00", paid: "567.00" })];
    return undefined;
  });
  await start(page); await page.goto("/orders");
  const chips = page.getByRole("radiogroup", { name: "Filter by status" });
  await expect(chips.getByRole("radio", { name: /^All\s*6$/ })).toBeVisible(); // counts appear once the orders have loaded
  const counts: Record<string, number> = {};
  for (const t of await chips.getByRole("radio").allTextContents()) { const m = /^(.*?)\s*(\d+)$/.exec(t.trim()); if (m) counts[m[1].trim()] = Number(m[2]); }
  expect(counts["All"]).toBe(6); // every order, cancelled and merged included
  const others = Object.entries(counts).filter(([k]) => k !== "All").reduce((n, [, v]) => n + v, 0);
  expect(others).toBe(counts["All"]);
  expect(counts["Cancelled & voided"]).toBe(1); // merged ones are not cancellations
  expect(counts["Merged"]).toBe(2);
  const cards = page.getByTestId("order-card");
  await expect(cards).toHaveCount(6);
  const merged = page.getByTestId("merged-line");
  await expect(merged).toHaveCount(2);
  await expect(merged.first()).toHaveText(/^Merged into order #(12|3F2A9C)$/);
  await expect(page.getByTestId("orders-list")).not.toContainText(UUID);
  await expect(page.getByTestId("orders-list")).toContainText("Cancelled: Customer left");
  await chips.getByRole("radio", { name: /^Merged/ }).click();
  await expect(cards).toHaveCount(2);
  for (const c of await cards.all()) { await expect(c).toContainText("Merged"); await expect(c).not.toContainText("Cancelled"); }
  await chips.getByRole("radio", { name: /^Cancelled/ }).click();
  await expect(cards).toHaveCount(1);
});

// ---------------------------------------------------------------- 12. One cancelled count
test("12 Reports: Payments 0 vs Leakage 2 shows no conflicting 'Cancelled orders' tile; Leakage's is 'Cancelled by staff'; equal counts show both as before", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const voids = (n: number) => ({ ...LEAK({}, []), voids: { count: n, value: "300.00", before_kitchen: { count: n, value: "300.00" }, after_kitchen: { count: 0, value: "0.00", orders: [] }, by_staff: [], by_reason: [] } });
  await mockReports(page, reportApi({ leak: voids(2), payVoided: 0 }));
  await start(page); await page.goto("/reports?tab=leakage");
  await expect(page.getByTestId("mis-payments")).toContainText("Collected");
  await expect(page.getByTestId("mis-payments")).not.toContainText("Cancelled orders");
  await expect(page.getByTestId("leakage-report").getByText("Cancelled by staff", { exact: true })).toHaveCount(1);
  await expect(page.getByTestId("leakage-report").getByText("Cancelled orders", { exact: true })).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mockReports(page, reportApi({ leak: voids(2), payVoided: 2 })); await page.reload();
  await expect(page.getByTestId("mis-payments")).toContainText("Cancelled orders");
  await expect(page.getByTestId("leakage-report").getByText("Cancelled orders", { exact: true })).toHaveCount(1);
  await expect(page.getByTestId("leakage-report").getByText("Cancelled by staff", { exact: true })).toHaveCount(0);
});

// ---------------------------------------------------------------- 13. Identical lines read once
test("13 identical lines (item + option + modifiers + note + price) read as one in the bill dialog and the counter's order panel", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const two = [{ id: "bl1", description: "Chicken 65 [Mild]", quantity: 2, unit_price: "180.00", line_total: "360.00" }, { id: "bl2", description: "Dal Fry", quantity: 1, unit_price: "150.00", line_total: "150.00" }, { id: "bl3", description: "Chicken 65 [Mild]", quantity: 1, unit_price: "180.00", line_total: "180.00" }];
  const split = (id: string) => ({ ...order(id, "sent_to_kitchen"), lines: [{ id: "a", item_id: "i1", item_name: "Chicken 65", unit_price: "180.00", quantity: 2, note: null }, { id: "b", item_id: "i1", item_name: "Chicken 65", unit_price: "180.00", quantity: 1, note: null }] });
  await mock(page, (path) => {
    if (path === "/orders") return [order("o1", "billed"), split("o2")];
    if (path === "/bills") return [bill("b1", "o1", { subtotal: "690.00", total: "724.50", tax_amount: "34.50", lines: two, balance_due: "0.00", paid: "724.50" })];
    if (path === "/menu/items") return [{ id: "i1", category_id: "c1", name: "Chicken 65", price: "180.00", is_active: true, variants: [] }];
    if (path === "/menu/categories") return [{ id: "c1", name: "Starters", sort_order: 1, is_active: true }];
    return undefined;
  });
  await start(page); await page.goto("/orders");
  await page.getByTestId("order-card").filter({ hasText: "INV-b1" }).getByRole("button", { name: "View bill" }).click();
  const dlg = page.getByRole("dialog", { name: "INV-b1" });
  await expect(dlg.getByText(/Chicken 65 \[Mild\]/)).toHaveCount(1);
  await expect(dlg).toContainText("3 × Chicken 65 [Mild]");
  await expect(dlg).toContainText("540.00");
  await expect(dlg).toContainText("Total");
  await page.keyboard.press("Escape");
  await page.goto("/pos?order=o2");
  const items = page.getByRole("list", { name: "Order items" }).getByRole("listitem");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Chicken 65");
  await expect(items.first()).toContainText("3");
  await expect(items.first()).toContainText("540.00");
});
