import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, fakeSpeech, openAs, say, seedIn, type Seed } from "./helpers";

// The "child test" of docs/ORDER_FLOW_AUDIT.md section 3: ten tasks a first-time user must finish with ZERO hints, on a
// tablet (1024 x 768, where T1-T4 used to be hidden off to the side). Each task asserts the visible outcome and, where the
// audit measured it, the tap count against the original Karahi counter (it must never be higher).
// Plus the P0 rules: kitchen first, one order per table (a choice, not a silent second order), Half by default,
// a print failure is never shown as success.

test.use({ viewport: { width: 1024, height: 768 } });

interface Menu { chai: string; bc: string; naan: string; dal: string; cb: string; mb: string; tables: Record<string, string> }
type OrderRow = { id: string; status: string; table_id: string | null; lines: { item_name: string; quantity: number; note: string | null; variant_id?: string | null }[] };

async function seedMenu(request: APIRequestContext): Promise<Seed & Menu> {
  const s = await seedIn(request);
  const h = { headers: s.auth };
  const cat = async (name: string) => (await (await request.post(`${API}/menu/categories`, { ...h, data: { name } })).json()).id as string;
  const item = async (category_id: string, name: string, price: string, variants: { name: string; price_delta: string }[] = []) =>
    (await (await request.post(`${API}/menu/items`, { ...h, data: { category_id, name, price, variants } })).json()) as { id: string; variants: { id: string; name: string }[] };
  const drinks = await cat("Drinks"), breads = await cat("Breads"), rice = await cat("Rice");
  const chai = await item(drinks, "Masala Chai", "40.00");
  const bc = await item(s.catId, "Butter Chicken", "280.00", [{ name: "Half", price_delta: "0.00" }, { name: "Full", price_delta: "180.00" }]);
  const naan = await item(breads, "Garlic Naan", "60.00");
  const dal = await item(s.catId, "Dal Makhani", "220.00");
  const cb = await item(rice, "Chicken Biryani", "260.00");
  const mb = await item(rice, "Mutton Biryani", "320.00");
  const tables: Record<string, string> = { T1: s.tableId };
  // Ten tables like the audited restaurant: AC hall and garden first in creation order, T1-T4 last.
  for (const [label, area] of [["AC1", "indoor"], ["AC2", "indoor"], ["AC3", "indoor"], ["G1", "outdoor"], ["G2", "outdoor"], ["T2", "indoor"], ["T3", "indoor"], ["T4", "indoor"], ["T5", "indoor"]] as const)
    tables[label] = (await (await request.post(`${API}/tables`, { ...h, data: { label, area, seats: 4 } })).json()).id;
  return { ...s, chai: chai.id, bc: bc.id, naan: naan.id, dal: dal.id, cb: cb.id, mb: mb.id, tables };
}

const orders = async (request: APIRequestContext, s: Seed) => (await (await request.get(`${API}/orders`, { headers: s.auth })).json()) as OrderRow[];
const kots = async (request: APIRequestContext, s: Seed) => (await (await request.get(`${API}/kot`, { headers: s.auth })).json()) as { order_id: string; payload: { item: string; qty: number; note: string | null }[] }[];

/** Counts real taps (pointer clicks) on the page. */
async function tapCounter(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __taps: number; __tapsOn?: boolean };
    w.__taps = 0;
    if (!w.__tapsOn) { w.__tapsOn = true; document.addEventListener("click", (e) => { if (e.isTrusted) w.__taps++; }, true); }
  });
  return () => page.evaluate(() => (window as unknown as { __taps: number }).__taps);
}

