import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, billsFull, openAs, seedMenu, sendToKitchen, type MenuSeed } from "./helpers";

// End of day: X report (today so far), closing the day (Z report), history, role gate, settings, sales by category.
// Day seeded through the API on an Indian restaurant (prices include GST at 5%): table order + takeaway order with a discount, one cancelled order (void).

const closeBtn = (page: Page) => page.getByRole("button", { name: "Close day & print Z-report" });
const newKey = () => crypto.randomUUID();

async function put(request: APIRequestContext, s: MenuSeed, extra: Record<string, unknown>) {
  const r = await request.put(`${API}/restaurant`, { headers: s.auth, data: { name: "Karahi Test", trn: "27AAPFU0939F1ZV", address: "12 MG Road, Pune", ...extra } });
  expect(r.status(), await r.text()).toBe(200);
}

async function order(request: APIRequestContext, s: MenuSeed, lines: [string, number][], type: "indoor" | "takeaway") {
  const r = await request.post(`${API}/orders`, { headers: s.auth, data: {
    client_uuid: newKey(), order_type: type, table_id: type === "indoor" ? s.tableId : null,
    lines: lines.map(([n, q]) => ({ item_id: s.items[n].id, quantity: q })) } });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()) as { id: string };
}
async function sell(request: APIRequestContext, s: MenuSeed, lines: [string, number][], type: "indoor" | "takeaway", method: "cash" | "card", discount?: object) {
  const o = await order(request, s, lines, type);
  if (type === "indoor") await sendToKitchen(request, s.auth, o.id);
  const b = await (await request.post(`${API}/orders/${o.id}/bill`, { headers: s.auth, data: discount ? { discount } : {} })).json();
  const p = await request.post(`${API}/bills/${b.id}/payments`, { headers: s.auth, data: { idempotency_key: newKey(), method, amount: b.total } });
  expect(p.status(), await p.text()).toBe(201);
}

/** table (card) + takeaway (cash, 1.00 Birthday discount) + one cancelled order (void 6.00). */
async function seedDay(request: APIRequestContext, s: MenuSeed) {
  await sell(request, s, [["Lamb Karahi", 2], ["Coke", 1]], "indoor", "card");
  await sell(request, s, [["Lamb Karahi", 1], ["Cucumber Salad", 1]], "takeaway", "cash", { type: "amount", value: "1.00", reason: "Birthday" });
  const o = await order(request, s, [["Garlic Naan", 2]], "indoor");
  const c = await request.post(`${API}/orders/${o.id}/cancel`, { headers: s.auth, data: { reason: "Walked out" } });
  expect(c.status(), await c.text()).toBe(200);
}

const sum = (xs: string[]) => (xs.reduce((a, x) => a + Math.round(parseFloat(x) * 100), 0) / 100).toFixed(2);
const pdfWidth = (buf: Buffer) => parseFloat(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)/.exec(buf.toString("latin1"))![1]);

test("X report matches the day's bills: takings, categories, GST, discount, void", async ({ page, request }) => {
  const s = await seedMenu(request);
  await seedDay(request, s);
  const bills = await billsFull(request, s);
  const takings = sum(bills.map((b) => b.total));
  const vat = sum(bills.map((b) => b.tax_amount));
  const x = await (await request.get(`${API}/reports/x-report`, { headers: s.auth })).json();
  expect(x.deductions.total_takings).toBe(takings);
  expect(x.summary.vat.total.vat).toBe(vat);

  await openAs(page, s.token, "/end-of-day", s.refresh);
  const stats = page.getByTestId("eod-stats");
  await expect(stats).toContainText(takings);
  await expect(stats).toContainText(vat);
  await expect(stats.getByText("Orders", { exact: true })).toBeVisible();
  const paper = page.getByTestId("report-paper");
  await expect(paper).toContainText("Karahi Test");
  await expect(paper).toContainText("Mains"); // the category
  await expect(paper).toContainText(x.channels[0].sub_total.sales);
  await expect(paper).toContainText("IN-STORE ORDERS");
  await expect(paper).toContainText("TAKE AWAY");
  await expect(paper).toContainText("Birthday");
  await expect(paper).toContainText("1.00");
  await expect(paper).toContainText(takings);
  await expect(paper).toContainText("GST 5%");
  await expect(paper).toContainText(x.summary.vat.total.vat);
  await expect(paper.getByText("VOIDS").first()).toBeVisible();
  await expect(paper).toContainText("6.00"); // the cancelled order
  await expect(paper).toContainText("Walked out");
  await expect(page.getByRole("button", { name: "Print X report" })).toBeEnabled();
});

