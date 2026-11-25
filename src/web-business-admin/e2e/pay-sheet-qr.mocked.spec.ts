import { expect, test, type Page, type Route } from "@playwright/test";
import { signIn } from "./helpers";
import { qrMatrix, qrPath } from "../src/lib/qr";

// Take payment on the Orders page (cash / card / UPI QR / split), every API call mocked: no stack, no real payment is ever made.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = () => `${b64({ alg: "none" })}.${b64({ sub: "u1", rid: "r1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const ME = { id: "u1", email: "o@example.in", full_name: "Owner", role: "owner", is_active: true, restaurant_name: "Spice Garden", business_types: ["restaurant"], capabilities: { dine_in: true, tables: true } };
const REST = { name: "Spice Garden", currency: "INR", timezone: "Asia/Kolkata", country: "IN", currency_symbol: "₹", prices_include_tax: false };
const TAX = { country: "IN", currency: "INR", currency_symbol: "₹", timezone: "Asia/Kolkata", prices_include_tax: false, vat_registered: true, tax_number_label: "GSTIN", service_charge_percent: "0", max_cashier_discount_percent: "10",
  rates: [{ code: "standard", name: "GST", rate_percent: "5" }], rules: { eat_in: "x", takeaway: {}, eat_in_order_types: ["indoor", "outdoor"] } };
const TABLES = [{ id: "t1", label: "AC1", seats: 4, area: "indoor", is_active: true }];
const line = (id: string) => ({ id, item_id: "i1", item_name: "Paneer Tikka", unit_price: "270.00", quantity: 2, note: null });
const order = (id: string) => ({ id, client_uuid: `c-${id}`, order_type: "indoor", table_id: "t1", status: "billed", lines: [line(`l-${id}`)], subtotal: "540.00", created_at: new Date().toISOString() });
const bill = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ id: "b1", order_id: "o1", invoice_number: "INV-b1", seller_name: "Spice Garden", seller_trn: null, currency: "INR", tax_name: "GST", tax_rate_percent: "5",
  subtotal: "540.00", tax_amount: "27.00", total: "567.00", country: "IN", vat_registered: true, prices_include_tax: false, lines: [{ id: "bl", description: "Paneer Tikka", quantity: 2, unit_price: "270.00", line_total: "540.00" }],
  payments: [], refunds: [], paid: "0.00", balance_due: "567.00", status: "active", table_label: "AC1", order_type: "indoor", sale_at: new Date().toISOString(), ...over });

type Pay = { path: string; body: Record<string, string> };
interface Setup { upi?: (n: number) => { status: number; json: unknown }; payStatus?: number }

/** Mocks the API. `/restaurant/upi` is served by `upi(callNumber)`, payments are recorded in `pays` and never go anywhere. */
async function open(page: Page, s: Setup = {}) {
  await page.setViewportSize({ width: 1280, height: 900 });
  const pays: Pay[] = []; let upiCalls = 0; let b = bill();
  await page.route("**/api/v1/**", async (route: Route) => {
    const u = new URL(route.request().url()); const path = u.pathname.replace(/^.*\/api\/v1/, "");
    if (path === "/auth/me") return route.fulfill({ json: ME });
    if (path === "/restaurant") return route.fulfill({ json: REST });
    if (path === "/billing/tax-config") return route.fulfill({ json: TAX });
    if (path === "/tables") return route.fulfill({ json: TABLES });
    if (path === "/billing/wallet") return route.fulfill({ status: 404, json: { detail: "n/a" } });
    if (path === "/orders") return route.fulfill({ json: [order("o1")] });
    if (path === "/bills") return route.fulfill({ json: [b] });
    if (path === "/restaurant/upi") { upiCalls++; const r = (s.upi ?? (() => ({ status: 200, json: { upi_vpa: "spice@okicici" } })))(upiCalls); return route.fulfill(r); }
    if (path === "/bills/b1/payments") {
      pays.push({ path, body: JSON.parse(route.request().postData() ?? "{}") });
      if (s.payStatus) return route.fulfill({ status: s.payStatus, json: { detail: "Payment refused" } });
      const paid = pays.reduce((n, p) => n + Number(p.body.amount), 0);
      b = bill({ paid: paid.toFixed(2), balance_due: (567 - paid).toFixed(2) });
      return route.fulfill({ json: { id: `p${pays.length}`, method: pays.at(-1)!.body.method, amount: pays.at(-1)!.body.amount } });
    }
    if (path === "/bills/b1") return route.fulfill({ json: b });
    return route.fulfill({ json: [] });
  });
  await signIn(page, fakeJwt());
  await page.goto("/orders");
  await page.getByTestId("take-payment").click();
  const sheet = page.getByRole("dialog", { name: "Take payment" });
  await expect(sheet).toBeVisible();
  return { sheet, pays, upiCalls: () => upiCalls };
}
const keys = async (sheet: ReturnType<Page["getByRole"]>, digits: string) => { for (const d of digits) await sheet.getByRole("button", { name: d === "." ? "Decimal point" : d, exact: true }).click(); };

