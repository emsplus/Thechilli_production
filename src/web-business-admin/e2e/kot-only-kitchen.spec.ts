import { expect, test, type APIRequestContext } from "@playwright/test";
import { API, openAs, openPos, payCash, seed, setKitchenMode, type Seed } from "./helpers";

// KOT-only kitchen (pos-service docs/KOT_ONLY_KITCHEN.md): owner request "khichin me KOT chali gai to waha bas status na rahe
// prepare / ready / serve, only KOT jaaye bas". Default for every restaurant: the kitchen just gets the ticket and taps Done.
// "Track Preparing / Ready / Served" (Manage > Restaurant > Kitchen status tracking) brings the old workflow back.

interface KotRow { id: string; number: number; status: string; done_at: string | null; payload: { item: string; note: string | null }[] }
const kots = async (request: APIRequestContext, s: Seed) => (await (await request.get(`${API}/kot`, { headers: s.auth })).json()) as KotRow[];

async function setKitchenDisplayMinutes(request: APIRequestContext, auth: Record<string, string>, minutes: number) {
  const rest = await (await request.get(`${API}/restaurant`, { headers: auth })).json();
  const put = await request.put(`${API}/restaurant`, { headers: auth, data: { name: rest.name, trn: rest.trn, address: rest.address, kitchen_display_minutes: minutes } });
  expect(put.status(), await put.text()).toBe(200);
}

async function sentOrder(request: APIRequestContext, s: Seed, note: string | null = null, type: "takeaway" | "indoor" = "takeaway") {
  const o = await (await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: type, ...(type === "indoor" ? { table_id: s.tableId } : {}),
    lines: [{ item_id: s.itemId, quantity: 2, note }] } })).json();
  const k = await request.post(`${API}/orders/${o.id}/kot`, { headers: s.auth });
  expect(k.status(), await k.text()).toBe(201);
  return { order: o as { id: string }, kot: (await k.json()) as KotRow };
}

test("default is KOT only: Manage > Restaurant offers the two options with KOT only selected", async ({ page, request }) => {
  const s = await seed(request);
  expect((await (await request.get(`${API}/restaurant`, { headers: s.auth })).json()).kitchen_status_mode).toBe("kot_only");
  await openAs(page, s.token, "/manage?tab=restaurant", s.refresh);
  const group = page.getByRole("radiogroup", { name: "Kitchen status tracking" });
  await expect(group.getByRole("radio", { name: /KOT only \(default\)/ })).toBeChecked();
  await expect(group.getByRole("radio", { name: /Track Preparing \/ Ready \/ Served/ })).not.toBeChecked();
  await expect(group.getByText(/just receives the ticket/)).toBeVisible();
  await expect(page.getByTestId("kitchen-display-minutes")).toHaveValue("20");
});

