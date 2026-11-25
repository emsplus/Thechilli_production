import { expect, test, type APIRequestContext } from "@playwright/test";
import { API } from "./helpers";
import { computeInvoice, allocate, type DiscountInput, type EstimateConfig } from "../src/lib/taxEstimate";

/**
 * Agreement tests: the client-side GST estimate (src/lib/taxEstimate.ts) must equal the server's `bill-preview`
 * to the paisa. No browser is used: the module is imported directly, the numbers come from the real API.
 */

interface Ctx { auth: Record<string, string>; items: Record<string, { id: string; price: string }>; table: string }
type LineSpec = [name: string, qty: number];

/** An Indian restaurant (GST 5%, prices include GST: the India default). */
async function mkRestaurant(request: APIRequestContext, prices: Record<string, string>): Promise<Ctx> {
  const email = `est-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.in`;
  const reg = await request.post(`${API}/auth/register-restaurant`, { data: {
    restaurant_name: "Estimate Cafe", country: "IN", trn: "27AAPFU0939F1ZV",
    owner_email: email, owner_name: "O", owner_password: "supersecret123" } });
  expect(reg.status()).toBe(201);
  const auth = { Authorization: `Bearer ${(await reg.json()).access_token}` };
  const cat = await (await request.post(`${API}/menu/categories`, { headers: auth, data: { name: "All" } })).json();
  const items: Ctx["items"] = {};
  for (const [name, price] of Object.entries(prices)) {
    const r = await request.post(`${API}/menu/items`, { headers: auth, data: { category_id: cat.id, name, price } });
    expect(r.status()).toBe(201);
    items[name] = { id: (await r.json()).id, price };
  }
  const table = await (await request.post(`${API}/tables`, { headers: auth, data: { label: "T1" } })).json();
  return { auth, items, table: table.id };
}

const MENU: Record<string, string> = {
  Curry: "8.50", Salad: "4.50", Coke: "3.20", Tikka: "7.95", Raita: "2.75", Naan: "3.10", Lassi: "4.35",
};

const getTrn = async (request: APIRequestContext, ctx: Ctx) => (await (await request.get(`${API}/restaurant`, { headers: ctx.auth })).json()).trn as string | null;

async function setRestaurant(request: APIRequestContext, ctx: Ctx, body: Record<string, unknown>) {
  const trn = await getTrn(request, ctx);
  const r = await request.put(`${API}/restaurant`, { headers: ctx.auth, data: { name: "Estimate Cafe", trn, address: null, ...body } });
  expect(r.status(), await r.text()).toBe(200);
}

const dec = (s: string) => Number(s).toFixed(2);

/** Creates a real order, asks the server for the preview, computes the estimate from the live tax-config, compares. */
async function agree(request: APIRequestContext, ctx: Ctx, type: "indoor" | "outdoor" | "takeaway" | "delivery", lines: LineSpec[],
  opts: { discount?: DiscountInput; sc?: boolean } = {}) {
  const order = await request.post(`${API}/orders`, { headers: ctx.auth, data: {
    client_uuid: crypto.randomUUID(), order_type: type, table_id: type === "indoor" ? ctx.table : null,
    lines: lines.map(([n, q]) => ({ item_id: ctx.items[n].id, quantity: q })) } });
  expect(order.status(), await order.text()).toBe(201);
  const o = await order.json();
  const body: Record<string, unknown> = {};
  if (opts.discount) body.discount = opts.discount;
  if (opts.sc === false) body.service_charge = false;
  const prev = await request.post(`${API}/orders/${o.id}/bill-preview`, { headers: ctx.auth, data: body });
  expect(prev.status(), await prev.text()).toBe(200);
  const server = await prev.json();
  // only previewed, never billed: cancel it so the table is free for the next case (a table holds one open order)
  const cancel = await request.post(`${API}/orders/${o.id}/cancel`, { headers: ctx.auth, data: { reason: "Preview only" } });
  expect(cancel.status(), await cancel.text()).toBe(200);
  const config = (await (await request.get(`${API}/billing/tax-config`, { headers: ctx.auth })).json()) as EstimateConfig;

  const est = computeInvoice(lines.map(([n, q]) => ({ description: n, quantity: q, unit_price: ctx.items[n].price })),
    config, type, opts.discount ?? null, opts.sc !== false);

  for (const k of ["subtotal", "tax_amount", "total", "discount_amount", "service_charge_amount", "service_charge_percent"] as const) {
    expect(dec(est[k]), k).toBe(dec(server[k]));
  }
  expect(est.discount_reason).toBe(server.discount_reason);
  expect(est.currency).toBe(server.currency);
  expect(est.prices_include_tax).toBe(server.prices_include_tax);
  expect(est.vat_registered).toBe(server.vat_registered);
  expect(est.tax_breakdown.map((b) => [b.code, dec(b.rate_percent), dec(b.net), dec(b.vat), dec(b.gross)]))
    .toEqual(server.tax_breakdown.map((b: Record<string, string>) => [b.code, dec(b.rate_percent), dec(b.net), dec(b.vat), dec(b.gross)]));
  expect(est.lines.map((l) => [l.description, l.quantity, dec(l.line_total), dec(l.discount), dec(l.gross), dec(l.net), dec(l.vat), l.tax_code, dec(l.rate_percent)]))
    .toEqual(server.lines.map((l: Record<string, string | number>) => [l.description, l.quantity, dec(l.line_total as string), dec(l.discount as string), dec(l.gross as string), dec(l.net as string), dec(l.vat as string), l.tax_code, dec(l.rate_percent as string)]));
  expect(!!est.service_charge).toBe(!!server.service_charge);
  if (est.service_charge && server.service_charge) {
    expect([dec(est.service_charge.vat), dec(est.service_charge.net), dec(est.service_charge.gross), est.service_charge.tax_code])
      .toEqual([dec(server.service_charge.vat), dec(server.service_charge.net), dec(server.service_charge.gross), server.service_charge.tax_code]);
  }
  return { est, server };
}

