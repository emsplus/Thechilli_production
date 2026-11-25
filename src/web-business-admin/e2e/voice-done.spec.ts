import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, fakeSpeech, openAs, say, seedIn, type Seed } from "./helpers";

// Saying "done" (or ho gaya / bas itna / that's all) does what "Add to order" does for everything that can be added
// (docs/VOICE_DONE_STATUS.md). SpeechRecognition is faked. Never places an order, sends a KOT or bills.

interface Menu { chai: string; naan: string; cb: string; mb: string; bc: string; tables: Record<string, string> }
type OrderRow = { id: string; status: string; lines: { item_name: string; quantity: number }[] };

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
  for (const [label, area] of [["AC3", "indoor"], ["G3", "outdoor"]] as const) tables[label] = (await (await request.post(`${API}/tables`, { ...h, data: { label, area, seats: 4 } })).json()).id;
  return { ...s, chai: chai.id, naan: naan.id, cb: cb.id, mb: mb.id, bc: bc.id, tables };
}

const orders = async (request: APIRequestContext, s: Seed) => (await (await request.get(`${API}/orders`, { headers: s.auth })).json()) as OrderRow[];
const kots = async (request: APIRequestContext, s: Seed) => (await (await request.get(`${API}/kot`, { headers: s.auth })).json()) as { order_id: string }[];
const panel = (page: Page) => page.getByRole("complementary", { name: "Current order" });
const mic = (page: Page) => page.getByRole("button", { name: /^Voice order/ });
const sheet = (page: Page) => page.getByRole("dialog");
const holdNote = (page: Page) => page.getByTestId("voice-done-hold");
const addBtn = (page: Page) => sheet(page).getByRole("button", { name: /^Add to order/ });

test.use({ viewport: { width: 1280, height: 800 } });

async function open(page: Page, s: Seed) {
  await openAs(page, s.token, "/pos", s.refresh);
  await expect(page.getByRole("button", { name: /^Masala Chai,/ }).first()).toBeVisible();
}
/** Taps the mic and says `text` as one final result. */
async function speak(page: Page, text: string) {
  await mic(page).click();
  await expect(page.getByTestId("voice-live")).toBeVisible();
  await say(page, "final", text);
}

test("the owner's case: three dishes, one with a soft flag ('to garlic naan'), then done -> all are added, the doubtful one is marked Check, Undo takes them off", async ({ page, request }) => {
  const s = await seedMenu(request);
  await fakeSpeech(page);
  await open(page, s);
  await speak(page, "two masala chai, to garlic naan, one chicken biryani, done");
  await expect(sheet(page)).toHaveCount(0);
  const toast = page.getByText(/^Added 5 items to the cart\. 1 to check: Garlic Naan/);
  await expect(toast).toBeVisible();
  await expect(panel(page).getByText("Masala Chai", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("Chicken Biryani", { exact: true })).toBeVisible();
  const check = panel(page).getByTestId("line-check");
  await expect(check).toHaveCount(1);
  await expect(check).toHaveText("Check");
  expect((await check.boundingBox())!.height).toBeGreaterThanOrEqual(44 - 1);
  expect(await orders(request, s)).toHaveLength(0); // done never places an order
  expect(await kots(request, s)).toHaveLength(0);
  await page.waitForTimeout(700); // the toast has finished sliding in
  await page.screenshot({ path: "docs/voice-done-shots/done-added-1280.png" });
  await check.click(); // confirm: the marker goes
  await expect(panel(page).getByTestId("line-check")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(panel(page).getByText("Masala Chai", { exact: true })).toHaveCount(0);
});

for (const [said, name] of [
  ["done", "alone"], ["ho gaya", "Hinglish ho gaya"], ["bas itna", "Hinglish bas itna"], ["that's all", "that's all"], ["ok done", "ok done"], ["done karo", "done karo"], ["Done.", "capital and full stop"],
  ["add to order", "the spoken Add to order"], ["add to cart", "add to cart"], ["order mein daalo", "Hinglish order mein daalo"], ["add it", "add it"],
  ["don", "accent slip: don"], ["doen", "accent slip: doen"], ["dun", "accent slip: dun"], ["add two order", "slip: add two order"], ["add to border", "slip: add to border"],
] as const) {
  test(`'${said}' at the end of an order adds it (${name})`, async ({ page, request }) => {
    const s = await seedMenu(request);
    await fakeSpeech(page);
    await open(page, s);
    await speak(page, `two masala chai, one garlic naan, ${said}`);
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByText("Added 3 items to the cart")).toBeVisible();
    await expect(panel(page).getByText("Garlic Naan", { exact: true })).toBeVisible();
  });
}

test("the owner's case with 'add to order': three dishes, one with a soft flag, then 'add to order' -> all added, Check on the doubtful one, nothing placed", async ({ page, request }) => {
  const s = await seedMenu(request);
  await fakeSpeech(page);
  await open(page, s);
  await speak(page, "two masala chai, to garlic naan, one chicken biryani, add to order");
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByText(/^Added 5 items to the cart\. 1 to check: Garlic Naan/)).toBeVisible();
  await expect(panel(page).getByTestId("line-check")).toHaveCount(1);
  expect(await orders(request, s)).toHaveLength(0);
  expect(await kots(request, s)).toHaveLength(0);
});

