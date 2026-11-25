import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import menuJson from "../src/lib/__fixtures__/voice/demo_menu_44.json";
import type { MenuItem } from "../src/lib/types";
import { API, fakeSpeech, openAs, say, seedMenu, type MenuSeed } from "./helpers";

// Dish recognition on the till with the scripted recogniser and the full 44-dish demo menu (the seed's menu): Devanagari and
// Hinglish forms land on the right dish, a dish staff place by hand is learnt ON THIS DEVICE (works with the server copy
// blocked), and Manage > Menu > Voice phrases shows the suggested pronunciations (accept / edit / delete) and the device's lessons.

type Demo = { categories: { id: string; name: string }[]; items: (MenuItem & { food_type: string })[] };
const demo = menuJson as unknown as Demo;

async function seedDemo(request: APIRequestContext): Promise<MenuSeed & { ids: Record<string, string> }> {
  const s = await seedMenu(request, { serviceCharge: null });
  // only the demo menu: seedMenu's own four dishes (one is a second Garlic Naan) are archived
  for (const it of Object.values(s.items)) expect((await request.patch(`${API}/menu/items/${it.id}/active`, { headers: s.auth, data: { is_active: false } })).status()).toBe(200);
  const ids: Record<string, string> = {};
  for (const c of demo.categories) {
    const cat = await (await request.post(`${API}/menu/categories`, { headers: s.auth, data: { name: c.name } })).json();
    for (const it of demo.items.filter((i) => i.category_id === c.id)) {
      const r = await request.post(`${API}/menu/items`, { headers: s.auth, data: {
        category_id: cat.id, name: it.name, price: it.price, tax_kind: "hot_food", variants: it.variants.map((v) => ({ name: v.name, price_delta: v.price_delta })) } });
      expect(r.status(), it.name).toBe(201);
      ids[it.name] = (await r.json()).id;
    }
  }
  return { ...s, ids };
}

const mic = (page: Page) => page.getByRole("button", { name: "Voice order", exact: true });
async function openPos(page: Page, s: MenuSeed) {
  await openAs(page, s.token, "/pos", s.refresh);
  await expect(page.getByRole("button", { name: /^Butter Chicken,/ })).toBeVisible();
}
const lineTexts = async (page: Page) => (await page.getByRole("dialog", { name: "Listening" }).getByTestId("voice-line").allTextContents()).map((t) => t.replace(/\s+/g, " "));

test("Devanagari and Hinglish dish names on the 44-dish menu: right dishes, right sizes, no cross-dish confusion", async ({ page, request }) => {
  test.setTimeout(240_000);
  const s = await seedDemo(request);
  await fakeSpeech(page);
  await openPos(page, s);
  const dlg = page.getByRole("dialog", { name: "Listening" });
  const cases: [string, string[]][] = [
    ["दो बटर चिकिन", ["Butter Chicken · Half"]],
    ["ek batar naan", ["Butter Naan"]],
    ["teen मीठी लस्सी", ["Sweet Lassi"]],
    ["golgappe", ["Pani Puri (6 pcs)"]],
    ["mutter paneer", ["Matar Paneer"]],
    ["फुल चिकन बिरयानी", ["Chicken Biryani · Full"]],
    ["पनीर टिक्का", ["Paneer Tikka"]],
    ["chiken tika", ["Chicken Tikka"]],
    ["तंदूरी रोटी", ["Tandoori Roti"]],
    ["jeera chawal", ["Jeera Rice"]],
    ["दाल मखनी", ["Dal Makhani"]],
    ["लहसुन नान", ["Garlic Naan"]],
  ];
  for (const [said, want] of cases) {
    await mic(page).click();
    await say(page, "final", said);
    await expect.poll(() => lineTexts(page), { message: said }).toHaveLength(want.length);
    const got = await lineTexts(page);
    want.forEach((w, i) => expect(got[i], said).toContain(w));
    await expect(dlg.getByTestId("voice-unmatched"), said).toHaveCount(0);
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toBeHidden();
  }
  // "chicken naan" names no dish of this menu: never Butter Chicken, left for staff
  await mic(page).click();
  await say(page, "final", "chicken naan");
  await expect(dlg.getByTestId("voice-unmatched")).toHaveCount(1);
  expect((await lineTexts(page)).join()).not.toContain("Butter Chicken");
});

