import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, fakeSpeech, openMenuPos, say, seedMenu, type MenuSeed } from "./helpers";

// "Bill number 2, 2 lamb karahi, ..." by voice: the till goes to Bill 2 (created with exactly that number when it is not
// open yet) and puts the items, the spoken type / table / customer on THAT ticket. SpeechRecognition is faked.

interface OrderRow { id: string; order_type: string; table_id: string | null; lines: { item_id: string; quantity: number }[] }
const orders = async (request: APIRequestContext, s: MenuSeed) => (await (await request.get(`${API}/orders`, { headers: s.auth })).json()) as OrderRow[];
const mk = async (request: APIRequestContext, s: MenuSeed, label: string, area: "indoor" | "outdoor") =>
  (await (await request.post(`${API}/tables`, { headers: s.auth, data: { label, area } })).json()).id as string;

const mic = (page: Page) => page.getByRole("button", { name: /^Voice order/ });
const tabs = (page: Page) => page.getByRole("tablist", { name: "Open orders" }).getByRole("tab");
const tab = (page: Page, re: RegExp) => page.getByRole("tablist", { name: "Open orders" }).getByRole("tab", { name: re });
const target = (page: Page) => page.getByRole("dialog").getByTestId("voice-target");

/** Opens the mic, says the sentence, returns the sheet. */
async function speak(page: Page, text: string) {
  await mic(page).click();
  await say(page, "final", text);
  return page.getByRole("dialog", { name: "Listening" });
}
async function add(page: Page) {
  await page.getByRole("dialog").getByRole("button", { name: /^Add to order/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
const storedDrafts = (page: Page) => page.evaluate(() => new Promise<number>((resolve, reject) => {
  const o = indexedDB.open("pos-offline");
  o.onerror = () => reject(o.error);
  o.onsuccess = () => {
    const db = o.result;
    const r = db.transaction("drafts").objectStore("drafts").count();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  };
}));

test("bill number by voice: Bill 2 is created with the items, Bill 1 untouched; then back to Bill 1; reload keeps everything", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  const t3 = await mk(request, s, "T3", "indoor");
  await fakeSpeech(page);
  await openMenuPos(page, s);
  await expect(tabs(page)).toHaveCount(1);
  await expect(tab(page, /^Bill 1, Takeaway, 0 items/)).toBeVisible();

  const dlg = await speak(page, "bill number two, 2 lamb karahi");
  await expect(target(page)).toHaveText("Adding to Bill 2 (new)");
  await expect(dlg.getByRole("combobox", { name: "Add to" })).toHaveValue("no:2");
  // the number is corrected while speaking: the sheet follows, the lines stay
  await say(page, "final", "sorry bill number 3");
  await expect(target(page)).toHaveText("Adding to Bill 3 (new)");
  await expect(dlg.getByTestId("voice-line")).toHaveCount(1);
  await say(page, "final", "no bill number 2, ek garlic naan, dine in table T3, customer name Raj");
  await expect(target(page)).toHaveText("Adding to Bill 2 (new)");
  await expect(dlg.getByTestId("voice-line")).toHaveCount(2);
  // nothing exists yet
  await expect(page.locator(`[aria-label="Open orders"] [role="tab"]`)).toHaveCount(1); // the open sheet hides the strip from the accessibility tree
  expect(await orders(request, s)).toHaveLength(0);
  await dlg.getByRole("button", { name: "Stop" }).click();
  await add(page);

  await expect(tabs(page)).toHaveCount(2);
  await expect(tab(page, /^Bill 1, Takeaway, 0 items/)).toBeVisible(); // untouched
  await expect(tab(page, /^Bill 2, Dine-in · T3, 3 items/)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Bill 2" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Customer: Raj/ })).toBeVisible();
  await expect.poll(() => storedDrafts(page)).toBe(2);

  await page.reload();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tab(page, /^Bill 2, Dine-in · T3, 3 items/)).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, /^Bill 1, Takeaway, 0 items/)).toBeVisible();

  // back to Bill 1
  await speak(page, "bill number one ek coke");
  await expect(target(page)).toHaveText("Adding to Bill 1 (open, 0 items)");
  await add(page);
  await expect(tab(page, /^Bill 1, Takeaway, 1 item/)).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, /^Bill 2, Dine-in · T3, 3 items/)).toBeVisible(); // nothing leaked into Bill 2
  expect(await orders(request, s)).toHaveLength(0);

  // "new bill": the lowest free number (3), then Bill 3 exists and is reused with its items merged
  await speak(page, "new bill, ek coke");
  await expect(target(page)).toHaveText("Adding to Bill 3 (new)");
  await add(page);
  await expect(tab(page, /^Bill 3, Takeaway, 1 item/)).toHaveAttribute("aria-selected", "true");
  await speak(page, "bill number 3 ek coke");
  await expect(target(page)).toHaveText("Adding to Bill 3 (open, 1 item)");
  await add(page);
  await expect(tab(page, /^Bill 3, Takeaway, 2 items/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Increase Coke" })).toBeVisible();
  await expect(page.getByText("Coke").first()).toBeVisible();
  await expect(tabs(page)).toHaveCount(3);

  // place Bill 2 (dine-in T3): only its lines reach the server
  await tab(page, /^Bill 2,/).click();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("button", { name: "Make bill" })).toBeVisible();
  const [o] = await orders(request, s);
  expect([o.order_type, o.table_id]).toEqual(["indoor", t3]);
  expect(o.lines.reduce((n, l) => n + l.quantity, 0)).toBe(3);

  // a spoken bill that is already placed still takes dishes: they land in "new items", the type / table cannot change
  const d2 = await speak(page, "bill number 2 ek coke, takeaway");
  await expect(target(page)).toHaveText("Adding to Bill 2 (new items)");
  await expect(d2.getByTestId("voice-not-applied")).toContainText("Not applied: order already placed");
  await expect(d2.getByRole("button", { name: /^Add to order/ })).toBeEnabled();
  await add(page);
  await expect(tab(page, /^Bill 2, .*4 items.*Placed/)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("more-items")).toContainText("Coke");
  expect((await orders(request, s))[0].lines.reduce((n, l) => n + l.quantity, 0)).toBe(3); // nothing sent until "Add to order"
  await page.getByRole("button", { name: "Add to order", exact: true }).click();
  await expect(page.getByTestId("more-items")).toHaveCount(0);
  expect((await orders(request, s))[0].lines.reduce((n, l) => n + l.quantity, 0)).toBe(4);
  expect((await orders(request, s))[0].order_type).toBe("indoor"); // unchanged

  // once billed it is refused as before: nothing is added until another bill is chosen
  await page.getByRole("button", { name: /^Send to kitchen/ }).click(); // dine-in: the kitchen first (audit C-01)
  await page.getByRole("button", { name: "Make bill" }).click();
  await expect(page.getByRole("button", { name: "Pay cash" })).toBeVisible();
  const d2b = await speak(page, "bill number 2 ek coke");
  await expect(target(page)).toContainText("Bill 2 is already billed");
  await expect(d2b.getByRole("button", { name: /^Add to order/ })).toBeDisabled();
  await expect(d2b.getByRole("combobox", { name: "Add to" }).locator('option[value="no:2"]')).toHaveAttribute("disabled", "");
  await d2b.getByRole("combobox", { name: "Add to" }).selectOption("new");
  await expect(target(page)).toHaveText("Adding to Bill 4 (new)");
  await add(page);
  await expect(tab(page, /^Bill 4, Takeaway, 1 item/)).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, /^Bill 2, .*4 items.*Awaiting payment/)).toBeVisible(); // the billed bill is untouched
  expect(await orders(request, s)).toHaveLength(1);

  // the active bill is billed and nothing spoken names a bill: the order goes to a new bill, not into the placed one
  await tab(page, /^Bill 2,/).click();
  const d3 = await speak(page, "ek coke");
  await expect(target(page)).toHaveText("Adding to Bill 5 (new)");
  await expect(d3.getByRole("combobox", { name: "Add to" })).toHaveValue("new");
  await d3.getByRole("button", { name: "Cancel" }).click();
  await expect(tabs(page)).toHaveCount(4); // cancel creates nothing
});