test("'done' as its own later result after the items were already on the sheet, and with the words mixed into a dish ('butter chicken done')", async ({ page, request }) => {
  const s = await seedMenu(request);
  await fakeSpeech(page);
  await open(page, s);
  await speak(page, "two masala chai");
  await expect(sheet(page).getByTestId("voice-line")).toHaveCount(1);
  await say(page, "interim", "done");
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByText("Added 2 items to the cart")).toBeVisible();
  await speak(page, "butter chicken done");
  await expect(sheet(page)).toHaveCount(0);
  await expect(panel(page).getByText("Butter Chicken", { exact: false }).first()).toBeVisible();
});

// Owner rule 2026-11 (docs/VOICE_QA_REPORT.md): several dishes fit a word -> a default is picked (Check + Change), never a block.
test("several dishes fit ('ek biryani'): a default is picked and added with a Check marker; Change stays on the cart line", async ({ page, request }) => {
  const s = await seedMenu(request);
  await fakeSpeech(page);
  await open(page, s);
  await speak(page, "two masala chai, ek biryani, done");
  await expect(page.getByText(/^Added 3 items to the cart\. 1 to check: (Chicken|Mutton) Biryani/)).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await expect(panel(page).getByText(/^(Chicken|Mutton) Biryani$/)).toBeVisible();
  await expect(panel(page).getByTestId("line-check")).toHaveCount(1);
  expect(await orders(request, s)).toHaveLength(0);
});

test("only an ambiguous dish: still added (never 'Almost there')", async ({ page, request }) => {
  const s = await seedMenu(request);
  await fakeSpeech(page);
  await open(page, s);
  await speak(page, "ek biryani, done");
  await expect(page.getByText(/^Added 1 item to the cart/)).toBeVisible();
  await expect(holdNote(page)).toHaveCount(0);
  await expect(panel(page).getByText(/^(Chicken|Mutton) Biryani$/)).toBeVisible();
  expect(await orders(request, s)).toHaveLength(0);
});

test("a sold-out dish stays, the others are added", async ({ page, request }) => {
  const s = await seedMenu(request);
  expect((await request.patch(`${API}/menu/items/${s.naan}/sold-out`, { headers: s.auth, data: { sold_out: true } })).ok()).toBe(true);
  await fakeSpeech(page);
  await open(page, s);
  await speak(page, "do garlic naan, ek masala chai, done");
  await expect(page.getByText("Added 1 item to the cart")).toBeVisible();
  await expect(sheet(page).getByTestId("voice-sold-out")).toHaveText("Sold out");
  await expect(holdNote(page)).toContainText("Added 1 item. Choose another dish for Garlic Naan, it is sold out to add the rest.");
  await expect(addBtn(page)).toBeDisabled();
  await expect(panel(page).getByText("Garlic Naan", { exact: true })).toHaveCount(0);
});

test("words that matched nothing stay (Add is disabled until they are picked or dropped); the rest is added", async ({ page, request }) => {
  const s = await seedMenu(request);
  await fakeSpeech(page);
  await open(page, s);
  await speak(page, "two masala chai and a flibbertigibbet done");
  await expect(page.getByText("Added 2 items to the cart")).toBeVisible();
  await expect(holdNote(page)).toContainText("flibbertigibbet");
  await expect(sheet(page).getByTestId("voice-unmatched")).toHaveCount(1);
  await sheet(page).getByRole("button", { name: /^Drop “/ }).first().click();
  await expect(holdNote(page)).toHaveCount(0);
});