test("cash: opens on the bill balance, Exact picks the bill amount, a bigger note shows change, confirm books exactly the balance", async ({ page }) => {
  const { sheet, pays } = await open(page);
  await expect(sheet).toContainText("Balance ₹567.00");
  await expect(sheet.getByRole("radio", { name: "Cash" })).toHaveAttribute("aria-checked", "true");
  const confirm = sheet.getByRole("button", { name: /Confirm payment/ });
  await sheet.getByRole("button", { name: "Exact" }).click();
  await expect(sheet.getByRole("status")).toContainText("₹567"); // Exact must show the amount, never ₹0
  await expect(sheet.getByRole("status")).not.toContainText("₹0");
  await expect(confirm).toBeEnabled();
  await expect(page.getByTestId("change-due")).toHaveCount(0);
  const quick = sheet.getByRole("group", { name: "Quick cash amounts" }).getByRole("button").nth(1); // first note above the balance
  const label = (await quick.innerText()).trim();
  await quick.click();
  await expect(sheet.getByRole("status")).toContainText(label.replace(/\.00$/, ""));
  await expect(page.getByTestId("change-due")).toBeVisible();
  await confirm.click();
  await expect(sheet).toBeHidden();
  expect(pays).toHaveLength(1);
  expect(pays[0].body).toMatchObject({ method: "cash", amount: "567.00" }); // change is not part of the payment
  expect(pays[0].body.idempotency_key).toBeTruthy();
});

test("cash: typing keys works after Exact (appends to the shown amount), Clear resets, a short amount cannot be confirmed", async ({ page }) => {
  const { sheet } = await open(page);
  const confirm = sheet.getByRole("button", { name: /Confirm payment/ });
  await keys(sheet, "100");
  await expect(sheet.getByRole("status")).toContainText("₹100");
  await expect(confirm).toBeDisabled(); // 100 < 567 and cash cannot be part-paid without Add-and-split
  await sheet.getByRole("button", { name: "Exact" }).click();
  await keys(sheet, "0");
  await expect(sheet.getByRole("status")).toContainText("₹5,670"); // Exact then a typed digit extends it, never "₹567.000"
  await sheet.getByRole("button", { name: "Clear" }).click();
  await expect(sheet.getByRole("status")).toContainText("₹0");
});

test("UPI: shows a scannable QR with the amount and the restaurant UPI id; nothing is booked until Confirm", async ({ page }) => {
  const { sheet, pays, upiCalls } = await open(page);
  await sheet.getByRole("radio", { name: "UPI" }).click();
  const qr = sheet.getByTestId("upi-qr");
  await expect(qr.getByRole("img", { name: "UPI QR code" })).toBeVisible();
  await expect(qr).toContainText("₹567.00 · spice@okicici");
  const box = await qr.getByRole("img").boundingBox();
  expect(box!.width).toBeGreaterThan(150); // big enough to scan from a customer's phone
  expect(upiCalls()).toBe(1);
  expect(pays).toHaveLength(0); // showing the QR is not a payment
  // switching away and back does not refetch / lose the QR
  await sheet.getByRole("radio", { name: "Cash" }).click();
  await expect(qr).toHaveCount(0);
  await sheet.getByRole("radio", { name: "UPI" }).click();
  await expect(qr.getByRole("img", { name: "UPI QR code" })).toBeVisible();
  expect(upiCalls()).toBe(1);
  await sheet.getByRole("button", { name: /Confirm payment/ }).click();
  await expect(sheet).toBeHidden();
  expect(pays).toHaveLength(1);
  expect(pays[0].body.amount).toBe("567.00");
  expect(["upi", "other"]).toContain(pays[0].body.method);
});

/** The exact QR the sheet must draw for a payment link (same encoder the app uses), so the test fails if any field in the link is wrong. */
const qrFor = (uri: string) => qrPath(qrMatrix(uri));

test("UPI: the QR encodes a upi://pay link with the UPI id (@ kept literal), payee, the amount and INR", async ({ page }) => {
  const { sheet } = await open(page);
  await sheet.getByRole("radio", { name: "UPI" }).click();
  const d = () => sheet.getByTestId("upi-qr").locator("svg path").getAttribute("d");
  await expect(sheet.getByTestId("upi-qr").getByRole("img")).toBeVisible();
  expect(await d()).toBe(qrFor("upi://pay?pa=spice@okicici&pn=Spice%20Garden&am=567.00&cu=INR"));
  await keys(sheet, "100");
  await expect(sheet.getByTestId("upi-qr")).toContainText("₹100.00");
  expect(await d()).toBe(qrFor("upi://pay?pa=spice@okicici&pn=Spice%20Garden&am=100.00&cu=INR")); // follows the typed amount
});

