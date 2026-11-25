import { expect, test, type Page } from "@playwright/test";
import { API, openAs, seedIn } from "./helpers";

// UI_REVIEW BA-1: a counter needs many dishes on screen. Auto-fill columns (3-4 at 1176 px, 5-6 at 1920 px), 4:3 photo
// capped at 130 px, and a category row whose clipped side always has a fade and an arrow.

async function perRow(page: Page) {
  const tops = await page.getByTestId("menu-grid").locator("article").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  return tops.filter((t) => t === tops[0]).length;
}

test("dish grid density and the category scroll cue", async ({ page, request }) => {
  const s = await seedIn(request);
  const names = ["Soups and Shorbas", "Veg Starters", "Non-Veg Starters", "Tandoor Specials", "Main Course Veg", "Main Course Non-Veg", "Biryani and Rice", "Breads and Rotis", "Desserts", "Hot Beverages", "Cold Beverages", "Combos"];
  let n = 0;
  for (const c of names) {
    const cat = (await (await request.post(`${API}/menu/categories`, { headers: s.auth, data: { name: c } })).json()).id;
    for (let k = 0; k < 2; k++) await request.post(`${API}/menu/items`, { headers: s.auth, data: { category_id: cat, name: `${c.split(" ")[0]} dish ${++n}`, price: `${100 + n * 10}.00` } });
  }
  for (const [w, h, min, max] of [[1176, 720, 3, 4], [1920, 1080, 5, 6], [1470, 900, 4, 5], [1024, 768, 2, 3]] as const) {
    await page.setViewportSize({ width: w, height: h });
    if (w === 1176) await openAs(page, s.token, "/pos", s.refresh); else await page.reload();
    await expect(page.getByRole("button", { name: /^Soups dish 1,/ })).toBeVisible();
    const cols = await perRow(page);
    expect(cols, `dishes per row at ${w}`).toBeGreaterThanOrEqual(min);
    expect(cols, `dishes per row at ${w}`).toBeLessThanOrEqual(max);
    const photo = await page.getByTestId("menu-grid").locator("article").first().locator("div.relative.isolate").boundingBox();
    expect(photo!.height, `photo height at ${w}`).toBeLessThanOrEqual(131);
    const card = await page.getByTestId("menu-grid").locator("article").first().boundingBox();
    expect(card!.height, `card height at ${w}`).toBeLessThanOrEqual(290);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  }

  // Category row at 1176: 13 chips overflow; the right side has the arrow, scrolling reveals the left one.
  await page.setViewportSize({ width: 1176, height: 720 });
  await page.reload();
  const cats = page.getByRole("radiogroup", { name: "Categories" });
  await expect(cats).toBeVisible();
  const right = page.getByTestId("pill-scroll-right");
  await expect(right).toBeVisible();
  expect((await right.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId("pill-scroll-left")).toHaveCount(0);
  expect(await cats.evaluate((el) => getComputedStyle(el).maskImage)).toContain("gradient");
  await right.click();
  await expect(page.getByTestId("pill-scroll-left")).toBeVisible();
  await expect.poll(() => cats.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
  // Keyboard: End moves to the last chip and scrolls it into view; the right arrow then goes away.
  await cats.getByRole("radio", { checked: true }).focus();
  await page.keyboard.press("End");
  await expect(cats.getByRole("radio").last()).toBeChecked();
  await expect(cats.getByRole("radio").last()).toBeInViewport();
  await expect(page.getByTestId("pill-scroll-right")).toHaveCount(0);
});
