import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, billsFull, openAs, seedMenu, sendToKitchen, signIn, type MenuSeed } from "./helpers";

// Correct a finalized bill: an owner/manager edits the items of a finished bill; the server issues a credit note and a
// replacement invoice (original date kept, GST recomputed). Indian restaurant, prices include GST (5%).

const newKey = () => crypto.randomUUID();

async function sell(request: APIRequestContext, s: MenuSeed, name: string, type: "indoor" | "takeaway", pay = true) {
  const o = await (await request.post(`${API}/orders`, { headers: s.auth, data: {
    client_uuid: newKey(), order_type: type, table_id: type === "indoor" ? s.tableId : null, lines: [{ item_id: s.items[name].id, quantity: 1 }] } })).json();
  if (type === "indoor") await sendToKitchen(request, s.auth, o.id);
  const b = await (await request.post(`${API}/orders/${o.id}/bill`, { headers: s.auth, data: {} })).json();
  if (pay) {
    const p = await request.post(`${API}/bills/${b.id}/payments`, { headers: s.auth, data: { idempotency_key: newKey(), method: "card", amount: b.total } });
    expect(p.status(), await p.text()).toBe(201);
  }
  return b as { id: string; invoice_number: string; total: string };
}

async function staffToken(request: APIRequestContext, s: MenuSeed, role: string) {
  const email = `${role}-${Date.now()}@example.in`;
  const c = await request.post(`${API}/auth/users`, { headers: s.auth, data: { email, full_name: role, password: "supersecret123", role } });
  expect(c.status(), await c.text()).toBe(201);
  const l = await (await request.post(`${API}/auth/login`, { data: { email, password: "supersecret123" } })).json();
  return l as { access_token: string; refresh_token: string };
}

async function openBill(page: Page, invoice: string) {
  const card = page.getByTestId("order-card").filter({ hasText: /Takeaway|Table/ }).first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "View bill" }).click();
  await expect(page.getByRole("dialog").getByText(invoice).first()).toBeVisible();
}

