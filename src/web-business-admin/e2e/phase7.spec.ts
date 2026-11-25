import { expect, test } from "@playwright/test";
import { API, openPos, seed, viaManage } from "./helpers";

test("reports are flagged incomplete while an offline sale is unsynced, and clear afterwards", async ({ page, context, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await context.setOffline(true);
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: /Place order/ }).click();
  await page.getByRole("button", { name: "Cash (offline)" }).click();
  await request.put(`${API}/menu/items/${s.itemId}`, { headers: s.auth, data: { category_id: s.catId, name: "Latte", price: "15.00" } });
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByText(/need attention/)).toBeVisible({ timeout: 30_000 }); // conflict stays unsynced

  await viaManage(page, "Reports"); // Reports is a Manage entry now
  await expect(page).toHaveURL(/\/reports$/);
  await expect(page.locator("[role=alert]").filter({ hasText: "Incomplete data" }).first()).toBeVisible({ timeout: 20_000 });

  await page.getByRole("link", { name: "Sync" }).first().click();
  await page.getByRole("button", { name: "Discard" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: /discard/i }).click(); // themed confirm dialog
  await viaManage(page, "Reports");
  await expect(page.getByText("Incomplete data")).toHaveCount(0, { timeout: 20_000 });
});

test("customer consent can be granted and withdrawn, history is kept", async ({ page, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await viaManage(page, "Customers");
  await page.getByRole("button", { name: "New customer" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Ali Hassan");
  await page.getByLabel(/^Phone/).fill("098765 04567");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByText("+919876504567")).toBeVisible();

  await page.getByRole("button", { name: /Ali Hassan/ }).click(); // opens the detail sheet
  const box = page.getByLabel(/whatsapp marketing/i);
  await expect(box).not.toBeChecked(); // no consent by default
  await box.click();
  await page.getByRole("button", { name: "Record consent" }).click(); // themed confirm dialog
  await expect(box).toBeChecked();
  await box.click();
  await page.getByRole("button", { name: "Withdraw consent" }).click();
  await expect(box).not.toBeChecked();

  const list = await (await request.get(`${API}/customers`, { headers: s.auth })).json();
  expect(list[0].consents[0]).toMatchObject({ channel: "whatsapp", granted: false });
});

test("AI page explains clearly when the assistant is unavailable", async ({ page, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await page.getByRole("button", { name: "AI assistant", exact: true }).click();
  await page.getByPlaceholder(/Ask about/).fill("sales yesterday?");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.locator("p[role=alert]")).toContainText(/not configured|AI provider/); // no GEMINI_API_KEY in e2e
  await expect(page.getByPlaceholder(/Ask about/)).toHaveValue("sales yesterday?"); // question is not lost
});
