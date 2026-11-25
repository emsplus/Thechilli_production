import { expect, test } from "@playwright/test";
import { API, openAs } from "./helpers";
import { call, seedActivity, seedInventory, type Id } from "./inventory-helpers";

// Recipes (Manage > Recipes): a recipe with ingredients, its cost from the last receipt, a new version, and a sale that uses stock.

test("recipe with ingredients: cost from the delivery rate, version 2 keeps history, a sale deducts the stock", async ({ page, request }) => {
  const s = await seedInventory(request);
  await seedActivity(request, s); // paneer was received at ₹320 / kg
  const dish = await call<Id>(request, s, "post", "/menu/items", { category_id: s.catId, name: "Paneer Butter Masala", price: "320" });
  await openAs(page, s.token, "/manage?tab=recipes", s.refresh);
  await expect(page.getByText("Paneer Tikka")).toBeVisible();
  await page.getByRole("button", { name: /Paneer Butter Masala/ }).click();

  await page.getByLabel("Ingredient 1", { exact: true }).selectOption({ label: "Paneer" });
  await page.getByLabel("Quantity 1", { exact: true }).fill("200");
  await page.getByLabel("Unit 1", { exact: true }).selectOption("g");
  await page.getByRole("button", { name: "Add ingredient" }).click();
  await page.getByLabel("Ingredient 2", { exact: true }).selectOption({ label: "Milk" });
  await page.getByLabel("Quantity 2", { exact: true }).fill("100");
  await page.getByLabel("Unit 2", { exact: true }).selectOption("ml");
  await expect(page.getByText("Consumption preview")).toBeVisible();
  // 200 g of paneer at ₹320 / kg = ₹64.00; milk has no recorded cost, so the gap is said out loud
  await expect(page.locator("p", { hasText: /Ingredient cost \(1 without a price\)/ })).toContainText("₹64.00");
  await page.getByRole("button", { name: /Save as version 1|Save recipe|Save as version/ }).click();
  await expect(page.getByRole("button", { name: /Version 1 · History/ })).toBeVisible();

  // change a quantity: saved as version 2, version 1 stays in the history
  await page.getByLabel("Quantity 1", { exact: true }).fill("250");
  await page.getByRole("button", { name: /Save as version 2/ }).click();
  await expect(page.getByRole("button", { name: /Version 2 · History/ })).toBeVisible();
  await page.getByRole("button", { name: /Version 2 · History/ }).click();
  const hist = page.getByRole("dialog");
  await expect(hist).toContainText("Paneer Butter Masala: recipe history");
  await expect(hist).toContainText("250");
  await expect(hist).toContainText("200");
  await page.keyboard.press("Escape");

  // one sale takes 250 g of paneer and 100 ml of milk out of stock (12 kg + 8 - 1 returned... read it from the API)
  const before = await (await request.get(`${API}/inventory/items`, { headers: s.auth })).json() as { id: string; balance: string }[];
  const paneerBefore = Number(before.find((i) => i.id === s.paneer)!.balance);
  const o = await call<{ id: string }>(request, s, "post", "/orders", { client_uuid: crypto.randomUUID(), order_type: "takeaway", table_id: null, lines: [{ item_id: dish.id, quantity: 1 }] });
  await call(request, s, "post", `/orders/${o.id}/bill`, {});
  const after = await (await request.get(`${API}/inventory/items`, { headers: s.auth })).json() as { id: string; balance: string }[];
  expect(paneerBefore - Number(after.find((i) => i.id === s.paneer)!.balance)).toBe(250);
});

test("AI recipe suggestion without a Gemini key: a plain message, the form stays usable", async ({ page, request }) => {
  const s = await seedInventory(request);
  await call<Id>(request, s, "post", "/menu/items", { category_id: s.catId, name: "Rice Kheer", price: "120" });
  await openAs(page, s.token, "/manage?tab=recipes", s.refresh);
  await page.getByRole("button", { name: /Rice Kheer/ }).click();
  await page.getByRole("button", { name: "Suggest recipe with AI" }).click();
  await page.waitForTimeout(2500);
  if (process.env.INVENTORY_SHOTS !== "0") await page.screenshot({ path: "docs/inventory-ui-shots/recipe-ai-off-1280-light.png", fullPage: true });
  await expect(page.getByText(/GEMINI|RuntimeError|Traceback/)).toHaveCount(0);
  await expect(page.getByText("AI suggestions are not switched on for this account. You can still do this by hand.")).toBeVisible();
  // manual entry still works
  await page.getByLabel("Ingredient 1", { exact: true }).selectOption({ label: "Milk" });
  await page.getByLabel("Quantity 1", { exact: true }).fill("200");
  await page.getByRole("button", { name: /Save as version 1|Save recipe/ }).click();
  await expect(page.getByRole("button", { name: /Version 1 · History/ })).toBeVisible();
});