const dish = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name},`) }).first();
const panel = (page: Page) => page.getByRole("complementary", { name: "Current order" });
const table = (page: Page, label: string) => panel(page).getByRole("group", { name: "Table" }).getByRole("button", { name: new RegExp(`^Table ${label}\\b`) });

async function open(page: Page, s: Seed) {
  await openAs(page, s.token, "/pos", s.refresh);
  await expect(dish(page, "Masala Chai")).toBeVisible();
}
async function newOrder(page: Page) {
  await page.getByRole("button", { name: /^New:/ }).click();
}

test("child test 1-5: takeaway chai to the kitchen; dine-in T3 with 3 dishes incl. Butter Chicken Half; naan 1 -> 2; remove a mistake", async ({ page, request }) => {
  const s = await seedMenu(request);
  await open(page, s);
  let taps = await tapCounter(page);

  // 1. Takeaway, 1 chai, to the kitchen: 3 taps like Karahi. After Place, the big red button is "Send to kitchen".
  await dish(page, "Masala Chai").click();
  await panel(page).getByRole("button", { name: /Place order/ }).click();
  const send = panel(page).getByRole("button", { name: /^Send to kitchen/ });
  await expect(send).toBeVisible();
  await expect(send).toHaveClass(/primary/);
  await send.click();
  await expect(panel(page).getByRole("button", { name: /Kitchen ticket #1 sent/ })).toBeVisible();
  expect(await taps(), "task 1: dish, Place, Send = Karahi's 3").toBe(3);
  expect((await kots(request, s))[0].payload).toEqual([expect.objectContaining({ item: "Masala Chai", qty: 1 })]);

  // 2 + 3. Dine-in for T3 with Butter Chicken (Half by default, one tap), Dal Makhani, Garlic Naan.
  await newOrder(page);
  taps = await tapCounter(page);
  await dish(page, "Butter Chicken").click(); // one tap: Half, no dialog (Karahi needed 2: dish + Half)
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await dish(page, "Dal Makhani").click();
  await dish(page, "Garlic Naan").click();
  await panel(page).getByRole("radio", { name: "Dine-in" }).click();
  // T3 is on screen without any sideways swipe (all ten tables wrap in a grid), with its state.
  await expect(table(page, "T3")).toBeInViewport();
  await expect(table(page, "T3")).toContainText("Free");
  await table(page, "T3").click();
  await expect(panel(page).getByTestId("table-chosen")).toContainText("T3");
  // A second tap on the chosen table never un-chooses it.
  await table(page, "T3").click();
  await expect(table(page, "T3")).toHaveAttribute("aria-pressed", "true");
  expect(await taps(), "3 dishes (Half in one tap) + Dine-in + T3 = 5, plus the deliberate second tap on T3; Karahi needs 6 without it").toBe(6);
  await expect(panel(page).getByText("Butter Chicken · Half")).toBeVisible();
  await expect(panel(page).getByRole("button", { name: /Change to Full/ })).toHaveAccessibleName("Change to Full (+₹180)");

  // 4. Naan 1 -> 2 from the cart line.
  await panel(page).getByRole("button", { name: "Increase Garlic Naan" }).click();
  await expect(panel(page).locator("[data-line]").filter({ hasText: "Garlic Naan" })).toContainText("× 2");

  // 5. Remove a dish added by mistake: one tap, with Undo.
  await dish(page, "Masala Chai").click();
  await panel(page).getByRole("button", { name: "Remove Masala Chai" }).click();
  await expect(page.getByText("Removed Masala Chai")).toBeVisible();
  await expect(panel(page).locator("[data-line]").filter({ hasText: "Masala Chai" })).toHaveCount(0);

  // All the lines are visible together in the order list at 1024 x 768 (C-05: no one-line list).
  await panel(page).getByRole("heading", { name: /Order items/ }).scrollIntoViewIfNeeded();
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/child-1024-lines.png` });
  for (const n of ["Butter Chicken · Half", "Dal Makhani", "Garlic Naan"]) await expect(panel(page).getByText(n, { exact: true })).toBeInViewport();

  // Kitchen first: after Place, Make bill waits for the kitchen ticket on a dine-in order.
  await panel(page).getByRole("button", { name: /Place order/ }).click();
  await expect(panel(page).getByRole("button", { name: "Make bill" })).toBeDisabled();
  await expect(panel(page).getByText("Send the order to the kitchen first")).toBeVisible();
  await panel(page).getByRole("button", { name: /^Send to kitchen/ }).click();
  await expect(panel(page).getByRole("button", { name: "Make bill" })).toBeEnabled();
  const ks = await kots(request, s);
  const ticket = ks.find((k) => k.payload.some((p) => p.item.includes("Butter Chicken")))!;
  expect(ticket.payload.map((p) => p.item).join(" | "), "the kitchen sees the size").toMatch(/Butter Chicken \(Half\)/);
  expect(ticket.payload.find((p) => p.item.includes("Naan"))!.qty).toBe(2);
});

