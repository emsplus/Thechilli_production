import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, openAs, seedIn, signIn, type Seed } from "./helpers";

// A discount at the FINAL BILL step (fix/final-bill-discount): order -> kitchen (KOT) -> Make bill -> discount -> pay cash -> the bill
// and receipt carry the discount with GST worked out per rate on the discounted value (India GST engine, 5% and 18% lines).

const GSTIN_STATE = "27"; // seedIn registers GSTIN 27AAPFU0939F1ZV

type B = { id: string; invoice_number: string; total: string; subtotal: string; tax_amount: string; round_off?: string; discount_amount: string; discount_reason: string | null;
  balance_due: string; status: string; superseded_by?: string | null; tax_breakdown: { code: string; net: string; vat: string; gross: string; cgst?: string; sgst?: string }[]; payments: { method: string; amount: string }[] };

/** Paneer Tikka 250 (5%, the seed dish) + Brownie 120 (goods, 18%), GST engine on, prices include GST. */
async function gstShop(request: APIRequestContext): Promise<Seed> {
  const s = await seedIn(request);
  const on = await request.put(`${API}/restaurant/gst`, { headers: s.auth, data: { tax_mode: "gst_engine", config: { state_code: GSTIN_STATE, default_place_of_supply: GSTIN_STATE } } });
  expect(on.status(), await on.text()).toBe(200);
  const br = await request.post(`${API}/menu/items`, { headers: s.auth, data: { category_id: s.catId, name: "Brownie", price: "120.00", supply_type: "goods", gst_rate_code: "gst_18", hsn: "190590" } });
  expect(br.status(), await br.text()).toBe(201);
  return s;
}
const allBills = async (request: APIRequestContext, s: Seed) => (await (await request.get(`${API}/bills?include_superseded=true`, { headers: s.auth })).json()) as B[];

async function openShop(page: Page, s: Seed) {
  await openAs(page, s.token, "/pos", s.refresh);
  await expect(page.getByRole("button", { name: /Paneer Tikka/ }).first()).toBeVisible();
}
async function toKitchen(page: Page) {
  await page.getByRole("button", { name: /Paneer Tikka/ }).first().click();
  await page.getByRole("button", { name: /Brownie/ }).first().click();
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: /Send to kitchen/ }).click();
  await expect(page.getByText(/Kitchen ticket #\d+ sent/).first()).toBeVisible();
}
async function fillDiscount(page: Page, type: "Percent %" | "Amount", value: string, reason?: string) {
  const dlg = page.getByRole("dialog");
  await expect(dlg).toBeVisible();
  if (type === "Amount") await dlg.getByRole("radio", { name: /Amount/ }).click();
  await dlg.getByLabel(/Percent off|Amount off/).fill(value);
  if (reason) await dlg.getByRole("button", { name: reason, exact: true }).click();
  return dlg;
}

test("make bill: discount in the same step (after the KOT), preview with CGST / SGST, pay cash, the bill is right", async ({ page, request }) => {
  const s = await gstShop(request);
  await openShop(page, s);
  await toKitchen(page);

  // the discount control is on screen next to "Make bill" (no scrolling for it), with the total
  const bar = page.getByTestId("discount-bar");
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("bar-total")).toContainText("370.00"); // prices include GST: 250 + 120
  await page.getByTestId("bill-discount-btn").click();
  const dlg = await fillDiscount(page, "Percent %", "10", "Staff meal");
  // the server's exact bill: items, discount, CGST / SGST per rate on the discounted value, total
  await expect(dlg.getByTestId("pv-discount")).toContainText("37.00");
  await expect(dlg.getByTestId("pv-gst_5-cgst")).toBeVisible();
  await expect(dlg.getByTestId("pv-gst_5-sgst")).toBeVisible();
  await expect(dlg.getByTestId("pv-gst_18-cgst")).toBeVisible();
  await expect(dlg.getByTestId("pv-total")).toContainText("333.00");
  await dlg.getByRole("button", { name: "Apply discount" }).click();
  await expect(page.getByTestId("bill-discount-btn")).toContainText("37.00");

  await page.getByRole("button", { name: "Make bill" }).click();
  await expect(page.getByRole("button", { name: "Pay cash" })).toBeVisible();
  await page.getByRole("button", { name: "Pay cash" }).click();
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible();
  // the paid view / receipt summary shows the discount line and its reason
  await expect(page.getByText("Staff meal").first()).toBeVisible();

  const [b] = await allBills(request, s);
  expect(b.discount_amount).toBe("37.00");
  expect(b.discount_reason).toBe("Staff meal");
  expect(Number(b.balance_due)).toBe(0);
  expect(b.payments).toHaveLength(1);
  expect(b.payments[0].method).toBe("cash");
  // GST on the discounted value: 5% group 225.00 incl., 18% group 108.00 incl.; CGST == SGST, worked here independently of the server
  const g5 = b.tax_breakdown.find((r) => r.code === "gst_5")!;
  const g18 = b.tax_breakdown.find((r) => r.code === "gst_18")!;
  const half = (gross: number, rate: number) => Math.round((gross * rate / (100 + rate) / 2) * 100) / 100;
  expect(Number(g5.gross)).toBe(225);
  expect(Number(g5.cgst)).toBe(half(225, 5));
  expect(Number(g5.sgst)).toBe(half(225, 5));
  expect(Number(g18.gross)).toBe(108);
  expect(Number(g18.cgst)).toBe(half(108, 18));
  expect(Number(b.total)).toBe(333);
  expect(Number(b.subtotal) + Number(b.tax_amount) + Number(b.round_off ?? 0)).toBeCloseTo(333, 2);
  // the receipt PDF renders
  const pdf = await request.get(`${API}/bills/${b.id}/receipt.pdf`, { headers: s.auth });
  expect(pdf.ok()).toBeTruthy();
  expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");
  // and the day report counts the discount
  const day = new Date().toISOString().slice(0, 10);
  const rep = await (await request.get(`${API}/reports/daily-sales?from_date=${day}&to_date=${day}`, { headers: s.auth })).json();
  expect(Number(rep.totals.discounts)).toBe(37);
});

