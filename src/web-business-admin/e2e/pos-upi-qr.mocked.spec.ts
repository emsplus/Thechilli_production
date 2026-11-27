import { expect, test, type Page, type Route } from "@playwright/test";
import { signIn } from "./helpers";

// POS counter: the one-tap "UPI" next to Cash / Card must SHOW the restaurant's UPI QR (and book nothing until Confirm), not book the payment at once.
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

async function openBilled(page: Page, vpa: string | null) {
  await page.setViewportSize({ width: 1280, height: 900 });
  const pays: string[] = []; let billed = false;
  await page.route("**/api/v1/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/v1/, "");
    if (path === "/auth/me") return route.fulfill({ json: ME });
    if (path === "/restaurant") return route.fulfill({ json: REST });
    if (path === "/billing/tax-config") return route.fulfill({ json: TAX });
    if (path === "/tables") return route.fulfill({ json: TABLES });
    if (path === "/billing/wallet") return route.fulfill({ status: 404, json: { detail: "n/a" } });
    if (path === "/orders") return route.fulfill({ json: [{ ...order("o1"), status: billed ? "billed" : "sent_to_kitchen" }] });
    if (path === "/bills") return route.fulfill({ json: billed ? [bill()] : [] });
    if (path === "/bills/b1") return route.fulfill({ json: bill() });
    if (path === "/orders/o1/bill") { billed = true; return route.fulfill({ status: 201, json: bill() }); }
    if (path === "/restaurant/upi") return route.fulfill({ json: { upi_vpa: vpa } });
    if (path === "/bills/b1/payments") { pays.push(route.request().postData() ?? ""); return route.fulfill({ json: { id: "p1", method: "upi", amount: "567.00" } }); }
    return route.fulfill({ json: [] });
  });
  await signIn(page, fakeJwt());
  await page.goto("/pos?order=o1");
  await page.getByRole("button", { name: "Make bill" }).click();
  await expect(page.getByTestId("pay-row")).toBeVisible();
  return pays;
}

test("UPI one-tap shows the restaurant's QR for the bill amount and books nothing until Confirm", async ({ page }) => {
  const pays = await openBilled(page, "spice@okicici");
  await page.getByRole("button", { name: /Pay UPI/ }).click();
  const sheet = page.getByRole("dialog", { name: "Take payment" });
  await expect(sheet).toBeVisible();
  const qr = sheet.getByTestId("upi-qr");
  await expect(qr.getByRole("img", { name: "UPI QR code" })).toBeVisible();
  await expect(qr).toContainText("₹567.00 · spice@okicici");
  expect(pays).toHaveLength(0);                                   // showing the QR is not a payment
  await sheet.getByRole("button", { name: /Confirm payment/ }).click();
  await expect(sheet).toBeHidden();
  expect(pays).toHaveLength(1);
  expect(JSON.parse(pays[0])).toMatchObject({ method: "upi", amount: "567.00" });
});

test("UPI one-tap without a saved UPI id says where to add it (no QR, nothing booked)", async ({ page }) => {
  const pays = await openBilled(page, null);
  await page.getByRole("button", { name: /Pay UPI/ }).click();
  const sheet = page.getByRole("dialog", { name: "Take payment" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("img", { name: "UPI QR code" })).toHaveCount(0);   // no QR without a saved UPI id
  await expect(sheet).toContainText(/Manage/);
  expect(pays).toHaveLength(0);
});

test("Cash and Card stay one tap (book the balance at once)", async ({ page }) => {
  const pays = await openBilled(page, "spice@okicici");
  await page.getByRole("button", { name: /Pay cash/i }).click();
  await expect.poll(() => pays.length).toBe(1);
  expect(JSON.parse(pays[0])).toMatchObject({ method: "cash" });
});
