import { expect, test, type APIRequestContext } from "@playwright/test";
import { API, openAs, seedIn, type Seed } from "./helpers";

/**
 * Owner bugs (docs/testing/WAITER_BOOKING_BELL_REPORT.md), end to end against a real pos-service. The waiter app is driven through
 * the exact API calls it makes (POST /sync/operations: create_order + send_kot when a table is "booked" and sent, request_bill on
 * "Request bill"); the business app is the browser.
 *  A. a table taken in the waiter app shows on Reservations ("Tables in use now"), the Tables floor (with the waiter's name) and
 *     Orders, without a reload;
 *  B. a waiter's bill request rings the bell (badge + list + toast, no reload), highlights the order card, opens straight at the
 *     counter and is then read.
 */
interface Staff { token: string; refresh: string; auth: Record<string, string> }

async function staff(request: APIRequestContext, s: Seed, role: "waiter" | "cashier", name: string): Promise<Staff> {
  const email = `${role}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.in`;
  const u = await request.post(`${API}/auth/users`, { headers: s.auth, data: { email, full_name: name, password: "supersecret123", role } });
  expect(u.status(), await u.text()).toBe(201);
  const l = await request.post(`${API}/auth/login`, { data: { email, password: "supersecret123" } });
  expect(l.status(), await l.text()).toBe(200);
  const p = await l.json();
  return { token: p.access_token, refresh: p.refresh_token, auth: { Authorization: `Bearer ${p.access_token}` } };
}

const op = (type: string, body: Record<string, unknown>) => ({ op_id: crypto.randomUUID(), device_id: "waiter-phone-1", client_created_at: new Date().toISOString(), op: { type, ...body } });
async function syncOps(request: APIRequestContext, w: Staff, ops: unknown[]) {
  const r = await request.post(`${API}/sync/operations`, { headers: w.auth, data: { operations: ops } });
  expect(r.status(), await r.text()).toBe(200);
  const res = (await r.json()).results as { status: string; data: Record<string, unknown> }[];
  expect(res.map((x) => x.status)).toEqual(ops.map(() => "synced"));
  return res;
}
/** Waiter app: tap a free table, add dishes, Send (to the kitchen). Returns the order's client_uuid and server id. */
async function waiterBooks(request: APIRequestContext, w: Staff, tableId: string, itemId: string) {
  const cu = crypto.randomUUID();
  const res = await syncOps(request, w, [op("create_order", { order: { client_uuid: cu, order_type: "indoor", table_id: tableId, lines: [{ item_id: itemId, quantity: 2 }] } }), op("send_kot", { order_client_uuid: cu })]);
  return { cu, id: res[0].data.order_id as string };
}
const mkTable = async (request: APIRequestContext, s: Seed, label: string) => {
  const r = await request.post(`${API}/tables`, { headers: s.auth, data: { label, seats: 4, area: "indoor" } });
  expect(r.status()).toBe(201);
  return (await r.json()).id as string;
};

test("A: a table booked in the waiter app shows on Reservations, the Tables floor and Orders without a reload", async ({ page, request }) => {
  const s = await seedIn(request);
  const t2 = await mkTable(request, s, "T2");
  const ravi = await staff(request, s, "waiter", "Ravi");
  await waiterBooks(request, ravi, s.tableId, s.itemId);

  await openAs(page, s.token, "/reservations", s.refresh);
  const inUse = page.getByTestId("tables-in-use");
  await expect(inUse).toContainText("Tables in use now");
  await expect(inUse.getByTestId("table-in-use-row").filter({ hasText: "Table T1" })).toContainText("Taken by Ravi");
  await expect(inUse.getByTestId("table-in-use-row").filter({ hasText: "Table T1" })).toContainText("Order open");
  // a second table taken while the page is open: it appears by itself (10 s refresh), no reload
  await waiterBooks(request, ravi, t2, s.itemId);
  await expect(inUse.getByTestId("table-in-use-row").filter({ hasText: "Table T2" })).toBeVisible({ timeout: 15_000 });

  await page.goto("/manage?tab=tables");
  await expect(page.getByRole("button", { name: /^Table T1,/ })).toHaveAccessibleName(/With kitchen.*Taken by Ravi/);
  await expect(page.getByRole("button", { name: /^Table T1,/ }).getByTestId("table-extra")).toHaveText("Taken by Ravi");

  await page.goto("/orders");
  await expect(page.getByTestId("order-card").filter({ hasText: "Table T1" })).toBeVisible();
  await expect(page.getByTestId("order-card").filter({ hasText: "Table T2" })).toBeVisible();
  await expect(page.getByText(/\bPOS\b/)).toHaveCount(0);
});

