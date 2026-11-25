import { expect, test } from "@playwright/test";
import { API, openAs, seedIn } from "./helpers";

// Visual sweep for the page-by-page comparison with the original Karahi POS (only runs with SHOT_DIR). Also checks the
// one-visible-title rule: the page's own h1 is for screen readers when the top bar already names the page.
const PAGES = ["/manage", "/orders", "/reservations", "/customers", "/reports", "/cash", "/end-of-day",
  "/manage?tab=menu", "/manage?tab=tables", "/manage?tab=customers", "/manage?tab=recipes", "/manage?tab=inventory", "/manage?tab=suppliers",
  "/manage?tab=staff", "/manage?tab=restaurant", "/manage?tab=printers", "/manage?tab=system"];

test("one visible page title on shell pages (top bar), h1 kept for screen readers", async ({ page, request }) => {
  const s = await seedIn(request);
  await page.setViewportSize({ width: 1470, height: 790 });
  await openAs(page, s.token, "/cash", s.refresh);
  const h1 = page.getByRole("heading", { level: 1, name: "Cash drawer" });
  await expect(h1).toHaveCount(1);
  const box = await h1.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(1); // visually hidden
  await expect(page.getByText("Cash drawer", { exact: true }).first()).toBeVisible(); // top bar
});

test("screenshots of every business page at 1470 x 790", async ({ page, request }) => {
  test.skip(!process.env.SHOT_DIR, "screenshots only");
  const s = await seedIn(request);
  await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "takeaway", lines: [{ item_id: s.itemId, quantity: 2 }] } });
  await page.setViewportSize({ width: 1470, height: 790 });
  await openAs(page, s.token, "/manage", s.refresh);
  for (const p of PAGES) {
    await page.goto(p);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${process.env.SHOT_DIR}/page${p.replace(/[/?=&]/g, "_")}.png` });
  }
});
