import { expect, test } from "@playwright/test";
import { API, openAs, seedIn } from "./helpers";

// Screenshots of the navigation (only with SHOT_DIR; SHOT_PREFIX = "before" / "after"): owner sidebar at 1280, Manage's inner navigation,
// a moved screen inside Manage, the phone bar and picker, and a cashier. docs/testing/SIMPLE_SIDEBAR_REPORT.md.
const P = process.env.SHOT_PREFIX ?? "after";
const dir = process.env.SHOT_DIR ?? "";

test("navigation screenshots", async ({ page, browser, baseURL, request }) => {
  test.skip(!dir, "screenshots only");
  const s = await seedIn(request);
  const shot = async (name: string) => { await page.waitForTimeout(2500); await page.screenshot({ path: `${dir}/${P}-${name}.png` }); };

  await page.setViewportSize({ width: 1280, height: 860 });
  await openAs(page, s.token, "/manage", s.refresh);
  await expect(page.getByRole("complementary", { name: "Primary" })).toBeVisible();
  await shot("owner-1280-sidebar-manage-overview");
  await page.goto("/manage?tab=inventory");
  await shot("owner-1280-inventory-tab");
  await page.goto("/reports");
  await shot("owner-1280-reports");
  await page.goto("/cash");
  await shot("owner-1280-cash-drawer");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/manage");
  await shot("owner-390-manage");
  await page.goto("/reports");
  await shot("owner-390-reports");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "More" }).click();
  await shot("owner-390-more-sheet");

  const email = `cashier-${Date.now()}@example.in`;
  expect((await request.post(`${API}/auth/users`, { headers: s.auth, data: { email, full_name: "Casey", password: "Samosa-and-chai-26", role: "cashier" } })).status()).toBe(201);
  const pair = await (await request.post(`${API}/auth/login`, { data: { email, password: "Samosa-and-chai-26" } })).json();
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1280, height: 860 } });
  const p2 = await ctx.newPage();
  await openAs(p2, pair.access_token, "/pos", pair.refresh_token);
  await expect(p2.getByRole("complementary", { name: "Primary" })).toBeVisible();
  await p2.waitForTimeout(2500);
  await p2.screenshot({ path: `${dir}/${P}-cashier-1280-pos.png` });
  await p2.goto(P === "after" ? "/cash" : "/cash");
  await p2.waitForTimeout(2500);
  await p2.screenshot({ path: `${dir}/${P}-cashier-1280-cash.png` });
  await ctx.close();
});