test.describe.configure({ mode: "serial" });

let inr: Ctx;
test.beforeAll(async ({ request }) => {
  inr = await mkRestaurant(request, MENU);
  await setRestaurant(request, inr, { service_charge_percent: "12.5", max_cashier_discount_percent: "10" });
});

test("allocate() is largest-remainder and adds up exactly (ties by index)", () => {
  expect(allocate(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
  expect(allocate(1n, [5n, 5n])).toEqual([1n, 0n]);
  expect(allocate(0n, [5n, 5n])).toEqual([0n, 0n]);
  const parts = allocate(1234n, [850n, 450n, 320n]);
  expect(parts.reduce((a, b) => a + b, 0n)).toBe(1234n);
});

test("inclusive prices: dine-in with service charge", async ({ request }) => {
  const { est } = await agree(request, inr, "indoor", [["Curry", 2], ["Salad", 1], ["Coke", 1]]);
  expect(est.tax_breakdown).toHaveLength(1); // one GST rate
  expect(est.currency).toBe("INR");
  expect(Number(est.service_charge_amount)).toBeGreaterThan(0);
});

test("dine-in, service charge removed for this bill", async ({ request }) => {
  const { est } = await agree(request, inr, "indoor", [["Tikka", 1], ["Naan", 3], ["Lassi", 2]], { sc: false });
  expect(est.service_charge_amount).toBe("0.00");
});

test("takeaway: every item at the one 5% rate, no service charge", async ({ request }) => {
  const { est } = await agree(request, inr, "takeaway", [["Curry", 1], ["Salad", 1], ["Coke", 1]]);
  expect(est.tax_breakdown.map((b) => [b.code, b.rate_percent])).toEqual([["standard", "5.00"]]);
  expect(est.service_charge_amount).toBe("0.00"); // never on takeaway
  // 8.50 + 4.50 + 3.20 = 16.20 incl. GST -> GST = round(16.20 * 5 / 105) = 0.77
  expect(est.tax_amount).toBe("0.77");
  expect(est.total).toBe("16.20");
});

test("delivery behaves like takeaway", async ({ request }) => {
  await agree(request, inr, "delivery", [["Raita", 2], ["Tikka", 2], ["Lassi", 1]]);
});

test("percent discount on a takeaway mix", async ({ request }) => {
  const { est } = await agree(request, inr, "takeaway", [["Curry", 3], ["Salad", 2], ["Coke", 1], ["Naan", 1]],
    { discount: { type: "percent", value: "10", reason: "Staff meal" } });
  expect(Number(est.discount_amount)).toBeGreaterThan(0);
});

test("fixed-amount discount on dine-in with service charge", async ({ request }) => {
  await agree(request, inr, "indoor", [["Curry", 2], ["Tikka", 1], ["Lassi", 3], ["Raita", 1]],
    { discount: { type: "amount", value: "5.00", reason: "Customer complaint" } });
});

test("odd paise and awkward quantities (largest-remainder spreading)", async ({ request }) => {
  await agree(request, inr, "outdoor", [["Tikka", 3], ["Raita", 7], ["Lassi", 3], ["Naan", 5]],
    { discount: { type: "percent", value: "7.5", reason: "Loyalty card" } });
  await agree(request, inr, "takeaway", [["Tikka", 3], ["Raita", 7], ["Lassi", 3], ["Naan", 5]],
    { discount: { type: "amount", value: "0.01", reason: "Rounding favour" } });
});

test("exclusive-price mode: GST added on top, dine-in with service charge, takeaway and delivery", async ({ request }) => {
  await setRestaurant(request, inr, { prices_include_tax: false });
  const a = await agree(request, inr, "indoor", [["Curry", 2], ["Coke", 1]]);
  expect(a.est.prices_include_tax).toBe(false);
  const b = await agree(request, inr, "takeaway", [["Salad", 3], ["Coke", 1]], { discount: { type: "percent", value: "15", reason: "Corporate account" } });
  expect(b.est.tax_breakdown.map((x) => x.rate_percent)).toEqual(["5.00"]);
  await agree(request, inr, "delivery", [["Tikka", 3], ["Lassi", 3]]);
  await setRestaurant(request, inr, { prices_include_tax: true });
});

test("not GST registered: no GST at all (the document is a bill of supply)", async ({ request }) => {
  await setRestaurant(request, inr, { vat_registered: false });
  const a = await agree(request, inr, "indoor", [["Curry", 2], ["Salad", 1]], { discount: { type: "amount", value: "3.00", reason: "Birthday treat" } });
  expect(a.est.tax_amount).toBe("0.00");
  expect(a.est.tax_breakdown.map((x) => x.code)).toEqual(["none"]);
  await agree(request, inr, "takeaway", [["Salad", 1], ["Coke", 2]]);
  await setRestaurant(request, inr, { vat_registered: true });
});