test("UPI: no UPI id saved says where to add it and shows no QR", async ({ page }) => {
  const { sheet } = await open(page, { upi: () => ({ status: 200, json: { upi_vpa: null } }) });
  await sheet.getByRole("radio", { name: "UPI" }).click();
  await expect(sheet.getByTestId("upi-qr")).toContainText("No UPI id saved");
  await expect(sheet.getByTestId("upi-qr").getByRole("img")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: /Confirm payment/ })).toBeEnabled(); // cashier can still take UPI by checking the customer's screen
});

test("UPI: a failed id lookup (offline / 403 / 500) offers Try again, and the QR appears once it works", async ({ page }) => {
  const { sheet, upiCalls } = await open(page, { upi: (n) => (n === 1 ? { status: 500, json: { detail: "boom" } } : { status: 200, json: { upi_vpa: "spice@okicici" } }) });
  await sheet.getByRole("radio", { name: "UPI" }).click();
  const qr = sheet.getByTestId("upi-qr");
  await expect(qr).toContainText("Could not load the UPI id");
  await expect(qr).not.toContainText("No UPI id saved"); // a failed lookup must not claim there is none
  await qr.getByRole("button", { name: "Try again" }).click();
  await expect(qr.getByRole("img", { name: "UPI QR code" })).toBeVisible();
  expect(upiCalls()).toBe(2);
});

test("split: add part as cash, the rest as UPI QR for the remaining balance; two lines with different keys, in order", async ({ page }) => {
  const { sheet, pays } = await open(page);
  await keys(sheet, "200");
  await sheet.getByRole("button", { name: /Add ₹200\.00 as Cash and split the rest/ }).click();
  await expect(sheet.getByRole("list", { name: "Payments added" })).toContainText("₹200.00");
  await expect(sheet).toContainText("Still to pay");
  await sheet.getByRole("radio", { name: "UPI" }).click();
  await expect(sheet.getByTestId("upi-qr")).toContainText("₹367.00 · spice@okicici"); // QR is for what is left, not the whole bill
  await sheet.getByRole("button", { name: /Confirm payment/ }).click();
  await expect(sheet).toBeHidden();
  expect(pays.map((p) => [p.body.method, p.body.amount])).toEqual([["cash", "200.00"], [pays[1].body.method, "367.00"]]);
  expect(pays[0].body.idempotency_key).not.toBe(pays[1].body.idempotency_key);
});

test("split: removing an added line puts the amount back; Card is a normal tender", async ({ page }) => {
  const { sheet, pays } = await open(page);
  await keys(sheet, "100");
  await sheet.getByRole("button", { name: /Add ₹100\.00 as Cash/ }).click();
  await sheet.getByRole("button", { name: /Remove Cash/ }).click();
  await expect(sheet.getByRole("list", { name: "Payments added" })).toHaveCount(0);
  await sheet.getByRole("radio", { name: "Card" }).click();
  await expect(sheet.getByTestId("upi-qr")).toHaveCount(0); // no QR for card
  await sheet.getByRole("button", { name: /Confirm payment ₹567\.00/ }).click();
  await expect(sheet).toBeHidden();
  expect(pays).toHaveLength(1);
  expect(pays[0].body).toMatchObject({ method: "card", amount: "567.00" });
});

test("card / UPI cannot be over the balance (no change from a card)", async ({ page }) => {
  const { sheet } = await open(page);
  await sheet.getByRole("radio", { name: "Card" }).click();
  await keys(sheet, "600");
  await expect(sheet.getByRole("alert")).toContainText("more than the balance");
  await expect(sheet.getByRole("button", { name: /Confirm payment/ })).toBeDisabled();
});

test("a double tap on Confirm books once", async ({ page }) => {
  const { sheet, pays } = await open(page);
  const confirm = sheet.getByRole("button", { name: /Confirm payment/ });
  await confirm.dblclick();
  await expect(sheet).toBeHidden();
  expect(pays).toHaveLength(1);
});

test("a refused payment keeps the sheet open, says so, and nothing is shown as paid", async ({ page }) => {
  const { sheet, pays } = await open(page, { payStatus: 409 });
  await sheet.getByRole("button", { name: /Confirm payment/ }).click();
  await expect(page.getByText("Payment not taken").first()).toBeVisible();
  await expect(sheet).toBeVisible();
  expect(pays).toHaveLength(1);
  await expect(page.getByText("Payment received")).toHaveCount(0);
});

test("the sheet closes with the X / Escape without booking anything", async ({ page }) => {
  const { sheet, pays } = await open(page);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  expect(pays).toHaveLength(0);
});
