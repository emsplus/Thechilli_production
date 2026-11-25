import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, openAs, seedIn, type Seed } from "./helpers";

// Menu metadata (pos-service docs/MENU_META.md): the FSSAI food mark (veg / non-veg / egg / not marked) and a one-line
// description. Editor in Manage > Menu, the mark on counter cards, menu list and cart lines (text for screen readers, shape
// + colour), description as the card tooltip / secondary line, and the remembered "Veg only" chip at the counter.

async function axe(page: Page, scope?: string, skip: string[] = []) {
  await page.waitForTimeout(800); // colour scheme / route transitions settle first (axe would measure a half-faded colour)
  let b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]);
  if (scope) b = b.include(scope);
  // Active nav items (shell rail and the Manage rail) are brand colours outside this change: primary on primary-soft is
  // 4.1-4.2:1 at 14px (reported separately; the shell has its own sweep).
  for (const x of ["[aria-current=page]", ...skip]) b = b.exclude(x);
  const res = await b.analyze();
  return res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} ${n.html.slice(0, 160)} ${JSON.stringify(n.any[0]?.data ?? "")}`).join(" | ")}`);
}

async function menuOf(request: APIRequestContext, s: Seed) {
  return (await (await request.get(`${API}/menu/items`, { headers: s.auth })).json()) as { id: string; name: string; food_type: string | null; description: string | null }[];
}

/** Paneer Tikka (veg, described), Chicken Tikka (non-veg), Egg Curry (egg), Mineral Water (not marked). */
async function seedMarked(request: APIRequestContext) {
  const s = await seedIn(request);
  const patch = (id: string, data: object) => request.patch(`${API}/menu/items/${id}`, { headers: s.auth, data });
  expect((await patch(s.itemId, { food_type: "veg", description: "Cottage cheese cubes, tandoor-roasted with peppers and onion" })).status()).toBe(200);
  const add = async (name: string, price: string, extra: object) =>
    expect((await request.post(`${API}/menu/items`, { headers: s.auth, data: { category_id: s.catId, name, price, ...extra } })).status()).toBe(201);
  await add("Chicken Tikka", "320.00", { food_type: "non_veg" });
  await add("Egg Curry", "180.00", { food_type: "egg", description: "Boiled eggs in onion-tomato masala" });
  await add("Mineral Water", "20.00", {});
  return s;
}