test("staff can change the target on the sheet; nothing is created until Add to order", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await fakeSpeech(page);
  await openMenuPos(page, s);
  const dlg = await speak(page, "bill number 4 ek coke");
  await expect(target(page)).toHaveText("Adding to Bill 4 (new)");
  await dlg.getByRole("combobox", { name: "Add to" }).selectOption("no:1");
  await expect(target(page)).toHaveText("Adding to Bill 1 (open, 0 items)");
  await say(page, "final", "bill number 5"); // later words do not override a choice made on the sheet
  await expect(target(page)).toHaveText("Adding to Bill 1 (open, 0 items)");
  await add(page);
  await expect(tabs(page)).toHaveCount(1);
  await expect(tab(page, /^Bill 1, Takeaway, 1 item/)).toBeVisible();
});

test("hands-free: after a bill was added it waits again for \"Hey Zonov\", ready for the next bill", async ({ page, context, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await context.grantPermissions(["microphone"]);
  await fakeSpeech(page, { handsFreeDefault: true });
  await openMenuPos(page, s);
  await expect(page.getByTestId("auto-status")).toHaveText(/Waiting for “Hey Zonov”/);
  await say(page, "final", "hey zonov bill number 2, two lamb karahi");
  await expect(target(page)).toHaveText("Adding to Bill 2 (new)");
  await add(page);
  await expect(tab(page, /^Bill 2, Takeaway, 2 items/)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("auto-status")).toHaveText(/Waiting for “Hey Zonov”/, { timeout: 5000 });
  await say(page, "final", "okay zonoff bill number 3, ek garlic naan");
  await expect(target(page)).toHaveText("Adding to Bill 3 (new)");
  await add(page);
  await expect(tabs(page)).toHaveCount(3);
  await expect(tab(page, /^Bill 3, Takeaway, 1 item/)).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, /^Bill 1, Takeaway, 0 items/)).toBeVisible();
});