test("KOT only: send KOT from the counter -> it just appears on Kitchen (nothing to click) -> billing works right away", async ({ page, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: /Send to kitchen/ }).click();
  await expect(page.getByRole("button", { name: /Kitchen ticket #1 sent/ })).toBeVisible();
  // billing is allowed right after the KOT: nothing is waiting for preparing / ready / served / a click in the kitchen
  await page.getByRole("button", { name: "Make bill" }).click();
  await expect(page.getByText(/INV[-/]\d{4}[-/]000001/).first()).toBeVisible();
  await payCash(page);
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible();

  await page.goto("/kitchen");
  const ticket = page.getByTestId("kot-ticket");
  await expect(page.getByTestId("kitchen-board")).toHaveAttribute("data-kitchen-mode", "kot_only");
  // The bill was made: the ticket has left the live board (tickets leave it when the bill is generated); it waits under "Earlier tickets", reprint stays.
  await expect(ticket).toHaveCount(0);
  await expectNoWorkflow(page);
  await page.getByRole("button", { name: /^Earlier tickets \(1\)/ }).click();
  const earlier = page.getByTestId("earlier-ticket");
  await expect(earlier).toHaveCount(1);
  await expect(earlier).toContainText("#1");
  await expect(earlier).toContainText("Latte");
  await expect(earlier.getByRole("button", { name: /Print KOT slip #1/ })).toBeVisible();
});

/** KOT only: no columns, no step buttons, no Served list, no late chip. */
async function expectNoWorkflow(page: import("@playwright/test").Page) {
  await expect(page.getByRole("button", { name: /Start preparing|Mark ready|Mark served|^Done$/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^(Pending|Preparing|Ready)/ })).toHaveCount(0);
  await expect(page.getByText(/^Served/)).toHaveCount(0);
  await expect(page.getByText(/Waiting|Getting late|Late$/)).toHaveCount(0);
}

test("KOT only, zero clicks: 3 tickets arrive (newest first, big cards, notes), the screen never asks for a click, they clear by themselves after the configured minutes", async ({ page, request }) => {
  const s = await seed(request);
  await setKitchenDisplayMinutes(request, s.auth, 5);
  const a = await sentOrder(request, s, "butter kam");
  const b = await sentOrder(request, s, null, "indoor");
  const c = await sentOrder(request, s, "extra spicy");
  await page.clock.install({ time: Date.now() });   // fake timers: the 5-minute window passes without waiting
  await openAs(page, s.token, "/kitchen", s.refresh);
  const tickets = page.getByTestId("kot-ticket");
  await expect(tickets).toHaveCount(3);
  await expect(tickets.nth(0)).toContainText(`#${c.kot.number}`);   // newest first
  await expect(tickets.nth(1)).toContainText(`#${b.kot.number}`);
  await expect(tickets.nth(2)).toContainText(`#${a.kot.number}`);
  await expect(tickets.nth(2)).toContainText("butter kam");
  await expect(tickets.nth(1)).toContainText("T1");
  await expect(tickets.nth(0)).toContainText("2×");
  await expectNoWorkflow(page);
  await expect(page.getByRole("button", { name: "Sound on" })).toHaveAttribute("aria-pressed", "true"); // the beep is ON by default
  await page.clock.fastForward("04:00");
  await expect(tickets).toHaveCount(3);                              // inside the window: still shown, still no warning
  await expectNoWorkflow(page);
  await page.clock.fastForward("02:00");                             // 6 minutes: past the 5-minute setting
  await expect(tickets).toHaveCount(0);
  await expect(page.getByText("No tickets yet.")).toBeVisible();
  const earlier = page.getByRole("button", { name: /^Earlier tickets \(3\)/ });
  await expect(earlier).toBeVisible();
  await earlier.click();
  await expect(page.getByTestId("earlier-ticket")).toHaveCount(3);
  await expect(page.getByTestId("earlier-ticket").first()).toContainText(`#${c.kot.number}`);
  await expect(page.getByTestId("earlier-ticket").nth(2)).toContainText("butter kam");
  // nothing was changed on the server by the clearing: every ticket is still open for the reports
  expect((await kots(request, s)).every((k) => k.done_at === null && k.status === "pending")).toBe(true);
});

test("KOT only: the default window is 20 minutes (a ticket is still there at 19 min, gone at 21)", async ({ page, request }) => {
  const s = await seed(request);
  await sentOrder(request, s, "less oil");
  await page.clock.install({ time: Date.now() });
  await openAs(page, s.token, "/kitchen", s.refresh);
  await expect(page.getByTestId("kot-ticket")).toHaveCount(1);
  await page.clock.fastForward("19:00");
  await expect(page.getByTestId("kot-ticket")).toHaveCount(1);
  await page.clock.fastForward("02:00");
  await expect(page.getByTestId("kot-ticket")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Earlier tickets \(1\)/ })).toBeVisible();
});

test("KOT only: Orders and the table show 'In kitchen' once sent, nothing more; the API refuses preparing / ready / served", async ({ page, request }) => {
  const s = await seed(request);
  const a = await sentOrder(request, s, null, "indoor");
  for (const st of ["preparing", "ready", "served"]) {
    const r = await request.patch(`${API}/kot/${a.kot.id}`, { headers: s.auth, data: { status: st } });
    expect(r.status()).toBe(409);
    expect((await r.json()).error.code).toBe("kitchen_status_off");
  }
  await openAs(page, s.token, "/orders", s.refresh);
  await expect(page.getByText("In kitchen").first()).toBeVisible();
  await expect(page.getByText(/Preparing|Ready|Served/)).toHaveCount(0);
});

test("Track mode (the old workflow) is still there: switch in Manage > Restaurant, the Kitchen shows the three columns and the steps; switch back", async ({ page, request }) => {
  const s = await seed(request);
  await sentOrder(request, s, "less spicy");
  await openAs(page, s.token, "/manage?tab=restaurant", s.refresh);
  const group = page.getByRole("radiogroup", { name: "Kitchen status tracking" });
  await group.getByRole("radio", { name: /Track Preparing \/ Ready \/ Served/ }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Kitchen status tracking saved")).toBeVisible();
  expect((await (await request.get(`${API}/restaurant`, { headers: s.auth })).json()).kitchen_status_mode).toBe("track");
  expect((await (await request.get(`${API}/auth/me`, { headers: s.auth })).json()).order_rules.kitchen_status_mode).toBe("track");

  await page.goto("/kitchen");
  await expect(page.getByTestId("kitchen-board")).toHaveAttribute("data-kitchen-mode", "track");
  for (const name of [/^Pending/, /^Preparing/, /^Ready/]) await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
  await expect(page.getByTestId("kot-ticket")).toContainText("less spicy");
  await page.getByRole("button", { name: "Start preparing" }).click();
  await expect(page.getByRole("button", { name: "Mark ready" })).toBeVisible();
  await page.getByRole("button", { name: "Mark ready" }).click();
  await expect(page.getByRole("button", { name: "Mark served" })).toBeVisible();
  await page.getByRole("button", { name: "Mark served" }).click();
  await expect(page.getByRole("button", { name: /^Served \(1\)/ })).toBeVisible();

  // Orders still says "In kitchen" for the order; the old chips live on the kitchen board and the counter strip
  await setKitchenMode(request, s.auth, "kot_only");
  await sentOrder(request, s, "extra onion");
  await page.goto("/kitchen");
  await expect(page.getByTestId("kitchen-board")).toHaveAttribute("data-kitchen-mode", "kot_only");
  await expect(page.getByTestId("kot-ticket")).toHaveCount(1);          // the served one is history; only the open ticket shows
  await expect(page.getByTestId("kot-ticket")).toContainText("extra onion");
});

test("Switching to KOT only keeps tickets that were Preparing / Ready on screen (they clear by age like the rest)", async ({ page, request }) => {
  const s = await seed(request);
  await setKitchenMode(request, s.auth, "track");
  const a = await sentOrder(request, s);
  const b = await sentOrder(request, s);
  expect((await request.patch(`${API}/kot/${a.kot.id}`, { headers: s.auth, data: { status: "preparing" } })).ok()).toBeTruthy();
  expect((await request.patch(`${API}/kot/${b.kot.id}`, { headers: s.auth, data: { status: "ready" } })).ok()).toBeTruthy();
  await setKitchenMode(request, s.auth, "kot_only");
  await openAs(page, s.token, "/kitchen", s.refresh);
  const tickets = page.getByTestId("kot-ticket");
  await expect(tickets).toHaveCount(2);   // they simply show, newest first, like any other ticket; no click needed
  await expectNoWorkflow(page);
});

test("KOT only: the screen carries what the printed slip carries (token, order note, items with notes, add-on KOT of the same order)", async ({ page, request }) => {
  const s = await seed(request);
  const o = await (await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "takeaway", note: "Guest allergic to nuts",
    lines: [{ item_id: s.itemId, quantity: 1, note: "butter kam" }] } })).json();
  expect((await request.post(`${API}/orders/${o.id}/kot`, { headers: s.auth })).status()).toBe(201);
  const more = await request.post(`${API}/orders/${o.id}/lines`, { headers: s.auth, data: { batch_uuid: crypto.randomUUID(), lines: [{ item_id: s.itemId, quantity: 3 }] } });
  expect(more.ok(), await more.text()).toBeTruthy();
  expect((await request.post(`${API}/orders/${o.id}/kot`, { headers: s.auth })).status()).toBe(201);
  await openAs(page, s.token, "/kitchen", s.refresh);
  const tickets = page.getByTestId("kot-ticket");
  await expect(tickets).toHaveCount(2);
  await expect(tickets.nth(0)).toContainText("Add-on to earlier order");   // newest first: the add-on KOT
  await expect(tickets.nth(0)).toContainText("3×");
  await expect(tickets.nth(1)).not.toContainText("Add-on");
  await expect(tickets.nth(1)).toContainText("butter kam");
  await expect(tickets.nth(1).getByTestId("ticket-order-note")).toContainText("Guest allergic to nuts");
  await expect(tickets.nth(1).getByTestId("ticket-meta")).toContainText(/Token \d+/);
});