test("B: a waiter's bill request rings the cashier's bell, highlights the order and opens at the counter, then is read", async ({ page, request }) => {
  const s = await seedIn(request);
  const ravi = await staff(request, s, "waiter", "Ravi");
  const cash = await staff(request, s, "cashier", "Meena");
  const o = await waiterBooks(request, ravi, s.tableId, s.itemId);
  let sounds = 0;
  await page.exposeFunction("__sound", () => { sounds++; });
  await page.addInitScript(() => { const orig = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function (...a) { (window as unknown as { __sound: () => void }).__sound(); return orig.apply(this, a); }; });

  await openAs(page, cash.token, "/orders", cash.refresh);
  const bell = page.getByTestId("notification-bell");
  await expect(bell).toHaveAccessibleName("Notifications");
  await expect(page.getByTestId("order-card").filter({ hasText: "Table T1" })).toBeVisible();

  // Waiter app: "Request bill" (sent to the cashier)
  await syncOps(request, ravi, [op("request_bill", { order_client_uuid: o.cu })]);
  await expect(bell).toHaveAccessibleName("Notifications, 1 new", { timeout: 15_000 });
  await expect(page.getByTestId("notification-count")).toHaveText("1");
  await expect(page.getByText("Table T1 asks for the bill").first()).toBeVisible(); // toast
  const card = page.getByTestId("order-card").filter({ hasText: "Table T1" });
  await expect(card).toHaveAttribute("data-bill-asked", "true", { timeout: 15_000 });
  await expect(card.getByTestId("bill-asked-badge")).toHaveText("Bill asked · new");
  await expect(card.getByTestId("bill-asked-line")).toContainText("Ravi asked for the bill");

  // the notification centre lists it; opening it goes to the counter with that order and marks it read
  await bell.click();
  const centre = page.getByRole("dialog", { name: "Notifications" });
  const item = centre.getByRole("button", { name: /Table T1 asks for the bill/ });
  await expect(item).toHaveAttribute("data-unread", "true");
  await expect(item).toContainText("Ravi · 2 items");
  await item.click();
  await expect(page).toHaveURL(/\/pos$/);
  await expect(page.getByText("Table T1 is open")).toBeVisible();
  await expect(bell).toHaveAccessibleName("Notifications");
  await expect(page.getByTestId("notification-count")).toHaveCount(0);
  // still listed (not billed yet) but read
  await bell.click();
  await expect(page.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: /Table T1 asks for the bill/ })).toHaveAttribute("data-unread", "false");
  await page.keyboard.press("Escape");

  // the cashier makes the bill: the request leaves the list
  const made = await request.post(`${API}/orders/${o.id}/bill`, { headers: cash.auth });
  expect(made.status(), await made.text()).toBe(201);
  await bell.click();
  await expect(page.getByRole("dialog", { name: "Notifications" })).toContainText("No waiter is waiting for a bill.", { timeout: 15_000 });
  expect(sounds).toBe(0); // no sound by default
});

test("B: read state survives a reload; Mark all read; a waiter signed in to the business app gets no bill feed", async ({ page, request }) => {
  const s = await seedIn(request);
  const t2 = await mkTable(request, s, "T2");
  const ravi = await staff(request, s, "waiter", "Ravi");
  const a = await waiterBooks(request, ravi, s.tableId, s.itemId);
  const b = await waiterBooks(request, ravi, t2, s.itemId);
  await syncOps(request, ravi, [op("request_bill", { order_client_uuid: a.cu }), op("request_bill", { order_client_uuid: b.cu })]);

  await openAs(page, s.token, "/manage?tab=tables", s.refresh);
  const bell = page.getByTestId("notification-bell");
  await expect(bell).toHaveAccessibleName("Notifications, 2 new");
  await expect(page.getByRole("button", { name: /^Table T1,/ })).toHaveAttribute("data-bill-asked", "true");
  await expect(page.getByRole("button", { name: /^Table T1,/ }).getByTestId("table-extra")).toHaveText("Taken by Ravi · Bill asked");
  // the Orders card link (?highlight=) marks one read
  await page.goto(`/orders?highlight=${a.id}`);
  await expect(bell).toHaveAccessibleName("Notifications, 1 new");
  await page.reload();
  await expect(bell).toHaveAccessibleName("Notifications, 1 new");
  await bell.click();
  await page.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: "Mark all read" }).click();
  await expect(page.getByRole("dialog", { name: "Notifications" }).getByRole("button", { name: /asks for the bill/ }).first()).toHaveAttribute("data-unread", "false");
  await page.keyboard.press("Escape");
  await expect(bell).toHaveAccessibleName("Notifications");

  await openAs(page, ravi.token, "/orders", ravi.refresh);
  await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible();
  await page.getByTestId("notification-bell").click();
  const centre = page.getByRole("dialog", { name: "Notifications" });
  await expect(centre.getByText("Low stock")).toBeVisible();
  await expect(centre.getByText("Bill requests")).toHaveCount(0);
});