test("child test 6-9: note 'no onion'; ₹500 cash for a smaller bill; hold and come back; fix the table after placing", async ({ page, request }) => {
  const s = await seedMenu(request);
  await open(page, s);

  // 6. "No onion" for one dish: Note -> quick chip -> Save; the kitchen gets it.
  await dish(page, "Dal Makhani").click();
  await panel(page).getByRole("button", { name: "Note for Dal Makhani" }).click();
  const note = page.getByRole("dialog", { name: "Note for Dal Makhani" });
  await note.getByRole("button", { name: "No onion" }).click();
  await note.getByRole("button", { name: "Save note" }).click();
  await expect(panel(page).getByText("“No onion”")).toBeVisible();
  await panel(page).getByRole("button", { name: /Place order/ }).click();
  await panel(page).getByRole("button", { name: /^Send to kitchen/ }).click();
  await expect(panel(page).getByRole("button", { name: /Kitchen ticket #1 sent/ })).toBeVisible();
  expect((await orders(request, s))[0].lines[0].note).toBe("No onion");
  expect((await kots(request, s))[0].payload[0].note).toBe("No onion");

  // 7. Take ₹500 cash and give change.
  await panel(page).getByRole("button", { name: "Make bill" }).click();
  await panel(page).getByRole("button", { name: "Other amount / split" }).click();
  const sheet = page.getByRole("dialog", { name: "Take payment" });
  for (const d of "500") await sheet.getByRole("group", { name: "Amount keypad" }).getByRole("button", { name: d, exact: true }).click();
  await expect(sheet.getByTestId("change-due")).toBeVisible();
  await sheet.getByRole("button", { name: /^Confirm payment/ }).click();
  await expect(panel(page).getByRole("button", { name: "New order" })).toBeVisible();

  // 8. Hold an order, take another, come back.
  await panel(page).getByRole("button", { name: "New order" }).click();
  await dish(page, "Garlic Naan").click();
  await panel(page).getByRole("button", { name: "Hold" }).click();
  await dish(page, "Masala Chai").click();
  await page.getByRole("tab", { selected: false }).first().click(); // the held order
  await expect(panel(page).getByText("Garlic Naan", { exact: true })).toBeVisible();

  // 9. Wrong table after Place order: Change table moves the order (no cancel and re-enter).
  await newOrder(page);
  await dish(page, "Masala Chai").click();
  await panel(page).getByRole("radio", { name: "Dine-in" }).click();
  await table(page, "T1").click();
  await panel(page).getByRole("button", { name: /Place order/ }).click();
  await expect(panel(page).getByRole("button", { name: /^Send to kitchen/ })).toBeVisible();
  await panel(page).getByRole("button", { name: "Change table" }).click();
  await table(page, "T2").click();
  await expect(page.getByText("Table changed")).toBeVisible();
  await expect.poll(async () => (await orders(request, s)).find((o) => o.lines.some((l) => l.item_name === "Masala Chai") && o.status === "open")?.table_id).toBe(s.tables.T2);
});

test("P0: a table with an order offers 'Add to this table's order' or 'Start a separate order' (never a silent second order)", async ({ page, request }) => {
  const s = await seedMenu(request);
  // T4 already has an order from another device (2 x Masala Chai).
  await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "indoor", table_id: s.tables.T4, lines: [{ item_id: s.chai, quantity: 2 }] } });
  await open(page, s);
  await dish(page, "Garlic Naan").click();
  await panel(page).getByRole("radio", { name: "Dine-in" }).click();
  await expect(table(page, "T4")).toContainText(/item/);
  await table(page, "T4").click();
  const ask = page.getByRole("dialog", { name: /Table T4 already has an order/ });
  await expect(ask.getByRole("button", { name: "Add to this table’s order" })).toBeVisible();
  await expect(ask.getByRole("button", { name: "Start a separate order" })).toBeVisible();
  await ask.getByRole("button", { name: "Add to this table’s order" }).click();
  // The table's order opens here with the naan as a new item; one tap adds it to that order.
  await expect(panel(page).getByTestId("more-items")).toContainText("Garlic Naan");
  await panel(page).getByRole("button", { name: "Add to order", exact: true }).click();
  await expect(page.getByText("Items added to the order")).toBeVisible();
  const onT4 = (await orders(request, s)).filter((o) => o.table_id === s.tables.T4 && o.status !== "cancelled");
  expect(onT4, "still one order on T4").toHaveLength(1);
  expect(onT4[0].lines.map((l) => l.item_name).sort()).toEqual(["Garlic Naan", "Masala Chai"]);
});

test("P0: a kitchen printer failure is shown as a failure, with Try again and a Needs reprint chip", async ({ page, request }) => {
  const s = await seedMenu(request);
  // The order-rules server reports the print result on the kitchen ticket; simulate a printer that did not respond.
  await page.route("**/api/v1/orders/*/kot", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, print: { status: "failed" } } });
  });
  await open(page, s);
  await dish(page, "Masala Chai").click();
  await panel(page).getByRole("button", { name: /Place order/ }).click();
  await panel(page).getByRole("button", { name: /^Send to kitchen/ }).click();
  await expect(page.getByText("Printer did not respond")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show on screen" })).toBeVisible();
  await expect(panel(page).getByTestId("needs-reprint")).toBeVisible();
  await expect(page.getByText(/sent to the kitchen/i)).toHaveCount(0);
});