test("owner swaps a dish for a cheaper one on a takeaway bill: GST recomputed, credit note + replacement, original kept", async ({ page, request }) => {
  const s = await seedMenu(request);
  const orig = await sell(request, s, "Lamb Karahi", "takeaway");   // 8.50 incl. 5% GST (0.40)
  await openAs(page, s.token, "/orders", s.refresh);
  await openBill(page, orig.invoice_number);
  await page.getByTestId("edit-bill").click();

  const line = page.getByTestId("amend-line").first();
  await expect(line.getByTestId("line-vat")).toHaveText("GST 5%");
  await line.getByRole("button", { name: "Change item" }).click();
  await page.getByRole("button", { name: /^Cucumber Salad/ }).click();
  // price and GST follow the new item immediately (server preview): 4.50 incl. 5% GST = 0.21
  await expect(line.getByTestId("line-vat")).toHaveText("GST 5%");
  await expect(page.getByTestId("new-total")).toHaveText("₹4.50");
  await expect(page.getByTestId("new-vat")).toHaveText("₹0.21");
  await expect(page.getByTestId("delta")).toContainText("-₹4.00");
  await expect(page.getByText("Refund ₹4.00 to customer")).toBeVisible();

  const save = page.getByTestId("amend-save");
  await expect(save).toBeDisabled();                       // a reason is required
  await page.getByRole("button", { name: "Wrong item", exact: true }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await page.getByRole("button", { name: "Issue credit note and new invoice" }).click();

  const result = page.getByTestId("amend-result");
  await expect(result).toContainText(`replaces ${orig.invoice_number}`.replace("replaces", "replaces"));
  await expect(result).toContainText("Return ₹4.00 to the customer");
  await expect(result.getByTestId("bill-actions")).toBeVisible();

  // via the API: replacement is the only active bill; the original is intact and superseded; credit note exists
  const active = await billsFull(request, s);
  expect(active).toHaveLength(1);
  expect(active[0].total).toBe("4.50");
  expect(active[0].tax_amount).toBe("0.21");
  const all = await (await request.get(`${API}/bills?include_superseded=true`, { headers: s.auth })).json() as { id: string; status: string; total: string; refunds: { kind: string; credit_note_number: string; amount: string }[]; sale_at: string; amends?: string }[];
  expect(all).toHaveLength(2);
  const old = all.find((b) => b.id === orig.id)!;
  expect(old.status).toBe("superseded");
  expect(old.total).toBe("8.50");
  expect(old.refunds.some((r) => r.kind === "amendment" && r.amount === "8.50" && r.credit_note_number.startsWith("CN"))).toBe(true);
  const repl = all.find((b) => b.id === active[0].id)!;
  expect(repl.sale_at).toBe(old.sale_at);                  // same date
  expect(repl.amends).toBe(orig.id);

  // done: the orders page shows the corrected bill with the chain and the Amended badge
  await result.getByRole("button", { name: "Done" }).or(page.getByRole("button", { name: "Done" })).first().click();
  await expect(page.getByTestId("amended-badge").first()).toBeVisible();
});

test("owner sees the CORRECTIONS block on today's end-of-day report", async ({ page, request }) => {
  const s = await seedMenu(request);
  const orig = await sell(request, s, "Lamb Karahi", "takeaway");
  const full = await (await request.get(`${API}/bills/${orig.id}`, { headers: s.auth })).json() as { lines: { id: string }[] };
  const r = await request.post(`${API}/bills/${orig.id}/amend`, { headers: s.auth, data: {
    lines: [{ bill_line_id: full.lines[0].id, item_id: s.items["Cucumber Salad"].id, quantity: 1 }], reason: "Wrong item",
    idempotency_key: newKey(), refund_method: "card" } });
  expect(r.status(), await r.text()).toBe(201);
  await openAs(page, s.token, "/end-of-day", s.refresh);
  const block = page.getByTestId("corrections-block");
  await expect(block).toBeVisible();
  await expect(block).toContainText("Wrong item");
  await expect(block).toContainText(orig.invoice_number);
  await expect(block).toContainText("-4.00");
  await expect(page.getByTestId("report-paper")).toContainText("CORRECTIONS (REVERSED)");
});

test("cashier cannot edit a bill (no button, API 403); correction disabled with a clear reason", async ({ page, request }) => {
  const s = await seedMenu(request);
  const orig = await sell(request, s, "Lamb Karahi", "takeaway");
  const cashier = await staffToken(request, s, "cashier");
  const full = await (await request.get(`${API}/bills/${orig.id}`, { headers: s.auth })).json() as { lines: { id: string; item_id: string }[] };
  const body = { lines: [{ bill_line_id: full.lines[0].id, item_id: full.lines[0].item_id, quantity: 2 }], reason: "Wrong quantity", idempotency_key: newKey() };
  const denied = await request.post(`${API}/bills/${orig.id}/amend`, { headers: { Authorization: `Bearer ${cashier.access_token}` }, data: body });
  expect(denied.status()).toBe(403);

  await openAs(page, cashier.access_token, "/orders", cashier.refresh_token);
  await openBill(page, orig.invoice_number);
  await expect(page.getByRole("button", { name: "View PDF receipt" })).toBeVisible();
  await expect(page.getByTestId("edit-bill")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // owner, corrections switched off (0 days): the button is disabled and says why; the API answers 409
  const put = await request.put(`${API}/restaurant`, { headers: s.auth, data: { name: "Karahi Test", trn: "27AAPFU0939F1ZV", address: null, bill_amend_days: 0 } });
  expect(put.status()).toBe(200);
  const blocked = await request.post(`${API}/bills/${orig.id}/amend`, { headers: s.auth, data: body });
  expect(blocked.status()).toBe(409);
  expect(await blocked.text()).toContain("turned off");
  await openAs(page, s.token, "/orders", s.refresh);
  await signIn(page, s.token, s.refresh);
  await page.reload();
  await openBill(page, orig.invoice_number);
  await expect(page.getByTestId("edit-bill")).toBeDisabled();
  await expect(page.getByTestId("edit-bill-why")).toContainText("turned off");
});

test("Manage > Restaurant: the correction window setting is editable by the owner", async ({ page, request }) => {
  const s = await seedMenu(request);
  await openAs(page, s.token, "/manage?tab=restaurant", s.refresh);
  const field = page.getByLabel("Bills can be corrected for (days)");
  await expect(field).toHaveValue("30");
  await field.fill("90");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Restaurant settings saved").first()).toBeVisible();
  const r = await (await request.get(`${API}/restaurant`, { headers: s.auth })).json();
  expect(r.bill_amend_days).toBe(90);
});

test("owner moves an indoor bill to an outdoor table: same items, same date, new bill shows the outdoor table", async ({ page, request }) => {
  const s = await seedMenu(request);
  const orig = await sell(request, s, "Lamb Karahi", "indoor");
  const t = await request.post(`${API}/tables`, { headers: s.auth, data: { label: "O7", seats: 4, area: "outdoor" } });
  expect(t.status(), await t.text()).toBe(201);
  await openAs(page, s.token, "/orders", s.refresh);
  await openBill(page, orig.invoice_number);
  await page.getByTestId("edit-bill").click();

  const save = page.getByTestId("amend-save");
  await page.getByRole("button", { name: "Other", exact: true }).click();
  await page.getByLabel("Note").fill("Sat outside");
  await expect(save).toBeDisabled();                       // nothing changed yet
  await page.getByTestId("amend-table").selectOption({ label: "O7" });
  await expect(page.getByTestId("new-table")).toHaveText("Table O7 · Outdoor");
  await expect(page.getByTestId("delta")).toContainText("₹0.00");
  await expect(save).toBeEnabled();
  await save.click();
  await page.getByRole("button", { name: "Issue credit note and new invoice" }).click();
  await expect(page.getByTestId("amend-result")).toBeVisible();

  const active = await (await request.get(`${API}/bills`, { headers: s.auth })).json() as { id: string; table_label: string; order_type: string; total: string; sale_at: string }[];
  expect(active).toHaveLength(1);
  expect([active[0].table_label, active[0].order_type, active[0].total]).toEqual(["O7", "outdoor", orig.total]);
  const old = await (await request.get(`${API}/bills/${orig.id}`, { headers: s.auth })).json() as { status: string; sale_at: string };
  expect(old.status).toBe("superseded");
  expect(active[0].sale_at).toBe(old.sale_at);
});
