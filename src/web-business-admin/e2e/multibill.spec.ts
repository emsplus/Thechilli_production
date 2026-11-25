import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { payCash, API, signIn as signInSession } from "./helpers";

// Several bills open at once on the POS (ticket strip). Self-contained seed: 2 dishes + 3 tables.

interface S { token: string; refresh: string; auth: Record<string, string>; tables: Record<string, string> }
interface BillRow { invoice_number: string; total: string; balance_due: string; payments: unknown[]; order_id: string }
interface OrderRow { id: string; table_id: string | null; status: string; subtotal: string }

async function seedMulti(request: APIRequestContext): Promise<S> {
  const email = `mb-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.in`;
  const reg = await request.post(`${API}/auth/register-restaurant`, { data: {
    restaurant_name: "Multi Bill Cafe", country: "IN", trn: "27AAPFU0939F1ZV", owner_email: email, owner_name: "O", owner_password: "supersecret123" } });
  const pair = await reg.json();
  const auth = { Authorization: `Bearer ${pair.access_token as string}` };
  const cat = await (await request.post(`${API}/menu/categories`, { headers: auth, data: { name: "Drinks" } })).json();
  await request.post(`${API}/menu/items`, { headers: auth, data: { category_id: cat.id, name: "Latte", price: "12.50" } });
  await request.post(`${API}/menu/items`, { headers: auth, data: { category_id: cat.id, name: "Mocha", price: "14.00" } });
  const tables: Record<string, string> = {};
  for (const label of ["T1", "T2", "T3"]) tables[label] = (await (await request.post(`${API}/tables`, { headers: auth, data: { label } })).json()).id;
  // GST added on top of the menu prices (the arithmetic below: 2 x 12.50 + 5% = 26.25); India defaults to GST-inclusive prices
  const put = await request.put(`${API}/restaurant`, { headers: auth, data: { name: "Multi Bill Cafe", trn: "27AAPFU0939F1ZV", address: null, prices_include_tax: false } });
  expect(put.status(), await put.text()).toBe(200);
  return { token: pair.access_token, refresh: pair.refresh_token, auth, tables };
}

const bills = async (request: APIRequestContext, s: S) => (await (await request.get(`${API}/bills`, { headers: s.auth })).json()) as BillRow[];
const orders = async (request: APIRequestContext, s: S) => (await (await request.get(`${API}/orders`, { headers: s.auth })).json()) as OrderRow[];

async function signIn(page: Page, s: S) {
  await signInSession(page, s.token, s.refresh);
}

async function open(page: Page, s: S, opts: { sw?: boolean } = {}) {
  await signIn(page, s);
  await page.goto("/pos");
  await expect(page.getByRole("button", { name: /Latte/ }).first()).toBeVisible();
  if (opts.sw) await page.evaluate(async () => { await navigator.serviceWorker.ready; }); // production build only
}

