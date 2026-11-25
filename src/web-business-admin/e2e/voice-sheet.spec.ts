import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, fakeSpeech, openAs, say, seedIn, type Seed } from "./helpers";

// The voice order sheet with everything the voice parser and the server give it (docs/VOICE_SHEET_STATUS.md):
// default size + one-tap switch, several dishes fit -> a default picked with Check + Change (device and server `clarifications`;
// owner rule 2026-11, never a block), spoken place / send after a countdown (docs/VOICE_QA_REPORT.md), sold-out dishes, a busy
// table with the counter's choices, how it was understood, accessibility.

interface Menu { chai: string; bc: string; naan: string; cb: string; mb: string; tables: Record<string, string> }
type OrderRow = { id: string; status: string; table_id: string | null; lines: { item_name: string; quantity: number; note: string | null }[] };

async function seedMenu(request: APIRequestContext): Promise<Seed & Menu> {
  const s = await seedIn(request);
  const h = { headers: s.auth };
  const cat = async (name: string) => (await (await request.post(`${API}/menu/categories`, { ...h, data: { name } })).json()).id as string;
  const item = async (category_id: string, name: string, price: string, variants: { name: string; price_delta: string }[] = []) =>
    (await (await request.post(`${API}/menu/items`, { ...h, data: { category_id, name, price, variants } })).json()) as { id: string };
  const drinks = await cat("Drinks"), breads = await cat("Breads"), rice = await cat("Rice");
  const chai = await item(drinks, "Masala Chai", "40.00");
  const bc = await item(s.catId, "Butter Chicken", "280.00", [{ name: "Half", price_delta: "0.00" }, { name: "Full", price_delta: "180.00" }]);
  const naan = await item(breads, "Garlic Naan", "60.00");
  const cb = await item(rice, "Chicken Biryani", "260.00");
  const mb = await item(rice, "Mutton Biryani", "320.00");
  const tables: Record<string, string> = { T1: s.tableId };
  for (const [label, area] of [["AC3", "indoor"], ["T3", "indoor"], ["T4", "indoor"]] as const)
    tables[label] = (await (await request.post(`${API}/tables`, { ...h, data: { label, area, seats: 4 } })).json()).id;
  return { ...s, chai: chai.id, bc: bc.id, naan: naan.id, cb: cb.id, mb: mb.id, tables };
}

const orders = async (request: APIRequestContext, s: Seed) => (await (await request.get(`${API}/orders`, { headers: s.auth })).json()) as OrderRow[];
const kots = async (request: APIRequestContext, s: Seed) => (await (await request.get(`${API}/kot`, { headers: s.auth })).json()) as { order_id: string }[];
const panel = (page: Page) => page.getByRole("complementary", { name: "Current order" });

async function open(page: Page, s: Seed) {
  await openAs(page, s.token, "/pos", s.refresh);
  await expect(page.getByRole("button", { name: /^Masala Chai,/ }).first()).toBeVisible();
}
/** Types an order into the sheet (the on-device parser; the server only when nothing matched). */
async function typed(page: Page, text: string) {
  await page.getByRole("button", { name: /^Voice order/ }).click();
  const dlg = page.getByRole("dialog", { name: "Listening" });
  await say(page, "final", text);
  // a spoken command ends listening by itself; otherwise Stop settles the sheet
  await page.waitForTimeout(150);
  if (await dlg.isVisible()) await dlg.getByRole("button", { name: "Stop", exact: true }).click();
  return page.getByRole("dialog", { name: /Check the order|Clear the order\?/ });
}

test.use({ viewport: { width: 1024, height: 768 } });

test("default size Half with a one-tap 'Full +₹180'; 'biryani' gets a default with Check and Change, never a block", async ({ page, request }) => {
  const s = await seedMenu(request);
  await fakeSpeech(page);
  await open(page, s);
  const dlg = await typed(page, "ek butter chicken aur ek biryani table 3");
  await expect(dlg.getByTestId("voice-source")).toHaveText(/^Understood on device/);
  const bc = dlg.getByTestId("voice-line").filter({ hasText: "Butter Chicken" });
  await expect(bc).toContainText("Butter Chicken · Half");
  await expect(bc).toContainText("(default size)");
  const by = dlg.getByTestId("voice-line").filter({ hasText: "Biryani" });
  await expect(by).toContainText("picked for you: 2 dishes fit");
  await expect(dlg.getByRole("button", { name: /^Add to order \(2\)/ })).toBeEnabled();
  await expect(dlg.getByTestId("voice-blocked")).toHaveCount(0);
  await expect(dlg.getByTestId("voice-announce")).toContainText("2 items ready");
  await bc.getByRole("button", { name: "Change to Full +₹180" }).click();
  await expect(bc).toContainText("Butter Chicken · Full");
  await bc.getByRole("button", { name: "Change to Half", exact: true }).click();
  await by.getByRole("combobox", { name: /^Which dish for/ }).selectOption(s.mb); // Change
  await expect(dlg.locator("select[aria-label='Table'] option:checked")).toHaveText("T3");
  await dlg.getByRole("button", { name: /^Add to order \(2\)/ }).click();
  await expect(panel(page).getByText("Butter Chicken · Half")).toBeVisible();
  await expect(panel(page).getByText("Mutton Biryani", { exact: true })).toBeVisible();
  await expect(panel(page).getByTestId("table-chosen")).toContainText("T3");
});

