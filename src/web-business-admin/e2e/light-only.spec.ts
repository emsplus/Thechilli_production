import { expect, test } from "@playwright/test";

// Light theme only (owner decision 2026-11-01): a phone or browser set to dark still shows the light theme. Needs no API (public pages).
test.use({ colorScheme: "dark" });

const LIGHT_BG = "rgb(249, 250, 251)"; // --c-bg light (charcoal 50)

for (const path of ["/login"]) {
  test(`${path}: OS dark preference still renders the light theme, no theme toggle`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem("pos.theme", "dark"); } catch { /* ignore */ } }); // a returning user who once picked dark
    await page.goto(path);
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true); // the emulation is really on
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light only");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(LIGHT_BG);
    expect(await page.evaluate(() => getComputedStyle(document.body).color)).not.toBe("rgb(255, 255, 255)");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--c-bg").trim().toLowerCase())).toBe("#f9fafb");
    expect(await page.evaluate(() => localStorage.getItem("pos.theme"))).toBeNull(); // the stored 'dark' was cleared
    await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute("content", "light");
    await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#F9FAFB");
    await expect(page.locator('meta[name="theme-color"][media]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /theme|dark mode|light mode|appearance|display settings/i })).toHaveCount(0);
    await expect(page.getByRole("switch", { name: /theme|dark/i })).toHaveCount(0);
    await expect(page.locator('picture source[media*="prefers-color-scheme"]')).toHaveCount(0); // no dark logo swap
    expect(errors).toEqual([]);
  });
}