const tabs = (page: Page) => page.getByRole("tablist", { name: "Open orders" }).getByRole("tab");
const tab = (page: Page, label: RegExp) => page.getByRole("tablist", { name: "Open orders" }).getByRole("tab", { name: label });
const dish = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name},`) });
const openAnother = (page: Page) => page.getByRole("button", { name: "Open another order" }).click();

async function addDish(page: Page, name: string, qty = 1) {
  await dish(page, name).click();
  for (let i = 1; i < qty; i++) await page.getByRole("button", { name: `Increase ${name}` }).click();
}

async function setDineIn(page: Page, table: string) {
  await page.getByRole("radio", { name: "Dine-in" }).click();
  await page.getByRole("group", { name: "Table" }).getByRole("button", { name: new RegExp(table) }).click();
}

/** How many drafts are in IndexedDB (poll this before reloading: persistence is asynchronous). */
const storedDrafts = (page: Page) => page.evaluate(() => new Promise<number>((resolve, reject) => {
  const o = indexedDB.open("pos-offline");
  o.onerror = () => reject(o.error);
  o.onsuccess = () => {
    const db = o.result;
    if (!db.objectStoreNames.contains("drafts")) { db.close(); resolve(-1); return; }
    const r = db.transaction("drafts").objectStore("drafts").count();
    r.onsuccess = () => { resolve(r.result); db.close(); };
  };
}));

test("three tickets stay independent; two are billed and paid while the third remains a draft", async ({ page, request }) => {
  const s = await seedMulti(request);
  await open(page, s);

  // Ticket 1: takeaway, 2 x Latte.
  await addDish(page, "Latte", 2);
  // Ticket 2: dine-in T2, 1 x Mocha.
  await openAnother(page);
  await expect(tabs(page)).toHaveCount(2);
  await setDineIn(page, "T2");
  await addDish(page, "Mocha");
  // Ticket 3: takeaway, Latte + Mocha (never placed).
  await openAnother(page);
  await expect(tabs(page)).toHaveCount(3);
  await addDish(page, "Latte");
  await addDish(page, "Mocha");

  // Switching never mixes carts.
  await tab(page, /^Bill 1,/).click();
  await expect(page.getByRole("button", { name: "Increase Latte" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Increase Mocha" })).toHaveCount(0);
  await tab(page, /^Bill 2, Table T2 · Indoor,/).click();
  await expect(page.getByRole("button", { name: "Increase Mocha" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Increase Latte" })).toHaveCount(0);
  await tab(page, /^Bill 3,/).click();
  await expect(page.getByRole("button", { name: "Increase Latte" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Increase Mocha" })).toBeVisible();

  // Pay ticket 1.
  await tab(page, /^Bill 1,/).click();
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: "Make bill" }).click();
  await payCash(page);
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible();
  await page.getByRole("button", { name: "New order" }).click(); // dismisses the paid ticket

  // Pay ticket 2 (a different ticket was mid-way the whole time).
  await tab(page, /^Bill 2, Table T2 · Indoor,/).click();
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: /^Send to kitchen/ }).click(); // dine-in: the kitchen gets it before the bill (audit C-01)
  await page.getByRole("button", { name: "Make bill" }).click();
  await payCash(page);
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible();

  await expect.poll(async () => (await bills(request, s)).map((b) => b.total).sort(), { timeout: 20_000 }).toEqual(["14.70", "26.25"]);
  const b = await bills(request, s);
  for (const x of b) { expect(Number(x.balance_due)).toBe(0); expect(x.payments).toHaveLength(1); }
  const os = await orders(request, s);
  expect(os).toHaveLength(2); // ticket 3 was never sent to the server
  expect(os.filter((o) => o.table_id === s.tables.T2)).toHaveLength(1);

  // Ticket 3 is untouched.
  await tab(page, /^Bill 3,/).click();
  await expect(page.getByRole("button", { name: "Place order" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Increase Mocha" })).toBeVisible();
});

test("a reload restores every open ticket exactly", async ({ page, request }) => {
  const s = await seedMulti(request);
  await open(page, s);

  await addDish(page, "Latte", 2);
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("button", { name: "Make bill" })).toBeVisible(); // ticket 1 is placed on the server

  await openAnother(page);
  await setDineIn(page, "T3");
  await addDish(page, "Mocha");
  await expect(tabs(page)).toHaveCount(2);
  await expect.poll(() => storedDrafts(page)).toBe(2);
  // Persistence is per changed ticket: wait until the cart edit above is flushed too.
  await expect(tab(page, /^Bill 2, Table T3 · Indoor, 1 item,/)).toBeVisible();

  await page.reload();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tab(page, /^Bill 2, Table T3 · Indoor, 1 item,.*Not sent/)).toHaveAttribute("aria-selected", "true"); // the active ticket is restored too
  await expect(page.getByRole("button", { name: "Increase Mocha" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Table" }).getByRole("button", { name: /T3/ })).toHaveAttribute("aria-pressed", "true");

  await tab(page, /^Bill 1,/).click();
  await expect(tab(page, /^Bill 1, Takeaway, 2 items,.*Placed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Make bill" })).toBeVisible();
  expect(await orders(request, s)).toHaveLength(1);
});

test("two tickets queued offline survive a reload and sync exactly once", async ({ page, context, request }) => {
  const s = await seedMulti(request);
  await open(page, s, { sw: true });
  await context.setOffline(true);
  await expect(page.getByTestId("conn")).toHaveText("Offline");

  await addDish(page, "Latte", 2);
  await page.getByRole("button", { name: /Place order/ }).click();
  await expect(page.getByTestId("order-line")).toContainText("Saved offline");
  await page.getByRole("button", { name: "Cash (offline)" }).click();
  await expect(page.getByTestId("provisional")).toBeVisible();

  await openAnother(page);
  await addDish(page, "Mocha", 2);
  await page.getByRole("button", { name: /Place order/ }).click();
  await expect(page.getByTestId("order-line")).toContainText("Saved offline");
  await page.getByRole("button", { name: "Cash (offline)" }).click();
  await expect(page.getByTestId("provisional")).toBeVisible();
  await expect(page.getByTestId("pending-count")).toHaveText("6 pending"); // 2 x (order + bill + payment)

  await page.reload();
  await expect(page.getByTestId("pending-count")).toHaveText("6 pending");
  await expect(tabs(page)).toHaveCount(2); // both finished-offline tickets are still on screen
  expect(await bills(request, s)).toHaveLength(0);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("pending-count")).toHaveCount(0, { timeout: 30_000 });

  await expect.poll(async () => (await bills(request, s)).map((b) => b.total).sort(), { timeout: 30_000 }).toEqual(["26.25", "29.40"]);
  for (const x of await bills(request, s)) { expect(Number(x.balance_due)).toBe(0); expect(x.payments).toHaveLength(1); }
  expect(await orders(request, s)).toHaveLength(2);

  await page.reload(); // must not resend anything
  await expect(tabs(page).first()).toBeVisible();
  await expect.poll(async () => (await bills(request, s)).length).toBe(2);
  expect(await orders(request, s)).toHaveLength(2);
});

test("closing a non-empty ticket asks for confirmation; an empty one closes silently", async ({ page, request }) => {
  const s = await seedMulti(request);
  await open(page, s);
  await addDish(page, "Latte");

  await page.getByRole("button", { name: "Close Bill 1" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByText("Discard this draft?")).toBeVisible();
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(tab(page, /^Bill 1, Takeaway, 1 item,/)).toBeVisible(); // kept
  await expect(page.getByRole("button", { name: "Increase Latte" })).toBeVisible();

  await page.getByRole("button", { name: "Close Bill 1" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Discard draft" }).click();
  await expect(tab(page, /^Bill 1, Takeaway, 0 items,/)).toBeVisible(); // replaced by a fresh empty ticket
  await expect(page.getByRole("button", { name: "Increase Latte" })).toHaveCount(0);

  await openAnother(page);
  await expect(tabs(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Close Bill 2" }).click(); // empty draft: no dialog
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(1);
  expect(await orders(request, s)).toHaveLength(0);
});

test("bills are named Bill 1, 2, 3 with a type badge; a closed number is reused; the INV number appears only after billing", async ({ page, request }) => {
  const s = await seedMulti(request);
  await open(page, s);
  await expect(page.getByRole("heading", { name: "Bill 1" })).toBeVisible();
  await expect(page.getByTestId("ticket-badge")).toHaveText("Takeaway");
  await expect(page.getByText(/INV[-/]/)).toHaveCount(0); // no legal invoice number before billing
  await openAnother(page);
  await openAnother(page);
  await expect(tabs(page)).toHaveCount(3);
  await expect(tab(page, /^Bill 1, Takeaway,/)).toBeVisible();
  await expect(tab(page, /^Bill 2, Takeaway,/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bill 3" })).toBeVisible();

  await setDineIn(page, "T3"); // Bill 3 becomes dine-in on T3: the name stays, the badge changes
  await expect(page.getByRole("heading", { name: "Bill 3" })).toBeVisible();
  await expect(page.getByTestId("ticket-badge")).toHaveText("Table T3 · Indoor");
  await expect(tab(page, /^Bill 3, Table T3 · Indoor,/)).toBeVisible();

  await page.getByRole("button", { name: "Close Bill 2" }).click(); // empty draft: closes silently
  await expect(tabs(page)).toHaveCount(2);
  await openAnother(page);
  await expect(tab(page, /^Bill 2, Takeaway,/)).toBeVisible(); // the lowest free number comes back
  await expect(tabs(page)).toHaveCount(3);
  await expect.poll(() => storedDrafts(page)).toBe(3); // persistence is asynchronous: wait before reloading
  await expect(tab(page, /^Bill 3, Table T3 · Indoor,/)).toBeVisible();
  await page.reload();
  await expect(tabs(page)).toHaveCount(3); // numbers are stable across a reload
  await expect(tab(page, /^Bill 1,/)).toBeVisible();
  await expect(tab(page, /^Bill 2,/)).toBeVisible();
  await expect(tab(page, /^Bill 3, Table T3 · Indoor,/)).toBeVisible();

  await tab(page, /^Bill 1,/).click();
  await addDish(page, "Latte");
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: "Make bill" }).click();
  await expect(page.getByText(/INV[-/]\d{4}[-/]\d+/).first()).toBeVisible(); // now it has a legal invoice number
  await expect(page.getByTitle(/Tax invoice number/)).toContainText(/^Bill no. INV[-/]/);
  await expect(page.getByRole("heading", { name: "Bill 1" })).toBeVisible(); // ...and keeps its bill name
});
