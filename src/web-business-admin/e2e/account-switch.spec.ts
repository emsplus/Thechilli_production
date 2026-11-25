import { expect, test } from "@playwright/test";
import { bills, openPos, seed, signIn } from "./helpers";

test("offline sales never sync into a different restaurant after an account switch", async ({ page, context, request }) => {
  const a = await seed(request);
  const b = await seed(request);
  await openPos(page, a.token);

  await context.setOffline(true);
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: /Place order/ }).click();
  await page.getByRole("button", { name: "Cash (offline)" }).click();
  await expect(page.getByTestId("provisional")).toBeVisible();

  // Restaurant B signs in on the same device while A's sale is still queued.
  await signIn(context, b.token, b.refresh);
  await context.setOffline(false);
  await page.goto("/sync");
  await expect(page.getByText("Sales from another account are waiting")).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(2000);
  expect(await bills(request, b)).toHaveLength(0);
  expect(await bills(request, a)).toHaveLength(0);

  // A signs back in: the sale syncs into A, exactly once.
  await signIn(context, a.token, a.refresh);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(async () => (await bills(request, a)).length, { timeout: 30_000 }).toBe(1);
  expect(await bills(request, b)).toHaveLength(0);
});
