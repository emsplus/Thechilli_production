import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { signIn } from "./helpers";

// Payment reminder (docs/testing/PAYMENT_REMINDER_REPORT.md): a waiter's "Remind the counter" on a billed, unpaid order reaches the bell, every API call mocked (no stack).
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = () => `${b64({ alg: "none" })}.${b64({ sub: "u1", rid: "r1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const ME = { id: "u1", email: "o@example.in", full_name: "Owner", role: "owner", is_active: true, restaurant_name: "Spice Garden", business_types: ["restaurant"], capabilities: { dine_in: true, tables: true } };
const REST = { name: "Spice Garden", currency: "INR", timezone: "Asia/Kolkata", country: "IN", currency_symbol: "₹", prices_include_tax: false };
const TAX = { country: "IN", currency: "INR", currency_symbol: "₹", timezone: "Asia/Kolkata", prices_include_tax: false, vat_registered: true, tax_number_label: "GSTIN", service_charge_percent: "0", max_cashier_discount_percent: "10",
  rates: [{ code: "standard", name: "GST", rate_percent: "5" }], rules: { eat_in: "x", takeaway: {}, eat_in_order_types: ["indoor", "outdoor"] } };
const TABLES = [{ id: "t1", label: "AC1", seats: 4, area: "indoor", is_active: true }, { id: "t2", label: "G1", seats: 2, area: "outdoor", is_active: true }];
const bill = (id: string, orderId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ id, order_id: orderId, invoice_number: `INV-${id}`, seller_name: "Spice Garden", seller_trn: null, currency: "INR", tax_name: "GST", tax_rate_percent: "5",
  subtotal: "540.00", tax_amount: "27.00", total: "567.00", country: "IN", vat_registered: true, prices_include_tax: false, lines: [{ id: "bl", description: "Paneer Tikka", quantity: 2, unit_price: "270.00", line_total: "540.00" }],
  payments: [], refunds: [], paid: "0.00", balance_due: "567.00", status: "active", table_label: "AC1", order_type: "indoor", sale_at: new Date().toISOString(), ...over });

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


const reminder = (id: string, over: Record<string, unknown> = {}) => ({ kind: "payment_reminder", order_id: id, table_id: "t2", table_label: "T2", token_number: 4, requested_at: new Date().toISOString(), requested_by: "w1", requested_by_name: "Ramesh",
  waiter_id: "w1", waiter_name: "Ramesh", item_count: 2, subtotal: "760.00", note: null, bill_id: `b-${id}`, invoice_number: "INV-123456", balance_due: "760.00", table_area: "indoor", ...over });

/** A page where AudioContext is counted, so "plays the chime" is checkable without speakers. */
async function countChimes(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __chimes: number }).__chimes = 0;
    class FakeAudio { currentTime = 0; state = "running"; destination = {}; resume() { return Promise.resolve(); }
      createOscillator() { (window as unknown as { __chimes: number }).__chimes++; return { frequency: { value: 0 }, connect: (x: unknown) => x, start() {}, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x: unknown) => x }; } }
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudio;
  });
}
const chimes = (page: Page) => page.evaluate(() => (window as unknown as { __chimes: number }).__chimes);

test("a payment reminder rings the bell, says who is waiting, Take payment opens the pay sheet, paying clears it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await countChimes(page);
  let queue: unknown[] = [];
  let b: Record<string, unknown> = bill("b-o9", "o9", { invoice_number: "INV-123456", total: "760.00", balance_due: "760.00", table_label: "T2" });
  const posts: Record<string, string>[] = [];
  await mock(page, (path, _q, route) => {
    if (path === "/bill-requests") return queue;
    if (path === "/reviews/summary") return { unread_low: 0 };
    if (path === "/bills/b-o9") return b;
    if (path === "/bills/b-o9/payments") {
      posts.push(JSON.parse(route.request().postData() ?? "{}"));
      b = { ...b, paid: "760.00", balance_due: "0.00" }; queue = []; // paid: the server drops the reminder
      return { id: "p1", method: "cash", amount: "760.00" };
    }
    return undefined;
  });
  await start(page);
  const first = page.waitForResponse((r) => r.url().endsWith("/bill-requests"));
  await page.goto("/orders");
  await first; // the first poll (empty queue); a reminder that comes after it is an arrival: toast + chime
  const bell = page.getByTestId("notification-bell");
  await expect(bell).toBeVisible();
  await expect(page.getByTestId("notification-count")).toHaveCount(0);
  expect(await chimes(page)).toBe(0);
  // the waiter taps "Remind the counter": the next poll brings it
  queue = [reminder("o9")];
  await expect(page.getByTestId("notification-count")).toHaveText("1", { timeout: 20_000 });
  await expect(page.getByText("Table T2 is waiting to pay: bill INV-123456, ₹760.00 (asked by Ramesh)").first()).toBeVisible(); // toast
  expect(await chimes(page)).toBeGreaterThan(0);
  // the bell panel: the reminder is in its own section with Take payment / Dismiss
  await bell.click();
  const row = page.getByTestId("payment-reminder");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Table T2 is waiting to pay: bill INV-123456, ₹760.00 (asked by Ramesh)");
  await expect(page.getByTestId("bill-requests")).toHaveCount(0); // it is not "asks for the bill"
  await row.getByRole("button", { name: "Take payment" }).click();
  const sheet = page.getByRole("dialog", { name: "Take payment" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: /Confirm payment/ }).click();
  await expect(sheet).toBeHidden();
  expect(posts[0]).toMatchObject({ method: "cash", amount: "760.00" });
  await expect(page.getByTestId("notification-count")).toHaveCount(0);
  await bell.click();
  await expect(page.getByTestId("payment-reminder")).toHaveCount(0);
});

test("Dismiss clears it on the server; sound off keeps a new reminder quiet; an older server (no kind) still shows a plain bill request", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await countChimes(page);
  let queue: unknown[] = [reminder("o9")];
  const dismissed: string[] = [];
  await mock(page, (path) => {
    if (path === "/bill-requests") return queue;
    if (path === "/reviews/summary") return { unread_low: 0 };
    if (path === "/orders/o9/dismiss-payment-reminder") { dismissed.push(path); queue = []; return { order_id: "o9", dismissed: true }; }
    return undefined;
  });
  await start(page); await page.goto("/orders");
  await page.getByTestId("notification-bell").click();
  await expect(page.getByTestId("payment-reminder")).toHaveCount(1);
  await page.getByTestId("bell-sound").click(); // Sound on -> off (the tap itself chimes once when turning ON only)
  await expect(page.getByTestId("bell-sound")).toContainText("Sound off");
  const before = await chimes(page);
  queue = [reminder("o9", { requested_at: new Date(Date.now() + 1000).toISOString() })];
  await expect(page.getByTestId("payment-reminder")).toHaveAttribute("data-unread", "true", { timeout: 20_000 });
  expect(await chimes(page)).toBe(before);
  await page.getByTestId("payment-reminder").getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByTestId("payment-reminder")).toHaveCount(0);
  expect(dismissed).toEqual(["/orders/o9/dismiss-payment-reminder"]);
  // older server: no `kind` at all = a plain bill request, as before
  queue = [{ order_id: "o5", table_id: "t1", table_label: "AC1", token_number: 3, requested_at: new Date().toISOString(), requested_by: "w1", requested_by_name: "Asha", waiter_id: "w1", waiter_name: "Asha", item_count: 3, subtotal: "540.00", note: null }];
  await expect(page.getByTestId("bill-requests")).toContainText("Table AC1 asks for the bill", { timeout: 20_000 });
  await expect(page.getByTestId("payment-reminder")).toHaveCount(0);
});
