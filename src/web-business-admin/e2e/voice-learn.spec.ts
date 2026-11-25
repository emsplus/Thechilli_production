import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { aliasPhrase, buildVoiceMenu, parseOrder } from "../src/lib/voiceParse";
import type { Category, MenuItem, VoiceAlias } from "../src/lib/types";
import { API, fakeSpeech, openAs, openMenuPos, say, seedMenu, type MenuSeed } from "./helpers";
import { KARAHI_MENU } from "./fixtures/karahi-menu";

// Voice learns from corrections: a dish staff pick for a phrase (unmatched, or changed in a line's picker) is stored for the
// restaurant once the order is added, and the next time the phrase is heard it goes straight to that dish.

// ---- the parser side (pure, no browser), on The Karahi's real menu ----
const cats: Category[] = KARAHI_MENU.map(([name], i) => ({ id: `c${i}`, name, sort_order: i }) as unknown as Category);
const items: MenuItem[] = KARAHI_MENU.flatMap(([, dishes], ci) => dishes.map(([name, opts], k) => ({
  id: `${ci}-${k}`, category_id: `c${ci}`, name, price: "1.00", is_active: true,
  variants: (opts ?? []).map((o, j) => ({ id: `${ci}-${k}-v${j}`, name: o, price_delta: "1.00" })),
})) as unknown as MenuItem[]);
const idOf = (name: string) => items.find((i) => i.name === name)!.id;
const nameOf = (id: string) => items.find((i) => i.id === id)!.name;
const plain = buildVoiceMenu(items, cats);

test("the learnt key drops quantities, fillers and notes, and folds words like the matcher", () => {
  expect(aliasPhrase("two chicken tikki", plain)).toBe("chicken tikki");
  expect(aliasPhrase("do chicken tikki no onion", plain)).toBe("chicken tikki");
  expect(aliasPhrase("chicken tikki x2", plain)).toBe("chicken tikki");
  expect(aliasPhrase("ek Murgi please", plain)).toBe("murgi");
  expect(aliasPhrase("2 lamb karahi", plain)).toBe("lamb kadai"); // karahi / kadai / kadhai fold to one spelling (shared lexicon)
  expect(aliasPhrase("three", plain)).toBe("");
  // a phrase cut out of a longer transcript gets the same key
  // (an unknown word: "murgi" itself is now read as chicken through the food lexicon, docs/VOICE_QA_REPORT.md)
  const r = parseOrder("do lamb karahi, teen toofani wala, customer name Raj", plain);
  expect(r.unmatched.map((u) => [u.text, u.phrase])).toEqual([["teen toofani wala", "toofani"]]);
  expect(r.lines.map((l) => l.phrase)).toEqual(["lamb kadai"]);
});

test("a learnt phrase matches its dish with full confidence; Hinglish and the rest of the order are untouched", () => {
  const menu = buildVoiceMenu(items, cats, [
    { phrase: "murgi", menu_item_id: idOf("Tandoor Chicken"), variant_id: null },
    { phrase: "Chicken  Tikki", menu_item_id: idOf("Chicken Tikka"), variant_id: null }, // stored loosely: re-keyed on load
    { phrase: "ghost", menu_item_id: "no-such-dish", variant_id: null }, // archived / deleted dish: ignored
  ]);
  expect([...menu.aliases.keys()]).toEqual(["murgi", "chicken tikki"]);
  const r = parseOrder("do lamb karahi, ek coke, teen murgi extra spicy", menu);
  expect(r.unmatched).toEqual([]);
  expect(r.lines.map((l) => [l.qty, nameOf(l.itemId), l.issues, l.learnt, l.confidence])).toEqual([
    [2, "Karahi Lamb", [], false, expect.any(Number)], [1, "Coke", [], false, expect.any(Number)], [3, "Tandoor Chicken", [], true, 1]]);
  expect(r.lines[2].note).toBe("extra spicy");
  // a spoken size still picks the option of a learnt dish
  const full = parseOrder("full murgi", menu).lines[0];
  expect([nameOf(full.itemId), full.variantId, full.issues]).toEqual(["Tandoor Chicken", `${idOf("Tandoor Chicken")}-v0`, []]);
  // a learnt option is used, and what the phrase could otherwise be stays in the picker
  const withOpt = buildVoiceMenu(items, cats, [{ phrase: "garlic", menu_item_id: idOf("Garlic Naan"), variant_id: null }]);
  const g = parseOrder("garlic", withOpt).lines[0];
  expect([nameOf(g.itemId), g.issues, g.learnt]).toEqual(["Garlic Naan", [], true]);
  expect(g.alternatives).not.toContain(idOf("Garlic Naan"));
});