test("closing the day: warnings must be acknowledged, Z3179 then Z3180 (empty), PDFs, history", async ({ page, request }) => {
  const s = await seedMenu(request);
  await put(request, s, { z_report_next_number: 3179, phone: "022 4000 1234" });
  await seedDay(request, s);
  await order(request, s, [["Coke", 1]], "indoor"); // stays open -> a warning

  await openAs(page, s.token, "/end-of-day", s.refresh);
  await expect(page.getByTestId("report-paper")).toContainText("TEL: 022 4000 1234");
  await closeBtn(page).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByText("cannot be undone", { exact: false })).toBeVisible();
  await expect(dlg.getByTestId("close-warnings")).toContainText("1 open order");
  const confirm = dlg.getByRole("button", { name: "Yes, close the day" });
  await expect(confirm).toBeDisabled();
  await dlg.getByLabel("I have read these warnings").check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByTestId("close-success")).toContainText("Z3179 closed");

  const list = await (await request.get(`${API}/reports/z-reports?limit=30`, { headers: s.auth })).json();
  expect(list.items).toHaveLength(1);
  const z = list.items[0];
  expect(z.number_label).toBe("Z3179");
  for (const url of [`${API}/reports/z-reports/${z.id}/slip.pdf`, `${API}/reports/x-report/slip.pdf`]) {
    const pdf = await request.get(url, { headers: s.auth });
    expect(pdf.status()).toBe(200);
    const buf = await pdf.body();
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
    expect(Math.abs(pdfWidth(buf) - 226.8)).toBeLessThan(1);
  }

  // download works through the authed fetch
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF" }).click();
  expect((await dl).suggestedFilename()).toBe("Z3179.pdf");

  // start a new day: empty X; close again right away -> empty Z3180
  await page.getByRole("button", { name: "Start new day" }).click();
  await expect(page.getByText("Nothing has been sold in this period yet.")).toBeVisible();
  await closeBtn(page).click();
  await page.getByRole("dialog").getByLabel("I have read these warnings").check(); // the open order is still open
  await page.getByRole("dialog").getByRole("button", { name: "Yes, close the day" }).click();
  await expect(page.getByTestId("close-success")).toContainText("Z3180 closed");
  await expect(page.getByTestId("close-success")).toContainText("empty report");

  // history lists both, newest first; the empty one is badged; detail renders the stored report
  await page.getByRole("button", { name: "View report" }).click();
  await expect(page).toHaveURL(/\/end-of-day\?z=/);
  await expect(page.getByTestId("report-paper")).toContainText("Z3180");
  await page.getByRole("link", { name: "All Z-reports" }).click();
  const items = page.getByRole("list", { name: "Z-reports" }).getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Z3180");
  await expect(items.nth(0)).toContainText("Empty day");
  await expect(items.nth(1)).toContainText("Z3179");
  await page.getByRole("link", { name: "Open Z3179" }).click();
  await expect(page.getByTestId("report-paper")).toContainText("Z3179");
  await expect(page.getByTestId("report-paper")).toContainText(z.net_sales);
  await expect(page.getByRole("button", { name: "Print", exact: true })).toBeVisible();
  // deep link
  await page.goto(`/end-of-day?z=${z.id}`);
  await expect(page.getByTestId("report-paper")).toContainText("Z3179");
});

test("closing twice with the same key returns the same report", async ({ request }) => {
  const s = await seedMenu(request);
  const key = newKey();
  const a = await request.post(`${API}/reports/z-report`, { headers: s.auth, data: { idempotency_key: key } });
  expect(a.status()).toBe(201);
  const b = await request.post(`${API}/reports/z-report`, { headers: s.auth, data: { idempotency_key: key } });
  expect(b.status()).toBe(200);
  expect((await b.json()).id).toBe((await a.json()).id);
});

test("unsynced devices warn before closing and stop warning once synced", async ({ page, request }) => {
  const s = await seedMenu(request);
  const device = newKey();
  const hb = (n: number) => request.post(`${API}/sync/heartbeat`, { headers: s.auth, data: { device_key: device, pending_ops: n, name: "Till 2" } });
  expect((await hb(3)).status()).toBe(204);
  await openAs(page, s.token, "/end-of-day", s.refresh);
  await expect(page.getByText("Some sales are not on the server yet")).toBeVisible();
  await closeBtn(page).click();
  let dlg = page.getByRole("dialog");
  await expect(dlg.getByTestId("close-warnings")).toContainText("unsynced");
  await expect(dlg.getByTestId("close-warnings")).toContainText("NEXT Z-report");
  await expect(dlg.getByRole("button", { name: "Yes, close the day" })).toBeDisabled();
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toBeHidden();

  expect((await hb(0)).status()).toBe(204);
  await closeBtn(page).click(); // re-reads the X report first
  dlg = page.getByRole("dialog");
  await expect(dlg.getByRole("button", { name: "Yes, close the day" })).toBeEnabled();
  await expect(dlg.getByTestId("close-warnings")).toHaveCount(0);
});

