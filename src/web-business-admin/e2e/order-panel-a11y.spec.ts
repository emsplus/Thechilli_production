import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { API, openAs, seedIn } from "./helpers";

// The counter's new order states (table grid with live state, Half line with "Change to Full", note, kitchen-first guard,
// busy-table choice) at phone / tablet / desktop, light only: axe serious / critical = 0, no sideways page scroll,
// and every control in the order panel is at least 44 px. SHOTS_DIR=<dir> also saves screenshots.

const SIZES = [{ w: 390, h: 844, touch: true }, { w: 1024, h: 768, touch: true }, { w: 1470, h: 900, touch: false }, { w: 360, h: 740, touch: true }, { w: 1280, h: 800, touch: false }] as const;

async function check(page: Page, name: string) {
  const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect.soft(bad, `axe ${name}`).toEqual([]);
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no sideways scroll ${name}`).toBe(true);
  const small = await page.evaluate(() => {
    const root = document.querySelector('[aria-label="Current order"], [role="dialog"]') ?? document.body;
    return Array.from(root.querySelectorAll<HTMLElement>("button, [role=radio], select, input:not([type=hidden]):not([type=checkbox])"))
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 43.5 || r.height < 43.5) && !el.closest("[data-sonner-toaster]"); })
      .map((el) => `${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30)} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`);
  });
  expect.soft(small, `44px targets ${name}`).toEqual([]);
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/${name}.png` });
}

for (const size of SIZES) {
  for (const scheme of ["light"] as const) {
    test.describe(`${size.w}`, () => {
      if (size.touch) test.use({ hasTouch: true, isMobile: size.w < 768 });
      test(`order panel states @${size.w} ${scheme}`, async ({ page, request }) => {
        await page.setViewportSize({ width: size.w, height: size.h });
        await page.emulateMedia({ colorScheme: scheme });
        const s = await seedIn(request);
        const h = { headers: s.auth };
        await request.post(`${API}/menu/items`, { ...h, data: { category_id: s.catId, name: "Butter Chicken", price: "280.00", variants: [{ name: "Half", price_delta: "0.00" }, { name: "Full", price_delta: "180.00" }] } });
        await request.post(`${API}/menu/items`, { ...h, data: { category_id: s.catId, name: "Dal Makhani", price: "220.00" } });
        const ids: Record<string, string> = {};
        for (const label of ["AC1", "AC2", "T2", "T3", "T4", "T5", "G1"]) ids[label] = (await (await request.post(`${API}/tables`, { ...h, data: { label, area: label.startsWith("G") ? "outdoor" : "indoor", seats: 4 } })).json()).id;
        await request.post(`${API}/orders`, { ...h, data: { client_uuid: crypto.randomUUID(), order_type: "indoor", table_id: ids.T4, lines: [{ item_id: s.itemId, quantity: 2 }] } });
        await openAs(page, s.token, "/pos", s.refresh);
        const dish = (n: string) => page.getByRole("button", { name: new RegExp(`^${n},`) }).first();
        await expect(dish("Butter Chicken")).toBeVisible();
        await dish("Butter Chicken").click();
        await dish("Dal Makhani").click();
        await dish("Paneer Tikka").click();
        const phone = size.w < 768;
        if (phone) await page.getByRole("button", { name: /View order/ }).click();
        const root = phone ? page.getByRole("dialog", { name: "Current order" }) : page.getByRole("complementary", { name: "Current order" });
        await root.getByRole("button", { name: "Note for Dal Makhani" }).click();
        await page.getByRole("button", { name: "No onion" }).click();
        await page.getByRole("button", { name: "Save note" }).click();
        await root.getByRole("radio", { name: "Dine-in" }).click();
        await expect(root.getByRole("group", { name: "Table" })).toBeVisible();
        await page.waitForTimeout(400);
        await check(page, `${size.w}-${scheme}-1-tables`);
        await root.getByRole("button", { name: /^Table T4\b/ }).click();
        await expect(page.getByTestId("busy-table-choice")).toBeVisible();
        await page.waitForTimeout(300);
        await check(page, `${size.w}-${scheme}-2-busy-table`);
        await page.getByRole("button", { name: "Start a separate order" }).click();
        await expect(root.getByTestId("table-chosen")).toContainText("T4");
        await page.waitForTimeout(400);
        await check(page, `${size.w}-${scheme}-3-cart`);
        await root.getByRole("button", { name: /Place order/ }).click();
        await expect(root.getByRole("button", { name: "Make bill" })).toBeDisabled();
        await page.waitForTimeout(400);
        await check(page, `${size.w}-${scheme}-4-kitchen-first`);
      });
    });
  }
}