test("a heard phrase that only sounds like a learnt one still finds its dish, but never beats a dish the menu names clearly", () => {
  const menu = buildVoiceMenu(items, cats, [
    { phrase: "murgi", menu_item_id: idOf("Tandoor Chicken"), variant_id: null },
    { phrase: "chicken tikki", menu_item_id: idOf("Chicken Tikka"), variant_id: null },
  ]);
  for (const [said, dish] of [["murgee", "Tandoor Chicken"], ["two murgy", "Tandoor Chicken"], ["chickentikki", "Chicken Tikka"]] as const) {
    const l = parseOrder(said, menu).lines[0];
    expect([said, nameOf(l.itemId), l.learnt, l.issues]).toEqual([said, dish, true, []]);
  }
  // "chikan tikky" is now read as Chicken Tikka by the menu itself (shared spellings): same dish, not via the lesson
  expect(nameOf(parseOrder("chikan tikky", menu).lines[0].itemId)).toBe("Chicken Tikka");
  // a dish the menu itself names clearly wins over a learnt phrase that merely sounds alike
  const lamb = parseOrder("lamb karahi", menu).lines[0];
  expect([nameOf(lamb.itemId), lamb.learnt]).toEqual(["Karahi Lamb", false]);
  // nothing alike: not forced onto a learnt dish
  expect(parseOrder("ek burger", menu).lines.filter((l) => l.learnt)).toEqual([]);
});

// ---- the till ----
const mic = (page: Page) => page.getByRole("button", { name: "Voice order", exact: true });
const learnt = (page: Page) => page.waitForResponse((r) => r.url().includes("/menu/voice-aliases") && r.request().method() === "PUT");
const aliases = async (request: APIRequestContext, s: MenuSeed) => (await (await request.get(`${API}/menu/voice-aliases`, { headers: s.auth })).json()) as VoiceAlias[];

/** seedMenu's menu plus two chicken dishes that "chicken" alone cannot tell apart (one with a Large option). */
async function seedChicken(request: APIRequestContext) {
  const s = await seedMenu(request, { serviceCharge: null });
  const add = async (name: string, variants: { name: string; price_delta: string }[] = []) =>
    (await (await request.post(`${API}/menu/items`, { headers: s.auth, data: { category_id: s.catId, name, price: "9.00", tax_kind: "hot_food", variants } })).json()) as MenuItem;
  const tikka = await add("Chicken Tikka");
  const karahi = await add("Chicken Karahi", [{ name: "Large", price_delta: "2.00" }]);
  return { s, tikka, karahi };
}

test("a dish picked for an unmatched phrase is learnt on Add to order and matched next time; Manage forgets it", async ({ page, request }) => {
  const { s, tikka } = await seedChicken(request);
  await fakeSpeech(page);
  await openMenuPos(page, s);

  await mic(page).click();
  const dlg = page.getByRole("dialog", { name: "Listening" });
  await say(page, "final", "two toofani");
  await expect(dlg.getByTestId("voice-unmatched")).toHaveCount(1);
  await dlg.getByLabel("Pick a dish for “two toofani”").selectOption(tikka.id);
  await expect(dlg.getByTestId("voice-line")).toHaveCount(1);
  const put = learnt(page);
  await dlg.getByRole("button", { name: /^Add to order/ }).click();
  await expect(page.getByText(/1 item added to/)).toBeVisible();
  expect((await put).status()).toBe(200);
  expect((await aliases(request, s)).map((a) => [a.phrase, a.item_name, a.variant_id, a.uses])).toEqual([["toofani", "Chicken Tikka", null, 1]]);

  // next time: straight to the dish, nothing to check, nothing learnt again
  let puts = 0;
  page.on("request", (r) => { if (r.url().includes("/menu/voice-aliases") && r.method() === "PUT") puts++; });
  await mic(page).click();
  await say(page, "final", "teen toofani, do lamb karahi");
  await expect(dlg.getByTestId("voice-line")).toHaveCount(2);
  await expect(dlg.getByTestId("voice-unmatched")).toHaveCount(0);
  await expect(dlg.getByTestId("voice-line").first()).toContainText("Chicken Tikka");
  await expect(dlg.getByText(/not sure about this dish|Which dish\?/)).toHaveCount(0);
  await dlg.getByRole("button", { name: /^Add to order/ }).click();
  await expect(page.getByText(/5 items added to/)).toBeVisible();
  expect(puts).toBe(0);

  // Manage > Menu > Voice phrases lists it, and a wrong one is forgotten
  await openAs(page, s.token, "/manage?tab=menu", s.refresh);
  await page.getByRole("tab", { name: "Voice phrases" }).click();
  const row = page.getByTestId("voice-phrase");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("toofani");
  await expect(row).toContainText("Chicken Tikka");
  await page.getByRole("button", { name: "Forget “toofani”" }).click();
  await page.getByRole("alertdialog", { name: "Forget “toofani”?" }).getByRole("button", { name: "Forget", exact: true }).click();
  await expect(page.getByText("Nothing learnt yet")).toBeVisible();
  expect(await aliases(request, s)).toEqual([]);
});