test("P0: sizes: no Regular row, Half pre-selected with the Full price difference; Change to Full on the line", async ({ page, request }) => {
  const s = await seedMenu(request);
  await open(page, s);
  // Long-press (right-click) opens the dish's options: the size picker has Half selected and no "Regular".
  await dish(page, "Butter Chicken").click({ button: "right" });
  await page.getByRole("button", { name: "Choose size and options" }).click();
  const size = page.getByTestId("picker-size");
  await expect(size.getByRole("radio", { name: /Half/ })).toHaveAttribute("aria-checked", "true");
  await expect(size.getByRole("radio", { name: /Full/ })).toContainText("+₹180");
  await expect(page.getByRole("dialog").getByText("Regular")).toHaveCount(0);
  await page.getByTestId("picker-confirm").click();
  await panel(page).getByRole("button", { name: /Change to Full/ }).click();
  await expect(panel(page).getByText("Butter Chicken · Full")).toBeVisible();
  await expect(panel(page).getByRole("button", { name: /Change to Half/ })).toBeVisible();
});

test("search finds panir, biriyani, पनीर and tea; sold-out dishes cannot be added", async ({ page, request }) => {
  const s = await seedMenu(request);
  await open(page, s);
  const search = page.getByRole("searchbox", { name: "Search menu" });
  for (const [q, want] of [["panir", "Paneer Tikka"], ["biriyani", "Chicken Biryani"], ["पनीर", "Paneer Tikka"], ["tea", "Masala Chai"], ["bc", "Butter Chicken"]] as const) {
    await search.fill(q);
    await expect(dish(page, want), `search "${q}"`).toBeVisible();
  }
  await search.fill("");
  await dish(page, "Garlic Naan").click({ button: "right" });
  await page.getByRole("dialog", { name: "Garlic Naan" }).getByRole("button", { name: "Mark sold out today" }).click();
  await expect(dish(page, "Garlic Naan")).toBeDisabled();
  await expect(dish(page, "Garlic Naan")).toHaveAccessibleName(/Sold out/);
});

test("child test 10: 'ek butter chicken aur ek biryani, table 3' by voice: T3 (not AC3), Butter Chicken Half, the biryani is not dropped", async ({ page, request }) => {
  // Was a known failure (audit V-03, "table 3" -> AC3); fixed in voiceParse.ts tableCandidates (ux/voice-sheet): a normal test now.
  const s = await seedMenu(request);
  await fakeSpeech(page);
  await open(page, s);
  await page.getByRole("button", { name: /^Voice order/ }).click();
  const dlg = page.getByRole("dialog", { name: "Listening" });
  await say(page, "final", "ek butter chicken aur ek biryani table 3");
  await expect(dlg.getByTestId("voice-line").first()).toBeVisible();
  // Soft checks: every part of the task is reported, not only the first miss. (Voice parsing itself is the voice work, ux/voice2.)
  await expect(dlg.locator("select[aria-label='Table'] option:checked"), "table 3 -> T3").toHaveText("T3", { timeout: 5000 });
  // The biryani must still be there: as a line to confirm, or as a phrase to choose a dish for.
  const biryani = dlg.getByTestId("voice-line").filter({ hasText: /biryani/i }).or(dlg.getByRole("region", { name: "Not matched" }).filter({ hasText: /biryani/i }));
  await expect.soft(biryani.first(), "biryani not dropped: a line to check, or a phrase to choose a dish for").toBeVisible({ timeout: 5000 });
  // "biryani" fits two dishes: a default is picked, marked to check, with Change (owner rule 2026-11: never a block)
  await dlg.getByRole("button", { name: "Stop", exact: true }).click();
  const check = page.getByRole("dialog", { name: "Check the order" });
  await expect(check.getByRole("button", { name: /^Add to order/ })).toBeEnabled();
  const change = check.getByRole("combobox", { name: /^Which dish for/ }).first();
  await change.selectOption((await change.locator("option", { hasText: "Chicken Biryani" }).first().getAttribute("value"))!);
  await expect(check.getByTestId("voice-line").filter({ hasText: "Butter Chicken" })).toContainText("Half");
  await expect(check.getByRole("button", { name: "Change to Full +₹180" })).toBeVisible();
  await check.getByRole("button", { name: /^Add to order/ }).click();
  await expect.soft(panel(page).getByText("Butter Chicken · Half"), "Butter Chicken defaults to Half").toBeVisible({ timeout: 5000 });
});