test("server clarifications get a default with Change (never a block); 'Checked with AI' when the model was used", async ({ page, request }) => {
  const s = await seedMenu(request);
  await fakeSpeech(page);
  // Nothing matches on the device ("xyz"), so the transcript goes to the server; its reply is replaced with a clarification.
  await page.route("**/api/v1/ai/voice-order", (r) => r.fulfill({ json: {
    transcript: "do butter chicken aur ek biryani", lines: [{ item_id: s.bc, item_name: "Butter Chicken", variant_id: null, variant_name: null, quantity: 2, note: null, heard_text: "do butter chicken", confidence: 0.9, needs_review: false, issues: [], defaulted: true }],
    unmatched: [], clarifications: [{ heard_text: "ek biryani", reason: "ambiguous_item", options: [{ item_id: s.cb, item_name: "Chicken Biryani" }, { item_id: s.mb, item_name: "Mutton Biryani" }], quantity: 1, note: null }],
    needs_clarification: true, customer: { name: null, phone: null, phone_heard: null }, order_type: null, table_label: null, table_id: null, command: null, model_used: true } }));
  await open(page, s);
  const dlg = await typed(page, "xyz qqq");
  await expect(dlg.getByTestId("voice-source")).toHaveText(/^Checked with AI/, { timeout: 10000 });
  await expect(dlg.getByTestId("voice-line").filter({ hasText: "Butter Chicken" })).toContainText("Half");
  const by = dlg.getByTestId("voice-line").filter({ hasText: "Biryani" });
  await expect(by).toContainText("picked for you");
  await by.getByRole("combobox", { name: "Which dish for “ek biryani”" }).selectOption(s.cb);
  await dlg.getByRole("button", { name: /^Add to order \(3\)/ }).click();
  await expect(panel(page).getByText("Chicken Biryani", { exact: true })).toBeVisible();
});

test("'send to kitchen' runs by itself after a visible countdown: nothing is placed before it, then order + kitchen ticket", async ({ page, request }) => {
  const s = await seedMenu(request);
  await fakeSpeech(page);
  await open(page, s);
  await page.getByRole("button", { name: /^Voice order/ }).click();
  await say(page, "final", "do garlic naan, send to kitchen");
  const dlg = page.getByRole("dialog", { name: "Sending to the kitchen" });
  await expect(dlg.getByTestId("voice-countdown")).toContainText("Sending to the kitchen in 3, 2, 1. Say “stop” or tap Cancel.");
  expect(await orders(request, s)).toHaveLength(0);
  await expect.poll(async () => (await kots(request, s)).length, { timeout: 10000 }).toBe(1);
  const o = await orders(request, s);
  expect(o[0].lines.map((l) => [l.item_name, l.quantity])).toEqual([["Garlic Naan", 2]]);
});

test("'cancel' asks before clearing; Keep the order keeps it; Clear the order clears with Undo; placed dishes are never cancelled", async ({ page, request }) => {
  const s = await seedMenu(request);
  await fakeSpeech(page);
  await open(page, s);
  await page.getByRole("button", { name: /^Masala Chai,/ }).first().click();
  await page.getByRole("button", { name: /^Voice order/ }).click();
  await say(page, "final", "cancel");
  let dlg = page.getByRole("dialog", { name: "Clear the order?" });
  await expect(dlg.getByTestId("voice-command")).toContainText("Heard: “cancel”");
  await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(panel(page).getByText("Masala Chai", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Voice order/ }).click();
  await say(page, "final", "cancel");
  dlg = page.getByRole("dialog", { name: "Clear the order?" });
  await dlg.getByRole("button", { name: "Clear the order" }).click();
  await expect(page.getByText("Order cleared")).toBeVisible();
  await expect(panel(page).getByText("Masala Chai", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(panel(page).getByText("Masala Chai", { exact: true })).toBeVisible();
});

test("a sold-out dish is marked in words, cannot be added, and can be swapped for another dish", async ({ page, request }) => {
  const s = await seedMenu(request);
  expect((await request.patch(`${API}/menu/items/${s.naan}/sold-out`, { headers: s.auth, data: { sold_out: true } })).ok()).toBe(true);
  await fakeSpeech(page);
  await open(page, s);
  const dlg = await typed(page, "do garlic naan ek masala chai");
  const naan = dlg.getByTestId("voice-line").filter({ hasText: "Garlic Naan" });
  await expect(naan.getByTestId("voice-sold-out")).toHaveText("Sold out");
  await expect(dlg.getByRole("button", { name: /^Add to order/ })).toBeDisabled();
  await naan.getByLabel("Another dish instead of Garlic Naan").selectOption({ label: "Chicken Biryani · Rice" });
  await dlg.getByRole("button", { name: /^Add to order \(3\)/ }).click();
  await expect(panel(page).getByText("Chicken Biryani", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("Garlic Naan", { exact: true })).toHaveCount(0);
});

test("a busy table offers the counter's choices: 'Add to this table's order' keeps one order on T4", async ({ page, request }) => {
  const s = await seedMenu(request);
  await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "indoor", table_id: s.tables.T4, lines: [{ item_id: s.chai, quantity: 2 }] } });
  await fakeSpeech(page);
  await open(page, s);
  await page.waitForTimeout(1000); // table states loaded
  const dlg = await typed(page, "ek garlic naan table T4");
  const busy = dlg.getByTestId("voice-busy-table");
  await expect(busy).toContainText("Table T4 already has an order");
  await expect(dlg.getByRole("button", { name: /^Add to order/ })).toBeDisabled();
  await busy.getByRole("button", { name: "Add to this table’s order" }).click();
  await expect(busy.getByRole("button", { name: "Add to this table’s order" })).toHaveAttribute("aria-pressed", "true");
  await dlg.getByRole("button", { name: /^Add to order/ }).click();
  await expect(panel(page).getByTestId("more-items")).toContainText("Garlic Naan");
  await panel(page).getByRole("button", { name: "Add to order", exact: true }).click();
  await expect(page.getByText("Items added to the order")).toBeVisible();
  const onT4 = (await orders(request, s)).filter((o) => o.table_id === s.tables.T4 && o.status !== "cancelled");
  expect(onT4).toHaveLength(1);
  expect(onT4[0].lines.map((l) => l.item_name).sort()).toEqual(["Garlic Naan", "Masala Chai"]);
});

