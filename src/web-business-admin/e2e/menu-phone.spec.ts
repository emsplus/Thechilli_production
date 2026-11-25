import { expect, test } from "@playwright/test";
import { API, openAs, seedIn } from "./helpers";

// UI_REVIEW BA-5: the phone menu list must stay short and quick with 200+ dishes: sticky search, collapsed categories with
// counts, compact rows (small thumbnail), rows paged inside a category.
test("phone /manage menu: compact grouped list that copes with 210 dishes", async ({ page, request }) => {
  test.setTimeout(240_000);
  const s = await seedIn(request);
  const cats: string[] = [s.catId];
  for (const c of ["Starters", "Breads", "Drinks", "Desserts", "Rice", "Combos"]) cats.push((await (await request.post(`${API}/menu/categories`, { headers: s.auth, data: { name: c } })).json()).id);
  const add = (n: number) => request.post(`${API}/menu/items`, { headers: s.auth, data: { category_id: cats[n % cats.length], name: `Dish ${String(n).padStart(3, "0")}`, price: `${100 + n}.00` } });
  for (let n = 1; n < 210; n += 4) await Promise.all([n, n + 1, n + 2, n + 3].filter((k) => k < 210).map(add)); // 4 at a time: the API pool is small

  await page.setViewportSize({ width: 390, height: 844 });
  await openAs(page, s.token, "/manage?tab=menu", s.refresh);
  const list = page.getByTestId("phone-menu-list");
  await expect(list).toBeVisible();
  // collapsed by default: a short page however big the menu
  await expect(list.getByTestId("phone-menu-row")).toHaveCount(0);
  const h0 = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(h0, "page height with every category collapsed").toBeLessThan(2400);
  // open one category: 30 dishes, 25 rendered, then "Show more"
  const starters = list.getByRole("button", { name: /^Starters\s*30/ });
  await starters.click();
  await expect(starters).toHaveAttribute("aria-expanded", "true");
  await expect(list.getByTestId("phone-menu-row")).toHaveCount(25);
  const row = await list.getByTestId("phone-menu-row").first().boundingBox();
  expect(row!.height, "compact row").toBeLessThanOrEqual(72);
  await list.getByRole("button", { name: /^Show 5 more/ }).click();
  await expect(list.getByTestId("phone-menu-row")).toHaveCount(30);
  // actions are 44px targets with the dish name
  const edit = list.getByRole("button", { name: /^Edit Dish/ }).first();
  expect((await edit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // sticky search: still on screen after scrolling, and it opens the matching categories
  await page.mouse.wheel(0, 1500);
  const search = list.getByRole("searchbox", { name: "Search items" });
  await expect(search).toBeInViewport();
  await search.fill("Dish 20");
  await expect(list.getByTestId("phone-menu-row")).toHaveCount(10); // Dish 200-209
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
});
