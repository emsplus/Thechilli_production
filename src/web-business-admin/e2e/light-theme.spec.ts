import { expect, test } from "@playwright/test";
import { openAs, seed } from "./helpers";

// Light theme only: even on a dark-mode device the theme is light; no display/theme button anywhere, the AI assistant sits in the top bar (not in the side menu).
test.use({ colorScheme: "dark" }); // a dark-mode device still gets the light theme

test("login and POS stay light, with no theme button; AI is a top-bar button, not a menu entry", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message)); // e.g. a syntax error in the inline init script
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light only");
  await page.evaluate(() => localStorage.setItem("pos.theme", "dark"));       // a stale saved dark choice must not stick
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "Display settings" })).toHaveCount(0);

  const s = await seed(request);
  await openAs(page, s.token, "/pos", s.refresh);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgb(0, 0, 0)");
  await expect(page.getByRole("button", { name: "Display settings" })).toHaveCount(0);
  await expect(page.getByRole("navigation").getByRole("link", { name: /^AI$/ })).toHaveCount(0);
  await page.getByRole("button", { name: "AI assistant", exact: true }).click();
  await expect(page).toHaveURL(/\/pos$/); // a side panel over the page, not a page of its own
  await expect(page.getByRole("complementary", { name: "AI assistant" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("AI assistant opens as a side panel on any page, keeps the chat when closed, and /ai opens it too", async ({ page, request }) => {
  const s = await seed(request);
  await openAs(page, s.token, "/orders", s.refresh);
  const panel = page.getByRole("complementary", { name: "AI assistant" });
  await expect(panel).toHaveCount(0);                       // not even loaded until it is asked for
  const btn = page.getByRole("button", { name: "AI assistant", exact: true });
  await btn.click();
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(/\/orders$/);
  await panel.getByLabel("Your question").fill("sales yesterday?");
  await panel.getByRole("button", { name: "Ask" }).click();
  await expect(panel.locator("p[role=alert]")).toBeVisible(); // no AI key in e2e: the question stays in the box
  await panel.getByRole("button", { name: "Close AI assistant" }).click();
  await expect(panel).toBeHidden();
  await btn.click();
  await expect(panel.getByLabel("Your question")).toHaveValue("sales yesterday?");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await page.goto("/ai");                                    // an old link or bookmark
  await expect(page).toHaveURL(/\/pos$/);
  await expect(panel).toBeVisible();
});