test("a table that fits several tables ('3' = AC3 or G3) holds the whole order until a table is chosen", async ({ page, request }) => {
  const s = await seedMenu(request);
  await fakeSpeech(page);
  await open(page, s);
  await speak(page, "table 3, two masala chai, done");
  await expect(holdNote(page)).toContainText("Almost there: choose the table");
  await expect(addBtn(page)).toBeDisabled();
  await expect(panel(page).getByText("Masala Chai", { exact: true })).toHaveCount(0);
  await sheet(page).getByTestId("voice-table-choices").getByRole("button", { name: /^AC3/ }).click();
  await expect(holdNote(page)).toHaveCount(0);
  await expect(addBtn(page)).toBeEnabled();
});

test("done only adds; 'place order' said with it places and sends the kitchen ticket after the countdown", async ({ page, request }) => {
  const s = await seedMenu(request);
  await fakeSpeech(page);
  await open(page, s);
  await speak(page, "two masala chai, done, place order");
  await expect(sheet(page).getByTestId("voice-countdown")).toBeVisible();
  expect(await orders(request, s)).toHaveLength(0);
  await expect.poll(async () => (await kots(request, s)).length, { timeout: 12_000 }).toBe(1);
  expect((await orders(request, s))[0].lines.map((l) => [l.item_name, l.quantity])).toEqual([["Masala Chai", 2]]);
});

test("done with nothing understood just stops listening", async ({ page, request }) => {
  const s = await seedMenu(request);
  await fakeSpeech(page);
  await open(page, s);
  await speak(page, "done");
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByText("Nothing to add yet")).toBeVisible();
  expect(await orders(request, s)).toHaveLength(0);
});

test("hands-free ON: after done the sheet closes and the listener is waiting for the next order (visible Listening)", async ({ page, context, request }) => {
  const s = await seedMenu(request);
  await context.grantPermissions(["microphone"]);
  await fakeSpeech(page, { handsFreeDefault: true });
  await open(page, s);
  await expect(page.getByTestId("hands-free")).toHaveAttribute("aria-label", /Listening/);
  await say(page, "final", "hey zonov two masala chai, one garlic naan, ho gaya");
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByText("Added 3 items to the cart")).toBeVisible();
  await expect(page.getByTestId("hands-free")).toHaveAttribute("aria-label", /Listening/, { timeout: 8000 });
  await expect(page.getByTestId("auto-status")).toHaveText(/Waiting for “Hey Zonov”/);
  await page.screenshot({ path: "docs/voice-done-shots/done-handsfree-on-1280.png" });
  // the next order works at once
  await say(page, "final", "hey zonov one masala chai, done");
  await expect(page.getByText("Added 1 item to the cart")).toBeVisible();
});

test("hands-free OFF: after done the listener has stopped", async ({ page, request }) => {
  const s = await seedMenu(request);
  await fakeSpeech(page);
  await open(page, s);
  await speak(page, "one masala chai, done");
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByTestId("hands-free")).toHaveAttribute("aria-label", /Off/);
  expect(await page.evaluate(() => (window as unknown as { __live: () => number }).__live())).toBe(0);
});

test("typed text: 'two masala chai, done' adds too; 'butter chicken done' is one dish, never a 'done' phrase", async ({ page, request }) => {
  const s = await seedMenu(request);
  await page.addInitScript(() => { // no speech recogniser and no microphone: the mic opens "Type the order"
    for (const k of ["SpeechRecognition", "webkitSpeechRecognition"]) Object.defineProperty(window, k, { configurable: true, value: undefined });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
  });
  await open(page, s);
  await mic(page).click();
  await page.getByRole("dialog").getByLabel("Order").fill("butter chicken half, ek garlic naan, done");
  await page.getByRole("dialog").getByRole("button", { name: "Understand" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByText("Added 2 items to the cart")).toBeVisible();
});

test("390 px: the held sheet and the cart Check marker fit the phone (44 px targets)", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await seedMenu(request);
  await fakeSpeech(page);
  await open(page, s);
  await speak(page, "two masala chai, to garlic naan, a flibbertigibbet, done"); // an unmatched phrase holds (an ambiguous dish no longer does)
  await expect(holdNote(page)).toBeVisible();
  const hold = (await holdNote(page).boundingBox())!;
  expect(hold.x).toBeGreaterThanOrEqual(0);
  expect(hold.x + hold.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "docs/voice-done-shots/done-partial-390.png" });
  await sheet(page).getByRole("button", { name: /^Drop “/ }).first().click();
  await expect(holdNote(page)).toHaveCount(0);
  await sheet(page).getByRole("button", { name: "Cancel" }).click();
  await expect(sheet(page)).toHaveCount(0);
});
