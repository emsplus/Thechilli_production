import { expect, type APIRequestContext } from "@playwright/test";
import { API, seedMenu, type MenuSeed } from "./helpers";

const newKey = () => crypto.randomUUID();
export interface InsightDay { s: MenuSeed; day: string; manager: Tok; cashier: Tok; billNo: string }
export interface Tok { access_token: string; refresh_token: string }

async function staff(request: APIRequestContext, s: MenuSeed, role: string, name: string): Promise<Tok> {
  const email = `${role}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@example.in`;
  expect((await request.post(`${API}/auth/users`, { headers: s.auth, data: { email, full_name: name, password: "supersecret123", role } })).status()).toBe(201);
  return (await request.post(`${API}/auth/login`, { data: { email, password: "supersecret123" } })).json();
}
const bearer = (t: Tok) => ({ Authorization: `Bearer ${t.access_token}` });

async function sell(request: APIRequestContext, s: MenuSeed, h: Record<string, string>, item: string, qty: number, o: { discount?: object; pay?: boolean; type?: "takeaway" | "indoor"; customer?: string } = {}) {
  const type = o.type ?? "takeaway";
  const ord = await (await request.post(`${API}/orders`, { headers: h, data: { client_uuid: newKey(), order_type: type, table_id: type === "indoor" ? s.tableId : null, lines: [{ item_id: s.items[item].id, quantity: qty }], ...(o.customer ? { customer_id: o.customer } : {}) } })).json();
  const r = await request.post(`${API}/orders/${ord.id}/bill`, { headers: h, data: o.discount ? { discount: o.discount } : {} });
  expect(r.status(), await r.text()).toBe(201);
  const b = await r.json();
  if (o.pay !== false) expect((await request.post(`${API}/bills/${b.id}/payments`, { headers: s.auth, data: { idempotency_key: newKey(), method: "card", amount: b.total } })).status()).toBe(201);
  return b as { id: string; invoice_number: string; total: string };
}

let cached: Promise<InsightDay> | null = null;
/**
 * One day (Indian restaurant, prices include 5% GST) with known leakage, shared by the specs of a run (the owner's tokens stay valid):
 *   owner   : Lamb Karahi x2 = 17.00 paid; refund 2.00 "Cold food" on it; Cucumber Salad x1 = 4.50 paid (customer Sam Regular)
 *   Mina (manager): Lamb Karahi x2 with 20% off "Regular customer" = 13.60 paid
 *   Casey (cashier): rings up one order Lamb Karahi, sent to the kitchen; Mina (manager) cancels it "Customer left" (cancelling after
 *                    the kitchen has the order needs a manager: pos-service ORDER_RULES rule 6)
 *   an expense Airtel (Telecom) 74.29 + 13.37 GST (18%); stock Lamb 10000 g at 0.01/g, Rice 100 g (low, reorder 5000); recipe Lamb Karahi = 200 g Lamb
 */
export function insightDay(request: APIRequestContext): Promise<InsightDay> {
  cached ??= (async () => {
    const s = await seedMenu(request);
    const tz = (await (await request.get(`${API}/restaurant`, { headers: s.auth })).json()).timezone as string;
    const day = new Date().toLocaleDateString("en-CA", { timeZone: tz });
    const manager = await staff(request, s, "manager", "Mina Manager");
    const cashier = await staff(request, s, "cashier", "Casey Cashier");
    const bulk = await request.post(`${API}/inventory/items/bulk`, { headers: s.auth, data: { idempotency_key: newKey(), items: [
      { name: "Lamb", base_unit: "g", reorder_level: "500", opening_quantity: "10000", opening_unit: "g", unit_cost: "0.01" },
      { name: "Rice", base_unit: "g", reorder_level: "5000", opening_quantity: "100", opening_unit: "g", unit_cost: "0.002" }] } });
    expect(bulk.status(), await bulk.text()).toBe(201);
    const lamb = ((await bulk.json()).created as { id: string; name: string }[]).find((i) => i.name === "Lamb")!;
    const rec = await request.post(`${API}/recipes`, { headers: s.auth, data: { menu_item_id: s.items["Lamb Karahi"].id, ingredients: [{ item_id: lamb.id, quantity: "200", unit: "g" }] } });
    expect(rec.status(), await rec.text()).toBe(201);

    const b1 = await sell(request, s, s.auth, "Lamb Karahi", 2);
    const sam = await (await request.post(`${API}/customers`, { headers: s.auth, data: { name: "Sam Regular", phone: "+919811123456" } })).json();
    await sell(request, s, s.auth, "Cucumber Salad", 1, { customer: sam.id });
    await sell(request, s, bearer(manager), "Lamb Karahi", 2, { discount: { type: "percent", value: "20", reason: "Regular customer" } });
    const rf = await request.post(`${API}/bills/${b1.id}/refunds`, { headers: s.auth, data: { idempotency_key: newKey(), amount: "2.00", reason: "Cold food" } });
    expect(rf.status(), await rf.text()).toBe(201);
    const h = bearer(cashier);
    const hm = bearer(manager);
    const o = await (await request.post(`${API}/orders`, { headers: h, data: { client_uuid: newKey(), order_type: "indoor", table_id: s.tableId, lines: [{ item_id: s.items["Lamb Karahi"].id, quantity: 1 }] } })).json();
    expect((await request.post(`${API}/orders/${o.id}/kot`, { headers: h })).status()).toBe(201);
    expect((await request.post(`${API}/orders/${o.id}/cancel`, { headers: hm, data: { reason: "Customer left" } })).status()).toBe(200);
    const ex = await request.post(`${API}/expenses`, { headers: s.auth, data: { supplier_name: "Airtel", category: "Telecom", net: "74.29", vat: "13.37", expense_date: day } });
    expect(ex.status(), await ex.text()).toBe(201);
    return { s, day, manager, cashier, billNo: b1.invoice_number };
  })();
  return cached;
}
