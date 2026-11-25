import { expect, test, type APIRequestContext } from "@playwright/test";
import { payCash, API, billsFull, openMenuPos, seedMenu, type MenuSeed } from "./helpers";

// Adding items to an order that was already placed / sent to the kitchen ("the customer orders more later"):
// the new items collect under "New items (not sent yet)", "Add to order" puts them on the server order, and the next
// KOT carries only them. Like printing.spec.ts, the spec plays the print hub itself to read the kitchen slips.

interface Kot { id: string; number: number; order_id: string; payload: { item: string; qty: number }[] }
interface HubJob { id: string; payload_b64: string }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const slip = (j: HubJob) => Buffer.from(j.payload_b64, "base64").toString("latin1");

const kots = async (request: APIRequestContext, s: MenuSeed) =>
  ((await (await request.get(`${API}/kot`, { headers: s.auth })).json()) as Kot[]).sort((a, b) => a.number - b.number);
const orders = async (request: APIRequestContext, s: MenuSeed) =>
  (await (await request.get(`${API}/orders`, { headers: s.auth })).json()) as { id: string; status: string; subtotal: string; lines: { item_name: string; quantity: number }[] }[];
const shape = (k: Kot) => k.payload.map((l) => `${l.qty} ${l.item}`);

/** A kitchen printer on automatic plus a paired hub (this spec) that reads the jobs. */
async function kitchenWithHub(request: APIRequestContext, s: MenuSeed) {
  const p = await request.post(`${API}/print/printers`, { headers: s.auth, data: { name: "Kitchen", connection: "lan", host: "192.168.1.50", role: "kitchen", auto_kot: true } });
  expect(p.status()).toBe(201);
  const code = (await (await request.post(`${API}/print/hubs/pairing`, { headers: s.auth })).json()).code as string;
  const pair = await request.post(`${API}/print/hub/pair`, { data: { code, name: "Counter PC", os: "linux", version: "1.0.0" } });
  expect(pair.status()).toBe(200);
  const token = (await pair.json()).token as string;
  expect((await request.post(`${API}/print/hub/heartbeat`, { headers: bearer(token), data: { version: "1.0.0", os: "linux", system_printers: [], printer_status: {} } })).status()).toBe(200);
  return token;
}
async function hubPull(request: APIRequestContext, token: string): Promise<HubJob> {
  for (let i = 0; i < 8; i++) {
    const jobs = (await (await request.get(`${API}/print/hub/jobs?wait=2`, { headers: bearer(token) })).json()).jobs as HubJob[];
    if (jobs.length) {
      expect(jobs).toHaveLength(1);
      expect((await request.post(`${API}/print/hub/jobs/${jobs[0].id}/result`, { headers: bearer(token), data: { ok: true } })).status()).toBe(204);
      return jobs[0];
    }
  }
  throw new Error("the hub got no print job");
}

