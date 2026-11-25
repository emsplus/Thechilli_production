import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, fakeSpeech, openMenuPos, say, seedMenu, type MenuSeed } from "./helpers";

// Voice adds dishes to a bill that is already placed / in the kitchen (never billed or paid): they collect in "New items"
// exactly like menu taps, and the cashier's "Add to order" (and the automatic KOT) sends them.

interface Kot { id: string; number: number; payload: { item: string; qty: number }[] }
const kots = async (request: APIRequestContext, s: MenuSeed) =>
  ((await (await request.get(`${API}/kot`, { headers: s.auth })).json()) as Kot[]).sort((a, b) => a.number - b.number);
const orders = async (request: APIRequestContext, s: MenuSeed) =>
  (await (await request.get(`${API}/orders`, { headers: s.auth })).json()) as { lines: { item_name: string; quantity: number }[] }[];
const shape = (k: Kot) => k.payload.map((l) => `${l.qty} ${l.item}`);
const mic = (page: Page) => page.getByRole("button", { name: /^Voice order/ });
const target = (page: Page) => page.getByRole("dialog").getByTestId("voice-target");
const more = (page: Page) => page.getByTestId("more-items");
async function speak(page: Page, text: string) {
  await mic(page).click();
  await say(page, "final", text);
  return page.getByRole("dialog", { name: "Listening" });
}
async function addVoice(page: Page) {
  await page.getByRole("dialog").getByRole("button", { name: /^Add to order/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test("after Place order: voice dishes land in new items, merge with an identical line, and go out with Add to order", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await fakeSpeech(page);
  await openMenuPos(page, s);
  await page.getByRole("button", { name: /^Lamb Karahi,/ }).click();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("button", { name: "Make bill" })).toBeVisible();
  await page.getByRole("button", { name: /^Garlic Naan,/ }).click(); // a tap first: one Garlic Naan already waiting
  await expect(more(page)).toContainText("Garlic Naan");

  const dlg = await speak(page, "ek garlic naan, two coke");
  await expect(target(page)).toHaveText("Adding to Bill 1 (new items)");
  await expect(dlg.getByTestId("voice-line")).toHaveCount(2);
  expect((await orders(request, s))[0].lines).toHaveLength(1); // nothing before "Add to order"
  await addVoice(page);
  await expect(more(page)).toContainText("Coke");
  await expect(more(page).getByText("Garlic Naan")).toHaveCount(1); // merged into the one line, not duplicated
  expect((await orders(request, s))[0].lines).toHaveLength(1); // the sheet only collects

  await page.getByRole("button", { name: "Add to order", exact: true }).click();
  await expect(more(page)).toHaveCount(0);
  const lines = (await orders(request, s))[0].lines.map((l) => `${l.quantity} ${l.item_name}`).sort();
  expect(lines).toEqual(["1 Lamb Karahi", "2 Coke", "2 Garlic Naan"].sort());
});

test("after a sent KOT: hands-free \"done\" collects the voice items and the second KOT has only them", async ({ page, context, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await context.grantPermissions(["microphone"]);
  await fakeSpeech(page, { handsFreeDefault: true });
  await openMenuPos(page, s);
  await page.getByRole("button", { name: /^Lamb Karahi,/ }).click();
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: /Send to kitchen/ }).click();
  await expect(page.getByRole("button", { name: /Kitchen ticket #1 sent/ })).toBeVisible();

  await expect(page.getByTestId("auto-status")).toHaveText(/Waiting for “Hey Zonov”/, { timeout: 8000 }); // keeps listening on a sent bill
  await say(page, "final", "hey zonov ek coke, done");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(more(page)).toContainText("Coke");
  expect(await kots(request, s)).toHaveLength(1);
  await page.getByRole("button", { name: "Add to order", exact: true }).click();
  await page.getByRole("button", { name: "Send new items to kitchen" }).click();
  await expect.poll(async () => (await kots(request, s)).length).toBe(2);
  const k = await kots(request, s);
  expect(shape(k[0])).toEqual(["1 Lamb Karahi"]);
  expect(shape(k[1])).toEqual(["1 Coke"]);
});

test("a billed bill is still refused by voice", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await fakeSpeech(page);
  await openMenuPos(page, s);
  await page.getByRole("button", { name: /^Lamb Karahi,/ }).click();
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: "Make bill" }).click();
  await expect(page.getByRole("button", { name: "Pay cash" })).toBeVisible();
  const dlg = await speak(page, "bill number 1 ek coke");
  await expect(target(page)).toContainText("Bill 1 is already billed");
  await expect(dlg.getByRole("button", { name: /^Add to order/ })).toBeDisabled();
});
