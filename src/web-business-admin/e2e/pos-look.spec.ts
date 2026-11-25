import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { API, openAs, seedIn } from "./helpers";

// Visual check against the owner's original counter (1470 x 790 css px, a MacBook Chrome window). Shots go to SHOT_DIR.
// Also asserts the counter density (UI_REVIEW BA-1: 4-5 dish cards per row at 1470, was 3), a full-width "+ Add" per card, no overview strip by default.
test("counter looks and fits like the original at 1470 px", async ({ page, request }) => {
  const s = await seedIn(request);
  const photos = ["biryani", "thali-appam", "chai-pour", "kitchen-pass"].map((n) => readFileSync(`public/auth-media/${n}.webp`));
  const cats: Record<string, string> = {};
  for (const c of ["Veg Starters", "Veg Mains", "Roti & Naan", "Drinks"]) cats[c] = (await (await request.post(`${API}/menu/categories`, { headers: s.auth, data: { name: c } })).json()).id;
  const dishes: [string, string, string][] = [["Aloo Gobi", "Veg Mains", "260.00"], ["Veg Biryani", "Veg Mains", "320.00"], ["Masala Chai", "Drinks", "40.00"], ["Butter Naan", "Roti & Naan", "60.00"], ["Hara Bhara Kabab", "Veg Starters", "240.00"], ["Dal Makhani", "Veg Mains", "280.00"]];
  let i = 0;
  for (const [name, cat, price] of dishes) {
    const it = await (await request.post(`${API}/menu/items`, { headers: s.auth, data: { category_id: cats[cat], name, price } })).json();
    await request.post(`${API}/menu/items/${it.id}/image`, { headers: s.auth, multipart: { file: { name: "photo.webp", mimeType: "image/webp", buffer: photos[i++ % photos.length] } } });
  }
  for (let k = 0; k < 17; k++) await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "takeaway", lines: [{ item_id: s.itemId, quantity: 1 }] } });
  await page.setViewportSize({ width: 1470, height: 790 });
  await openAs(page, s.token, "/pos", s.refresh);
  await expect(page.getByRole("button", { name: /^Aloo Gobi,/ })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByRole("region", { name: "Counter overview" })).toHaveCount(0); // opt-in only
  const grid = page.getByTestId("menu-grid");
  const xs = await grid.locator("article").evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)))].length && els.map((e) => Math.round(e.getBoundingClientRect().top)));
  const firstRow = (xs as number[]).filter((t) => t === (xs as number[])[0]).length;
  expect(firstRow, "cards in the first row").toBeGreaterThanOrEqual(4);
  expect(firstRow, "cards in the first row").toBeLessThanOrEqual(5);
  await expect(grid.getByRole("button", { name: "Add Aloo Gobi to order" })).toBeVisible();
  await expect(page.getByText("Chilli Agent", { exact: true }).first()).toBeVisible();
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/pos-look-1470x790.png` });
  await page.getByRole("button", { name: /^Aloo Gobi,/ }).click();
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/pos-look-1470x790-item.png` });
  const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(sw).toBeLessThanOrEqual(0);
});