test("'Start a separate order' on a busy table places a second order there", async ({ page, request }) => {
  const s = await seedMenu(request);
  await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "indoor", table_id: s.tables.T4, lines: [{ item_id: s.chai, quantity: 1 }] } });
  await fakeSpeech(page);
  await open(page, s);
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: /^Voice order/ }).click();
  await say(page, "final", "ek garlic naan table T4, place order");
  const dlg = page.getByRole("dialog", { name: "Check the order" });
  await dlg.getByTestId("voice-busy-table").getByRole("button", { name: "Start a separate order" }).click();
  await dlg.getByRole("button", { name: /^Place and send to kitchen/ }).click(); // a tap runs at once
  await expect.poll(async () => (await orders(request, s)).filter((o) => o.table_id === s.tables.T4).length, { timeout: 10000 }).toBe(2);
});

// Accessibility and screenshots of the sheet: phone 360 / 390 and desktop 1024, light and dark.
for (const size of [{ n: "360", w: 360, h: 740 }, { n: "390", w: 390, h: 844 }, { n: "1024", w: 1024, h: 768 }]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`a11y ${size.n} ${scheme}`, () => {
      if (size.w < 500) test.use({ hasTouch: true, isMobile: true });
      test(`voice sheet: axe, 44 px targets, words for every state @${size.n} ${scheme}`, async ({ page, request }) => {
        const s = await seedMenu(request);
        await page.setViewportSize({ width: size.w, height: size.h });
        await page.emulateMedia({ colorScheme: scheme });
        await request.patch(`${API}/menu/items/${s.naan}/sold-out`, { headers: s.auth, data: { sold_out: true } });
        await fakeSpeech(page, { handsFreeDefault: false });
        await open(page, s);
        // the voice row (mic + hands-free switch) never covers the category chips
        if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/counter-${size.n}-${scheme}.png` });
        // no spoken command here: a spoken place / send would run after its countdown (covered with axe in voice-qa.spec.ts)
        const dlg = await typed(page, "ek butter chicken, ek biryani, ek garlic naan, table 3");
        await expect(dlg.getByTestId("voice-line")).toHaveCount(3);
        await page.waitForTimeout(400);
        if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/sheet-${size.n}-${scheme}.png` });
        await dlg.getByRole("combobox", { name: /^Which dish for/ }).first().scrollIntoViewIfNeeded();
        if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/sheet-ask-${size.n}-${scheme}.png` });
        const res = await new AxeBuilder({ page }).include("[role=dialog]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
        expect(bad, "axe serious/critical in the sheet").toEqual([]);
        if (size.w < 500) {
          const small = await dlg.evaluate((root) => [...root.querySelectorAll<HTMLElement>("button, select, input, textarea, [role=button]")]
            .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44); })
            .map((el) => `${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30)} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`));
          expect(small, "44 px touch targets").toEqual([]);
        }
        // states in words, not only colour: sold out, which dish, the command
        await expect(dlg.getByTestId("voice-sold-out")).toHaveText("Sold out");
        await expect(dlg.getByText(/picked for you/)).toBeVisible();
        await expect(dlg.getByTestId("voice-announce")).toHaveAttribute("aria-live", "polite");
      });
    });
  }
}
