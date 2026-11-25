import { expect, test } from "@playwright/test";
import { API, openAs, seedIn, type Seed } from "./helpers";

// The counter must fit the screen at every width / browser zoom: no page-level sideways scroll, the order panel (and its
// Place order button) fully on screen, the ticket queue scrolling inside its own box. Zoom is emulated by the CSS viewport a
// 1470 x 900 MacBook window has at 100 / 110 / 125 / 150 / 175 % (1470, 1336, 1176, 980, 840 css px wide).
const SIZES = [
  { w: 360, h: 740 }, { w: 768, h: 1024 }, { w: 840, h: 474 }, { w: 980, h: 553 }, { w: 1176, h: 664 }, { w: 1336, h: 755 },
  { w: 1470, h: 830 }, { w: 1470, h: 900 }, { w: 1920, h: 1080 }, { w: 2560, h: 1440 },
];
const SHOTS = process.env.SHOT_DIR;

let s: Seed;
test.beforeAll(async ({ request }) => {
  s = await seedIn(request);
  // 17 open tickets on the server (the owner's case): the overview ticket queue is long.
  for (let i = 0; i < 17; i++) {
    const r = await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "takeaway", lines: [{ item_id: s.itemId, quantity: 1 + (i % 3) }] } });
    expect(r.ok()).toBeTruthy();
  }
  for (const n of ["Dal Makhani", "Butter Naan", "Veg Biryani", "Masala Chai", "Gulab Jamun", "Chicken Tikka", "Jeera Rice"])
    await request.post(`${API}/menu/items`, { headers: s.auth, data: { category_id: s.catId, name: n, price: "180.00" } });
});

for (const size of SIZES) {
  test(`counter fits ${size.w}x${size.h}: no sideways scroll, order panel and Place order on screen`, async ({ page }) => {
    await page.setViewportSize({ width: size.w, height: size.h });
    await openAs(page, s.token, "/pos", s.refresh);
    await page.getByRole("button", { name: /^Paneer Tikka,/ }).first().click();
    await page.waitForTimeout(1200); // overview strip + queue load
    const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, iw: window.innerWidth }));
    expect(overflow.sw, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.iw);
    expect(overflow.bw, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.iw);
    if (size.w >= 768) {
      const panel = page.getByRole("complementary", { name: "Current order" });
      const pb = await panel.boundingBox();
      expect(pb && pb.x >= 0 && pb.x + pb.width <= size.w + 0.5, `panel ${JSON.stringify(pb)}`).toBeTruthy();
      const place = panel.getByRole("button", { name: /Place order/ });
      await expect(place).toBeVisible();
      const b = await place.boundingBox();
      expect(b && b.x >= 0 && b.x + b.width <= size.w + 0.5 && b.y >= 0 && b.y + b.height <= size.h + 0.5, `Place order ${JSON.stringify(b)}`).toBeTruthy();
      // really visible: not clipped by the panel nor covered by the bottom bar (the element at its centre is the button)
      const hit = await place.evaluate((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!top && el.contains(top); });
      expect(hit, "Place order is covered or clipped").toBe(true);
      // dish cards never giant: at most ~22rem wide
      const card = await page.getByTestId("menu-grid").locator("article").first().boundingBox();
      expect(card!.width).toBeLessThanOrEqual(360);
    } else {
      await expect(page.getByText(/Bill 1 · Not sent yet/).first()).toBeInViewport();
    }
    const queue = page.getByRole("list", { name: "Ticket queue" });
    if (await queue.isVisible()) {
      const q = await queue.boundingBox();
      expect(q!.x + q!.width).toBeLessThanOrEqual(size.w + 0.5);
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/pos-${size.w}x${size.h}.png` });
  });
}