test("changing an unsure line's dish teaches it (with the option chosen); a cancelled sheet teaches nothing", async ({ page, request }) => {
  const { s } = await seedChicken(request);
  await fakeSpeech(page);
  await openMenuPos(page, s);
  let puts = 0;
  page.on("request", (r) => { if (r.url().includes("/menu/voice-aliases") && r.method() === "PUT") puts++; });

  await mic(page).click();
  const dlg = page.getByRole("dialog", { name: "Listening" });
  await say(page, "final", "ek chicken");
  // several dishes fit: a default is picked (Check + Change), never a block (owner rule 2026-11, docs/VOICE_QA_REPORT.md)
  await expect(dlg.getByText(/picked for you/)).toBeVisible();
  await dlg.getByRole("button", { name: "Stop", exact: true }).click();
  const chk = page.getByRole("dialog", { name: "Check the order" });
  await expect(chk.getByRole("button", { name: /^Add to order/ })).toBeEnabled();
  await pick(chk.getByRole("combobox", { name: "Which dish for “ek chicken”" }), "Chicken Karahi");
  await chk.getByRole("button", { name: "Cancel" }).click();
  await expect(chk).toBeHidden();

  await mic(page).click();
  await say(page, "final", "ek chicken");
  await pick(dlg.getByRole("combobox", { name: "Which dish for “ek chicken”" }), "Chicken Karahi");
  await dlg.getByRole("button", { name: /^Change to Large/ }).click();
  expect(puts).toBe(0);
  const put = learnt(page);
  await dlg.getByRole("button", { name: /^Add to order/ }).click();
  await expect(page.getByText(/1 item added to/)).toBeVisible();
  await put;
  expect(puts).toBe(1);
  expect((await aliases(request, s)).map((a) => [a.phrase, a.item_name, a.variant_name])).toEqual([["chicken", "Chicken Karahi", "Large"]]);

  await mic(page).click();
  await say(page, "final", "do chicken");
  const line = dlg.getByTestId("voice-line");
  await expect(line).toHaveCount(1);
  await expect(line).toContainText("Chicken Karahi · Large");
  await expect(dlg.getByText(/not sure about this dish|Which dish\?/)).toHaveCount(0);
});

test("learnt phrases work offline from the cached menu, and learning offline is skipped quietly", async ({ page, context, request }) => {
  const { s, tikka } = await seedChicken(request);
  const r = await request.put(`${API}/menu/voice-aliases`, { headers: s.auth, data: { phrase: "murgi", menu_item_id: tikka.id, variant_id: null } });
  expect(r.status()).toBe(200);
  await fakeSpeech(page);
  // this device has Chrome's on-device English model, so live listening works without the internet
  await page.addInitScript(() => {
    const C = (window as unknown as { SpeechRecognition?: { available?: unknown } }).SpeechRecognition;
    if (C) C.available = async () => "available";
  });
  await openMenuPos(page, s, { sw: true });
  let puts = 0;
  page.on("request", (q) => { if (q.url().includes("/menu/voice-aliases") && q.method() === "PUT") puts++; });

  await context.setOffline(true);
  await page.reload(); // app restart while offline: menu and phrases come from the device
  await expect(page.getByTestId("stale-banner")).toBeVisible();
  await page.getByRole("button", { name: /^Voice order/ }).click({ force: true });
  const dlg = page.getByRole("dialog", { name: "Listening" });
  await say(page, "final", "ek murgi, do paneer");
  await expect(dlg.getByTestId("voice-line")).toHaveCount(1);
  await expect(dlg.getByTestId("voice-line")).toContainText("Chicken Tikka");
  await dlg.getByLabel("Pick a dish for “do paneer”").selectOption(s.items["Lamb Karahi"].id);
  await dlg.getByRole("button", { name: /^Add to order/ }).click();
  await expect(page.getByText(/2 items added to/)).toBeVisible();
  await expect(page.getByText(/could not|failed/i)).toHaveCount(0);
  expect(puts).toBe(0);
  await context.setOffline(false);
  expect((await aliases(request, s)).map((a) => a.phrase)).toEqual(["murgi"]);
});

/** Change on a voice line: the select's option for that dish. */
async function pick(sel: import("@playwright/test").Locator, dish: string) {
  const v = await sel.locator("option", { hasText: dish }).first().getAttribute("value");
  await sel.selectOption(v!);
}
