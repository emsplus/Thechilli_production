import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openAs, seedIn } from "./helpers";

// UI_REVIEW BA-22: an unknown URL is a friendly 404, never a redirect to /login.

test("signed out: a 404 page of its own with a sign-in link, the URL stays", async ({ page }) => {
  await page.goto("/this-page-does-not-exist");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.waitForTimeout(1500); // nothing redirects later either
  await expect(page).toHaveURL(/\/this-page-does-not-exist$/);
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  await expect(page.getByRole("complementary", { name: "Primary" })).toHaveCount(0); // no app chrome for a visitor
});

test("signed in: the 404 sits inside the app shell with a way home", async ({ page, request }) => {
  const s = await seedIn(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAs(page, s.token, "/this-page-does-not-exist", s.refresh);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Primary" })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/\/this-page-does-not-exist$/);
  const axe = await new AxeBuilder({ page }).include("#main-content").analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  await page.getByRole("link", { name: "Go to home" }).click();
  await expect(page).not.toHaveURL(/this-page-does-not-exist|\/login/);
});
