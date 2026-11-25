import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openAs, seedIn } from "./helpers";

// UI_REVIEW item: the Pay flow must be findable by name and fit a phone (390x844) and a laptop (1366x768).
const inView = async (page: Page, name: string | RegExp, scope = page.getByRole("dialog", { name: "Take payment" })) => {
  const b = await scope.getByRole("button", { name }).boundingBox();
  const vp = page.viewportSize()!;
  expect(b, String(name)).toBeTruthy();
  expect(b!.x >= 0 && b!.y >= 0 && b!.x + b!.width <= vp.width + 0.5 && b!.y + b!.height <= vp.height + 0.5, `${name} ${JSON.stringify(b)} in ${JSON.stringify(vp)}`).toBe(true);
};

for (const [w, h] of [[1366, 768], [390, 844]] as const) {
  test(`pay flow at ${w}x${h}: named buttons, sheet fits the screen`, async ({ page, request }) => {
    const s = await seedIn(request);
    await page.setViewportSize({ width: w, height: h });
    await openAs(page, s.token, "/pos", s.refresh);
    await page.getByRole("button", { name: /^Paneer Tikka,/ }).first().click();
    if (w < 768) await page.getByRole("button", { name: "View order" }).click();
    await page.getByRole("button", { name: "Place order" }).click();
    await page.getByRole("button", { name: "Make bill" }).click();
    // one-tap buttons: "Pay cash ₹262.50" etc., grouped under "Pay ₹262.50"
    const row = page.getByRole("group", { name: /^Pay ₹/ });
    await expect(row).toBeVisible();
    for (const k of ["cash", "card", "UPI"]) {
      const b = row.getByRole("button", { name: new RegExp(`^Pay ${k} ₹[\\d,]+\\.\\d{2}$`, "i") });
      await expect(b).toBeVisible();
      expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    const other = page.getByRole("button", { name: "Other amount / split" });
    await expect(other).toHaveAttribute("aria-haspopup", "dialog");
    await other.click();
    const sheet = page.getByRole("dialog", { name: "Take payment" });
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(1000); // sheet slide-in (axe must not see it half transparent)
    const sb = await sheet.boundingBox();
    expect(sb!.x >= -0.5 && sb!.y >= -0.5 && sb!.x + sb!.width <= w + 0.5 && sb!.y + sb!.height <= h + 0.5, `sheet ${JSON.stringify(sb)}`).toBe(true);
    await inView(page, /^Confirm payment/);
    await expect(sheet.getByRole("radio", { name: /Cash/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(" ")} ${n.failureSummary ?? ""}`).join(" | ")}`)).toEqual([]);
    await sheet.getByRole("button", { name: /^Confirm payment/ }).click();
    await expect(page.getByRole("button", { name: "New order" })).toBeVisible();
  });
}