test("cashiers do not see End of day and get the friendly blocked screen", async ({ page, browser, baseURL, request }) => {
  const s = await seedMenu(request);
  const email = `cashier-${Date.now()}@example.in`;
  expect((await request.post(`${API}/auth/users`, { headers: s.auth, data: { email, full_name: "Casey", password: "Samosa-and-chai-26", role: "cashier" } })).status()).toBe(201);
  const pair = await (await request.post(`${API}/auth/login`, { data: { email, password: "Samosa-and-chai-26" } })).json();
  const p2 = await (await browser.newContext({ baseURL, serviceWorkers: "block" })).newPage();
  await openAs(p2, pair.access_token, "/pos", pair.refresh_token);
  await expect(p2.getByRole("button", { name: /^Lamb Karahi,/ })).toBeVisible();
  await expect(p2.getByRole("link", { name: "End of day", exact: true })).toHaveCount(0);
  await expect(p2.getByRole("link", { name: "Chilli Agent", exact: true }).first()).toBeVisible();
  await p2.goto("/end-of-day");
  await expect(p2.getByText("Ask the owner or manager")).toBeVisible();
  await expect(p2.getByRole("navigation", { name: "Manage sections" }).getByRole("link", { name: "End of day", exact: true })).toHaveCount(0); // Manage lists only what a cashier may use
  await expect(p2.getByTestId("report-paper")).toHaveCount(0);

  // the owner does see it
  await openAs(page, s.token, "/reports", s.refresh); // Manage's navigation (beside Reports) lists End of day
  await expect(page.getByRole("navigation", { name: "Manage sections" }).getByRole("link", { name: "End of day", exact: true })).toBeVisible();
});

test("Restaurant tab: phone and next Z number persist; the number locks after the first Z-report", async ({ page, request }) => {
  const s = await seedMenu(request);
  await openAs(page, s.token, "/manage?tab=restaurant", s.refresh);
  await page.getByLabel("Phone").fill("022 4000 1234");
  const next = page.getByLabel("Next Z-report number");
  await expect(next).toBeEnabled();
  await expect(page.getByText("continue your old till's numbering", { exact: false })).toBeVisible();
  await next.fill("3179");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Restaurant settings saved")).toBeVisible();
  const r = await (await request.get(`${API}/restaurant`, { headers: s.auth })).json();
  expect(r.phone).toBe("022 4000 1234");
  expect(r.z_report_next_number).toBe(3179);
  await page.reload();
  await expect(page.getByLabel("Phone")).toHaveValue("022 4000 1234");
  await expect(page.getByLabel("Next Z-report number")).toHaveValue("3179");

  const z = await request.post(`${API}/reports/z-report`, { headers: s.auth, data: { idempotency_key: newKey() } });
  expect(z.status()).toBe(201);
  await page.reload();
  await expect(page.getByLabel("Next Z-report number")).toBeDisabled();
  await expect(page.getByText("can no longer be changed")).toBeVisible();
  // the phone can still be changed (and cleared)
  await page.getByLabel("Phone").fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Restaurant settings saved")).toBeVisible();
  expect((await (await request.get(`${API}/restaurant`, { headers: s.auth })).json()).phone).toBeNull();
});

test("Reports: sales by category shows the seeded categories and switches channel", async ({ page, request }) => {
  const s = await seedMenu(request);
  await seedDay(request, s);
  await openAs(page, s.token, "/reports", s.refresh);
  const card = page.getByTestId("sales-by-category");
  await expect(card.getByRole("heading", { name: "Sales by category" })).toBeVisible(); // the table caption also says "Sales by category table"
  const table = card.getByRole("table", { name: "Sales by category table" });
  const row = table.getByRole("row", { name: /^Mains/ });
  await expect(row).toContainText("5"); // 2 + 1 + 1 + 1 items sold
  await expect(card.getByRole("list", { name: "Sales by category, net" })).toContainText("Mains");
  await card.getByRole("radio", { name: "Take away" }).click();
  await expect(table.getByRole("row", { name: /^Mains/ })).toContainText("2"); // karahi + salad
  await card.getByRole("radio", { name: "Online" }).click();
  await expect(card.getByText("No sales in this channel for this range.")).toBeVisible();
  await expect(page.getByRole("link", { name: "End of day (Z report)" })).toBeVisible();
});