test("a dish staff place by hand is learnt on this device (server copy blocked) and used next time; Voice phrases shows it", async ({ page, request }) => {
  test.setTimeout(180_000);
  const s = await seedDemo(request);
  await fakeSpeech(page);
  await page.route("**/menu/voice-aliases", (r) => (r.request().method() === "PUT" ? r.abort() : r.fallback()));
  await openPos(page, s);
  const dlg = page.getByRole("dialog", { name: "Listening" });

  await mic(page).click();
  await say(page, "final", "ek cutting wali chai");
  await expect(dlg.getByTestId("voice-unmatched")).toHaveCount(1);
  await dlg.getByLabel("Pick a dish for “ek cutting wali chai”").selectOption(s.ids["Masala Chai"]);
  const remember = dlg.getByTestId("voice-remember");
  await expect(remember).toContainText("Remember “ek cutting wali chai” as Masala Chai for next time");
  await expect(remember.getByRole("checkbox")).toBeChecked();
  await page.setViewportSize({ width: 1280, height: 900 });
  await dlg.screenshot({ path: "docs/voice-qa-shots/14-remember-dish.png" });
  await dlg.getByRole("button", { name: /^Add to order/ }).click();
  await expect(page.getByText(/1 item added to/).last()).toBeVisible();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("pos.dishLearned.v1") ?? "null"));
  expect(stored.items.map((x: { phrase: string; itemId: string }) => [x.phrase, x.itemId])).toEqual([["cutting chai", s.ids["Masala Chai"]]]);

  await mic(page).click();
  await say(page, "final", "do cutting chai");
  await expect.poll(() => lineTexts(page)).toHaveLength(1);
  expect((await lineTexts(page))[0]).toContain("Masala Chai");
  await expect(dlg.getByTestId("voice-unmatched")).toHaveCount(0);
  await expect(dlg.getByTestId("voice-remember")).toHaveCount(0); // a learnt phrase is not asked again
  await dlg.getByRole("button", { name: "Cancel" }).click();

  // unticking "Remember" teaches nothing
  await mic(page).click();
  await say(page, "final", "ek shahi platter");
  await dlg.getByLabel("Pick a dish for “ek shahi platter”").selectOption(s.ids["Veg Lunch Thali"]);
  await dlg.getByTestId("voice-remember").getByRole("checkbox").uncheck();
  await dlg.getByRole("button", { name: /^Add to order/ }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByText(/1 item added to/).last()).toBeVisible();
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem("pos.dishLearned.v1")!))).items).toHaveLength(1);

  await page.unroute("**/menu/voice-aliases");
  await page.goto("/manage?tab=menu");
  await page.getByRole("tab", { name: "Voice phrases" }).click();
  await expect(page.getByTestId("device-lesson")).toHaveCount(1);
  await expect(page.getByTestId("device-lesson")).toContainText("cutting chai");
  await expect(page.getByTestId("device-lesson")).toContainText("Masala Chai");
});

test("suggested pronunciations: generated for every dish, accept saves for every till, edit then save, delete hides; axe clean", async ({ page, request }) => {
  test.setTimeout(180_000);
  const s = await seedDemo(request);
  await openAs(page, s.token, "/manage?tab=menu", s.refresh);
  await page.getByRole("tab", { name: "Voice phrases" }).click();
  await expect(page.getByRole("heading", { name: "Suggested pronunciations" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search dishes" }).fill("butter chicken");
  const dish = page.getByTestId("suggest-dish").filter({ hasText: /^Butter Chicken/ });
  await expect(dish.getByTestId("suggestion").first()).toContainText("बटर चिकन");
  await expect(dish).toContainText("murgh makhani");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("heading", { name: "Suggested pronunciations" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "docs/voice-qa-shots/13-suggested-pronunciations.png" });

  // accept: saved as a learnt phrase for every till (server), gone from the suggestions
  const put = page.waitForResponse((r) => r.url().includes("/menu/voice-aliases") && r.request().method() === "PUT");
  await page.getByRole("button", { name: "Accept “murgh makhani” for Butter Chicken" }).click();
  expect((await put).status()).toBe(200);
  await expect(page.getByTestId("voice-phrase")).toContainText("murgh makhani");
  await expect(dish).not.toContainText("murgh makhani");

  // edit, then save
  await page.getByRole("button", { name: "Edit “batar chicken”" }).click();
  await page.getByLabel("Edit “batar chicken”").fill("batar chikan wala");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("voice-phrase").filter({ hasText: "batar chikan wala" })).toHaveCount(1);

  // delete: hidden on this device, nothing sent
  let puts = 0;
  page.on("request", (r) => { if (r.url().includes("/menu/voice-aliases") && r.method() === "PUT") puts++; });
  await page.getByRole("button", { name: "Delete “butter chikan” from the suggestions" }).click();
  await expect(dish).not.toContainText("butter chikan");
  expect(puts).toBe(0);
  await page.reload();
  await page.getByRole("tab", { name: "Voice phrases" }).click();
  await page.getByRole("searchbox", { name: "Search dishes" }).fill("butter chicken");
  await expect(page.getByTestId("suggest-dish").filter({ hasText: /^Butter Chicken/ })).not.toContainText("butter chikan");

  // every dish has suggestions (the list shows them all after "Show all")
  await page.getByRole("searchbox", { name: "Search dishes" }).fill("");
  await page.getByRole("button", { name: /^Show all \d+ dishes/ }).click();
  expect(await page.getByTestId("suggest-dish").count()).toBeGreaterThanOrEqual(44);

  const AxeBuilder = (await import("@axe-core/playwright")).default;
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
});