test("open bill: Make bill first, then add a flat discount before payment; the new bill replaces the old one, then pay", async ({ page, request }) => {
  const s = await gstShop(request);
  await openShop(page, s);
  await toKitchen(page);
  await page.getByRole("button", { name: "Make bill" }).click();
  await expect(page.getByRole("button", { name: "Pay cash" })).toBeVisible();
  const first = (await allBills(request, s))[0];
  await expect(page.getByTestId("bar-total")).toContainText(first.total.replace(/\.00$/, ""));

  await page.getByTestId("bill-discount-btn").click();
  const dlg = await fillDiscount(page, "Amount", "50");  // no reason given: optional
  await expect(dlg.getByTestId("discount-note")).toContainText(first.invoice_number);
  await expect(dlg.getByTestId("pv-discount")).toContainText("50.00");
  await dlg.getByRole("button", { name: "Apply discount" }).click();
  await expect(page.getByTestId("bill-discount-btn")).toContainText("50.00");

  const bills = await allBills(request, s);
  const old = bills.find((b) => b.id === first.id)!;
  const cur = bills.find((b) => b.status === "active")!;
  expect(old.status).toBe("superseded");
  expect(cur.id).not.toBe(first.id);
  expect(cur.discount_amount).toBe("50.00");
  expect(cur.discount_reason).toBe("Discount");              // no reason: the plain label, not an invented one
  expect(Number(cur.total)).toBeLessThan(Number(first.total));

  await page.getByRole("button", { name: "Pay cash" }).click();
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible();
  const paid = (await allBills(request, s)).find((b) => b.status === "active")!;
  expect(Number(paid.balance_due)).toBe(0);
  // paid = immutable: the API refuses a discount change (409), the counter shows no discount control any more
  const r = await request.post(`${API}/bills/${paid.id}/discount`, { headers: s.auth, data: { discount: { type: "percent", value: "5" } } });
  expect(r.status()).toBe(409);
  expect((await r.json()).error.code).toBe("bill_has_payment");
  await expect(page.getByTestId("bill-discount-btn")).toHaveCount(0);
});

test("a cashier cannot go above the cap; a role without bills.discount sees no discount control", async ({ page, request }) => {
  const s = await gstShop(request);
  // a custom role: can bill and take payment, but cannot discount
  const role = await request.post(`${API}/roles`, { headers: s.auth, data: { name: "Bill only", permissions: ["bills.finalize", "bills.receipt", "payments.record", "orders.create", "kot.send", "kot.view"] } });
  expect(role.status(), await role.text()).toBe(201);
  const email = `bo-${Date.now()}@example.in`;
  const mk = await request.post(`${API}/auth/users`, { headers: s.auth, data: { email, full_name: "Counter", password: "supersecret123", role: "waiter" } });
  expect(mk.status(), await mk.text()).toBe(201);
  const uid = (await mk.json()).id;
  expect((await request.put(`${API}/users/${uid}/role`, { headers: s.auth, data: { role_id: (await role.json()).id } })).status()).toBe(200);
  const login = await (await request.post(`${API}/auth/login`, { data: { email, password: "supersecret123" } })).json();
  await signIn(page, login.access_token, login.refresh_token);
  await page.goto("/pos");
  await expect(page.getByRole("button", { name: /Paneer Tikka/ }).first()).toBeVisible();
  await page.getByRole("button", { name: /Paneer Tikka/ }).first().click();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("button", { name: "Make bill" })).toBeVisible();
  await expect(page.getByTestId("bill-discount-btn")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add discount" })).toHaveCount(0);
});

test("a cashier above the cap is told so in the dialog, at the make-bill step", async ({ page, request }) => {
  const s = await gstShop(request);
  const email = `cs-${Date.now()}@example.in`;
  const mk = await request.post(`${API}/auth/users`, { headers: s.auth, data: { email, full_name: "Cashier", password: "supersecret123", role: "cashier" } });
  expect(mk.status(), await mk.text()).toBe(201);
  const login = await (await request.post(`${API}/auth/login`, { data: { email, password: "supersecret123" } })).json();
  await signIn(page, login.access_token, login.refresh_token);
  await page.goto("/pos");
  await expect(page.getByRole("button", { name: /Paneer Tikka/ }).first()).toBeVisible();
  await toKitchen(page);
  await page.getByTestId("bill-discount-btn").click();
  const dlg = await fillDiscount(page, "Percent %", "11");
  await expect(dlg.getByTestId("discount-limit")).toContainText("Cashiers can give up to 10%");
  await expect(dlg.getByRole("button", { name: "Apply discount" })).toBeDisabled();
  await dlg.getByLabel("Percent off").fill("10");
  await dlg.getByRole("button", { name: "Apply discount" }).click();
  await expect(page.getByTestId("bill-discount-btn")).toContainText("Discount −");
});