test("the AI path (typed text) returns bill_no and the sheet targets it", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await page.addInitScript(() => {
    for (const k of ["SpeechRecognition", "webkitSpeechRecognition"]) Object.defineProperty(window, k, { configurable: true, value: undefined });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
  });
  await page.route("**/api/v1/ai/voice-order", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    transcript: null, unmatched: [], customer: { name: null, phone: null, phone_heard: null }, order_type: null, table_label: null, table_id: null,
    bill_no: 2, new_bill: false,
    lines: [{ item_id: s.items["Garlic Naan"].id, item_name: "Garlic Naan", variant_id: null, variant_name: null, quantity: 2, note: null, heard_text: "do naan", confidence: 0.9, needs_review: false, issues: [] }] }) }));
  await openMenuPos(page, s);
  await mic(page).click();
  const dlg = page.getByRole("dialog", { name: "Type the order" });
  await dlg.getByLabel("Order").fill("wahi jo pichli baar liya tha dusre bill pe");
  await dlg.getByRole("button", { name: "Understand" }).click();
  await expect(target(page)).toHaveText("Adding to Bill 2 (new)");
  await add(page);
  await expect(tab(page, /^Bill 2, Takeaway, 2 items/)).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, /^Bill 1, Takeaway, 0 items/)).toBeVisible();
});

test("\"done\" adds the order without a tap: Hey Zonov, bill 2, dine in, dishes, done", async ({ page, context, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await mk(request, s, "T3", "indoor");
  await context.grantPermissions(["microphone"]);
  await fakeSpeech(page, { handsFreeDefault: true });
  await openMenuPos(page, s);
  await expect(page.getByTestId("auto-status")).toHaveText(/Waiting for “Hey Zonov”/);
  await say(page, "final", "hey zonov bill number 2, dine in table T3, two lamb karahi, ek garlic naan");
  await expect(target(page)).toHaveText("Adding to Bill 2 (new)");
  await say(page, "final", "hey zonov bill number 2, dine in table T3, two lamb karahi, ek garlic naan, done");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(tab(page, /^Bill 2, Dine-in · T3, 3 items/)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("auto-status")).toHaveText(/Waiting for “Hey Zonov”/, { timeout: 5000 }); // ready for the next order
  // a tapped session: "done" works there too
  await mic(page).click();
  await say(page, "final", "ek garlic naan done");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(tab(page, /^Bill 2, Dine-in · T3, 4 items/)).toBeVisible();
});

test("\"done\" with words it could not match adds the clear dishes and keeps the rest on the sheet", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await fakeSpeech(page);
  await openMenuPos(page, s);
  await speak(page, "two lamb karahi and a flibbertigibbet done");
  const sheet = page.getByRole("dialog", { name: "Check the order" });
  await expect(sheet).toBeVisible();
  await expect(page.getByText("Added 2 items to the cart")).toBeVisible(); // the clear dishes went into the cart
  await expect(sheet.getByTestId("voice-done-hold")).toContainText("flibbertigibbet");
  await expect(sheet.getByTestId("voice-line")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: /^Add to order/ })).toBeDisabled();
  await sheet.getByRole("button", { name: "Cancel" }).click(); // the open sheet hides the ticket strip: look after closing
  await expect(tab(page, /^Bill 1, Takeaway, 2 items/)).toBeVisible();
});