test("item editor: choose the food mark and write a description, then clear them", async ({ page, request }) => {
  const s = await seedIn(request);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openAs(page, s.token, "/manage?tab=menu", s.refresh);
  await page.getByRole("button", { name: "Edit Paneer Tikka" }).first().click();
  const sheet = page.getByRole("dialog");
  const food = sheet.getByRole("group", { name: "Food type" });
  await expect(food.getByRole("radio", { name: "Not marked" })).toBeChecked(); // nothing is guessed
  for (const n of ["Veg", "Non-veg", "Egg"]) expect((await food.getByText(n, { exact: true }).locator("xpath=ancestor::label").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await food.getByRole("radio", { name: "Veg", exact: true }).check();
  const desc = sheet.getByRole("textbox", { name: /Description/ });
  await desc.fill("  Cottage cheese, tandoor-roasted\nwith peppers ");
  await expect(sheet.getByText(`${"Cottage cheese, tandoor-roasted with peppers".length} of 280 characters`)).toBeVisible();
  expect(await axe(page, "[role=dialog]"), "axe on the editor").toEqual([]);
  await sheet.screenshot({ path: test.info().outputPath("editor.png") });
  await sheet.getByRole("button", { name: "Save changes" }).click();
  await expect(sheet).toBeHidden();
  let it = (await menuOf(request, s))[0];
  expect([it.food_type, it.description]).toEqual(["veg", "Cottage cheese, tandoor-roasted with peppers"]);
  // shown in the menu list with the mark (spoken as "Veg") and the description
  await expect(page.locator("li", { hasText: "Paneer Tikka" }).first().locator("[data-food=veg]")).toBeVisible();
  await expect(page.getByText("Cottage cheese, tandoor-roasted with peppers").first()).toBeVisible();

  // too long: refused inline, nothing saved
  await page.getByRole("button", { name: "Edit Paneer Tikka" }).first().click();
  await expect(food.getByRole("radio", { name: "Veg", exact: true })).toBeChecked();
  await desc.fill("x".repeat(281));
  await sheet.getByRole("button", { name: "Save changes" }).click();
  await expect(sheet.getByText("Keep it to 280 characters")).toBeVisible();
  // clear both
  await desc.fill("");
  await food.getByRole("radio", { name: "Not marked" }).check();
  await sheet.getByRole("button", { name: "Save changes" }).click();
  await expect(sheet).toBeHidden();
  it = (await menuOf(request, s))[0];
  expect([it.food_type, it.description]).toEqual([null, null]);
});

let marked: Promise<Seed> | null = null; // one marked restaurant for the read-only checks (sign-ups are rate limited)
const markedSeed = (request: APIRequestContext) => (marked ??= seedMarked(request));

for (const size of [{ w: 1280, h: 800 }, { w: 360, h: 740 }]) {
  test.describe(`counter @${size.w}`, () => {
    if (size.w === 360) test.use({ hasTouch: true, isMobile: true });
    test(`marks on cards and cart lines, description tooltip, remembered Veg only @${size.w}`, async ({ page, request }) => {
      const s = await markedSeed(request);
      await page.setViewportSize({ width: size.w, height: size.h });
      await openAs(page, s.token, "/pos", s.refresh);
      const grid = page.getByTestId("menu-grid");
      const card = (n: string) => grid.getByRole("button", { name: new RegExp(`^${n},`) });
      // accessible names carry the mark in words (not colour only); unmarked dishes say nothing
      await expect(card("Paneer Tikka")).toHaveAccessibleName(/^Paneer Tikka, ₹250\.00, Veg, add to order/);
      await expect(card("Chicken Tikka")).toHaveAccessibleName(/^Chicken Tikka, ₹320\.00, Non-veg,/);
      await expect(card("Egg Curry")).toHaveAccessibleName(/^Egg Curry, ₹180\.00, Egg,/);
      await expect(card("Mineral Water")).toHaveAccessibleName(/^Mineral Water, ₹20\.00, add to order/);
      for (const [n, k] of [["Paneer Tikka", "veg"], ["Chicken Tikka", "nonveg"], ["Egg Curry", "egg"]]) await expect(card(n).locator(`[data-food=${k}]`)).toBeVisible();
      await expect(card("Mineral Water").locator("[data-food]")).toHaveCount(0);
      await expect(card("Paneer Tikka")).toHaveAttribute("title", /Cottage cheese cubes/);
      // the description never makes a card taller than its undescribed neighbour by more than a line
      const hs = await Promise.all(["Paneer Tikka", "Chicken Tikka"].map(async (n) => (await card(n).boundingBox())!.height));
      expect(Math.abs(hs[0] - hs[1])).toBeLessThanOrEqual(20);

      await page.screenshot({ path: test.info().outputPath(`counter-${size.w}.png`) });
      // one tap still adds the dish; the cart line shows the mark and says "Veg"
      await card("Paneer Tikka").click();
      if (size.w < 768) await page.getByRole("button", { name: "View order" }).click();
      const line = page.getByRole("list", { name: "Order items" }).getByRole("listitem").filter({ hasText: "Paneer Tikka" });
      await expect(line.locator("[data-food=veg]")).toBeVisible();
      await expect(line.getByText("Veg", { exact: true })).toBeAttached(); // sr-only word next to the mark
      await page.screenshot({ path: test.info().outputPath(`cart-${size.w}.png`) });
      if (size.w < 768) { await page.keyboard.press("Escape"); await expect(page.getByRole("dialog", { name: "Current order" })).toBeHidden(); }

      // Veg only: off by default, 44px, filters to veg dishes (egg and unmarked are not veg), remembered after a reload
      const chip = page.getByRole("button", { name: "Veg only" });
      await expect(chip).toHaveAttribute("aria-pressed", "false");
      const box = (await chip.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
      await chip.click();
      await expect(chip).toHaveAttribute("aria-pressed", "true");
      await expect(grid.getByRole("button", { name: /, add to order/ })).toHaveCount(1);
      await page.screenshot({ path: test.info().outputPath(`veg-only-${size.w}.png`) });
      await expect(card("Paneer Tikka")).toBeVisible();
      for (const scheme of ["light"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        // Not part of this change, reported separately: TotalsBlock's "Add discount" button sits directly in its <dl>
        // (definition-list), and the active open-order chip's "1 item · ₹" line was 3.4:1 in the (removed) dark mode (color-contrast).
        expect(await axe(page, undefined, ["[data-testid=totals]", "[role=tablist][aria-label='Open orders']"]), `axe /pos @${size.w} ${scheme}`).toEqual([]);
      }
      await page.reload();
      await expect(page.getByRole("button", { name: "Veg only" })).toHaveAttribute("aria-pressed", "true");
      await expect(card("Chicken Tikka")).toHaveCount(0);
      await page.getByRole("button", { name: "Veg only" }).click();
      await expect(card("Chicken Tikka")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    });
  });
}

test("no chip when nothing on the menu is marked", async ({ page, request }) => {
  const s = await seedIn(request);
  await openAs(page, s.token, "/pos", s.refresh);
  await expect(page.getByTestId("menu-grid").getByRole("button", { name: /^Paneer Tikka, ₹250\.00/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Veg only" })).toHaveCount(0);
});

test("manage menu list @360 and @1280, light only: axe clean with marks and descriptions", async ({ page, request }) => {
  const s = await markedSeed(request);
  for (const size of [{ w: 360, h: 740 }, { w: 1280, h: 800 }]) {
    await page.setViewportSize({ width: size.w, height: size.h });
    await openAs(page, s.token, "/manage?tab=menu", s.refresh);
    if (size.w < 640) await page.getByTestId("phone-menu-list").getByRole("button", { name: /^Mains/ }).click(); // collapsed by default
    await expect(page.locator("[data-food=egg]").first()).toBeVisible();
    for (const scheme of ["light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      // the page body only: the app shell has its own sweep (e2e/a11y-sweep.spec.ts)
      expect(await axe(page, "#main-content"), `axe /manage menu @${size.w} ${scheme}`).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`manage-${size.w}-${scheme}.png`) });
    }
  }
});