test("add Garlic Naan after the KOT: second KOT has only the new item, the bill has everything", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await openMenuPos(page, s);
  await page.getByRole("button", { name: /^Lamb Karahi,/ }).click();
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: /Send to kitchen/ }).click();
  await expect(page.getByRole("button", { name: /Kitchen ticket #1 sent/ })).toBeVisible();

  // The menu still takes items; they wait in their own section and block the bill until they are on the order.
  await page.getByRole("button", { name: /^Garlic Naan,/ }).click();
  await expect(page.getByTestId("more-items")).toContainText("New items (not sent yet)");
  await expect(page.getByTestId("more-items")).toContainText("Garlic Naan");
  await expect(page.getByRole("button", { name: "Make bill" })).toBeDisabled();
  await expect(page.getByText("Add the new items to the order first")).toBeVisible();
  expect((await orders(request, s))[0].lines).toHaveLength(1); // nothing on the server yet

  await page.getByRole("button", { name: "Add to order", exact: true }).click();
  await expect(page.getByTestId("more-items")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Make bill" })).toBeEnabled();
  expect((await orders(request, s))[0].lines.map((l) => l.item_name)).toEqual(["Lamb Karahi", "Garlic Naan"]);

  await page.getByRole("button", { name: "Send new items to kitchen" }).click();
  await expect(page.getByRole("button", { name: /Kitchen ticket #2 sent/ })).toBeVisible();
  const k = await kots(request, s);
  expect(k.map(shape)).toEqual([["1 Lamb Karahi"], ["1 Garlic Naan"]]);
  expect(k[1].number).toBe(k[0].number + 1);

  await page.getByRole("button", { name: "Make bill" }).click();
  await payCash(page);
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible();
  const [b] = await billsFull(request, s);
  expect(b.total).toBe("11.50"); // 8.50 + 3.00, GST included in the prices
  expect(Number(b.balance_due)).toBe(0);
  const full = await (await request.get(`${API}/bills/${b.id}`, { headers: s.auth })).json();
  expect(full.lines.map((l: { description: string }) => l.description)).toEqual(["Lamb Karahi", "Garlic Naan"]);
});

test("offline: the added items and their KOT are queued and sync once", async ({ page, context, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await openMenuPos(page, s, { sw: true });
  await page.getByRole("button", { name: /^Lamb Karahi,/ }).click();
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: /Send to kitchen/ }).click();
  await expect(page.getByRole("button", { name: /Kitchen ticket #1 sent/ })).toBeVisible();

  await context.setOffline(true);
  await expect(page.getByTestId("conn")).toHaveText("Offline");
  await page.getByRole("button", { name: /^Garlic Naan,/ }).click();
  await page.getByRole("button", { name: "Add to order (offline)" }).click();
  await expect(page.getByTestId("more-items")).toHaveCount(0);
  await page.getByRole("button", { name: "Send new items to kitchen (offline)" }).click();
  await expect(page.getByRole("button", { name: /Waiting for internet/ })).toBeVisible();
  await expect(page.getByTestId("pending-count")).toHaveText("2 pending");
  expect((await orders(request, s))[0].lines).toHaveLength(1); // still only on this device

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("pending-count")).toHaveCount(0, { timeout: 30_000 });
  expect((await orders(request, s))[0].lines.map((l) => l.item_name)).toEqual(["Lamb Karahi", "Garlic Naan"]);
  expect((await kots(request, s)).map(shape)).toEqual([["1 Lamb Karahi"], ["1 Garlic Naan"]]);
});

test("a lost response never adds the items twice", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await openMenuPos(page, s);
  await page.getByRole("button", { name: /^Lamb Karahi,/ }).click();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("button", { name: "Make bill" })).toBeVisible();

  // The request reaches the server, the browser never sees the answer: the add falls back to the queue under the same batch id.
  await page.route("**/api/v1/orders/*/lines", async (route) => {
    await route.fetch();
    await route.abort("connectionreset");
  });
  await page.getByRole("button", { name: /^Garlic Naan,/ }).click();
  await page.getByRole("button", { name: "Add to order", exact: true }).click();
  await expect(page.getByTestId("more-items")).toHaveCount(0);
  await page.unroute("**/api/v1/orders/*/lines");
  await expect(page.getByTestId("pending-count")).toHaveCount(0, { timeout: 30_000 }); // the queued add_lines synced
  const [o] = await orders(request, s);
  expect(o.lines.map((l) => `${l.quantity} ${l.item_name}`)).toEqual(["1 Lamb Karahi", "1 Garlic Naan"]);
  expect(o.subtotal).toBe("11.50");
});

test("kitchen printer on automatic: the add-on slip has only the new item and the ADD-ON marker", async ({ page, request }) => {
  test.setTimeout(120_000);
  const s = await seedMenu(request, { serviceCharge: null });
  const hub = await kitchenWithHub(request, s);
  await openMenuPos(page, s);
  await page.getByRole("button", { name: /^Lamb Karahi,/ }).click();
  await page.getByRole("button", { name: "Place order" }).click(); // automatic: the first KOT goes out by itself
  await expect(page.getByRole("button", { name: /Kitchen ticket #1 sent/ })).toBeVisible();
  const first = slip(await hubPull(request, hub));
  expect(first).toContain("LAMB KARAHI");
  expect(first).not.toContain("ADD-ON");

  await page.getByRole("button", { name: /^Garlic Naan,/ }).click();
  await page.getByRole("button", { name: "Add to order", exact: true }).click(); // ... and so does the add-on KOT
  await expect(page.getByRole("button", { name: /Kitchen ticket #2 sent/ })).toBeVisible();
  const second = slip(await hubPull(request, hub));
  expect(second).toContain("GARLIC NAAN");
  expect(second).toContain("ADD-ON TO EARLIER ORDER");
  expect(second).not.toContain("LAMB KARAHI");
  expect((await kots(request, s)).map(shape)).toEqual([["1 Lamb Karahi"], ["1 Garlic Naan"]]);
});

test("a billed ticket stays locked", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await openMenuPos(page, s);
  await page.getByRole("button", { name: /^Lamb Karahi,/ }).click();
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: "Make bill" }).click();
  await expect(page.getByRole("button", { name: "Pay cash" })).toBeVisible();
  await expect(page.getByText(/is billed. To add more, start another order/)).toBeVisible();
  await page.getByRole("button", { name: /^Garlic Naan,/ }).click({ force: true });
  await expect(page.getByTestId("more-items")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add to order", exact: true })).toHaveCount(0);
  expect((await orders(request, s))[0].lines).toHaveLength(1);
  // and the server refuses too
  const o = (await orders(request, s))[0];
  const r = await request.post(`${API}/orders/${o.id}/lines`, { headers: s.auth, data: { batch_uuid: "0b2f3f3e-1c1a-4c55-9d38-1f1f5d6c7a10", lines: [{ item_id: s.items["Garlic Naan"].id, quantity: 1 }] } });
  expect(r.status()).toBe(409);
});
