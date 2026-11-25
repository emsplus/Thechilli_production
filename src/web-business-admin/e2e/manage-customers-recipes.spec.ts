import { expect, test } from "@playwright/test";
import { API, openAs, seedMenu } from "./helpers";

test("customers live in Manage: add by phone only, search, edit, and /customers sends the owner there", async ({ page, request }) => {
  const s = await seedMenu(request);
  await openAs(page, s.token, "/manage?tab=customers", s.refresh);
  await page.getByRole("button", { name: "New customer" }).first().click();
  await page.getByLabel(/^Phone/).fill("098765 00555");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByRole("button", { name: /\+919876500555/ })).toBeVisible(); // nameless: shown by phone
  await page.getByLabel("Search customers").fill("500555");
  await page.getByRole("button", { name: /\+919876500555/ }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Zara Malik");
  await page.getByLabel(/^Notes/).fill("Likes it spicy");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Likes it spicy")).toBeVisible();
  const list = await (await request.get(`${API}/customers`, { headers: s.auth })).json();
  expect(list[0]).toMatchObject({ name: "Zara Malik", phone: "+919876500555", notes: "Likes it spicy" });
  await page.goto("/customers");
  await expect(page).toHaveURL(/\/manage\?tab=customers/);
});

test("recipes: work through the dishes without a recipe, copy one, see what one sale uses", async ({ page, request }) => {
  const s = await seedMenu(request);
  const mk = async (name: string, unit: string) => (await (await request.post(`${API}/inventory/items`, { headers: s.auth, data: { name, base_unit: unit, reorder_level: "0" } })).json()) as { id: string };
  const chicken = await mk("Chicken", "g"); await mk("Oil", "ml");
  await request.post(`${API}/inventory/adjustments`, { headers: s.auth, data: { idempotency_key: crypto.randomUUID(), item_id: chicken.id, kind: "adjustment", quantity: "5", unit: "kg", reason: "opening" } });
  await openAs(page, s.token, "/manage?tab=recipes", s.refresh);
  await expect(page.getByText("4 of 4 have no recipe")).toBeVisible();
  await page.getByRole("button", { name: /Start with the first/ }).click();
  await page.getByLabel("Ingredient 1", { exact: true }).selectOption({ label: "Chicken" });
  await page.getByLabel("Unit 1", { exact: true }).selectOption("kg");
  await page.getByLabel("Quantity 1", { exact: true }).fill("0.15");
  await page.getByLabel("Quantity 1", { exact: true }).press("Enter"); // Enter on a filled last row adds the next one
  await expect(page.getByLabel("Ingredient 2", { exact: true })).toBeFocused();
  await expect(page.getByText("1 sold uses")).toBeVisible();
  await expect(page.getByText("150 g").first()).toBeVisible();
  await page.getByLabel("Ingredient 2", { exact: true }).selectOption({ label: "Oil" });
  await page.getByLabel("Quantity 2", { exact: true }).fill("20");
  await page.getByRole("button", { name: "Save recipe" }).click();
  // saving moves on to the next dish that has no recipe; copy the first one into it
  await expect(page.getByText("Recipe saved as version 1")).toBeVisible();
  await page.getByLabel("Copy recipe from another dish").selectOption({ index: 1 });
  await expect(page.getByLabel("Quantity 1", { exact: true })).toHaveValue("150");
  await expect(page.getByLabel("Unit 1", { exact: true })).toHaveValue("g");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page.getByText(/Next dish without a recipe \(2 left\)/)).toBeVisible();
});

test("invoice review: Check summary, flagged lines and the sticky confirm bar say what is missing", async ({ page, request }) => {
  const s = await seedMenu(request);
  const up = await request.post(`${API}/purchases`, { headers: s.auth, multipart: { file: { name: "i.pdf", mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4 ${Math.random()}`) } } });
  const id = (await up.json()).id as string;
  await expect.poll(async () => (await (await request.get(`${API}/purchases/${id}`, { headers: s.auth })).json()).status, { timeout: 20_000 }).toBe("failed");
  const put = await request.put(`${API}/purchases/${id}`, { headers: s.auth, data: { supplier_id: null, invoice_number: "A-1", invoice_date: "2026-10-20", document_type: "stock_purchase", lines: [
    { description: "BASMATI RICE", quantity: "20", unit: "kg", unit_price: "2.00", line_total: "40.00", vat_rate: "0" },
    { description: "MYSTERY SAUCE", quantity: "3", unit: "case", unit_price: "5.00", line_total: "15.00", needs_check: true, check_reason: "No pack size found" },
  ] } });
  expect(put.status()).toBe(200);
  await openAs(page, s.token, `/manage?tab=suppliers&view=invoices&invoice=${id}`, s.refresh);
  const check = page.getByRole("region", { name: "Check" });
  await expect(check.getByText("Lines read")).toBeVisible();
  await expect(check.getByText("Need attention")).toBeVisible();
  const bar = page.getByRole("region", { name: "Total and confirm" });
  await expect(bar.getByText(/To confirm:/)).toContainText("choose a supplier");
  await expect(bar.getByRole("button", { name: "Confirm & add to stock" })).toBeDisabled();
  await check.getByRole("button", { name: /first line to check/ }).click();
  await expect(page.locator("#invoice-line-0")).toHaveAttribute("data-attention", "block");
});

test("menu: a new dish gets its recipe in the same dialog, and selling it takes stock down", async ({ page, request }) => {
  const s = await seedMenu(request);
  const chicken = (await (await request.post(`${API}/inventory/items`, { headers: s.auth, data: { name: "Chicken", base_unit: "g", reorder_level: "0" } })).json()) as { id: string };
  await request.post(`${API}/inventory/adjustments`, { headers: s.auth, data: { idempotency_key: crypto.randomUUID(), item_id: chicken.id, kind: "adjustment", quantity: "5", unit: "kg", reason: "opening" } });
  await openAs(page, s.token, "/manage?tab=menu", s.refresh);
  await page.getByRole("button", { name: "Add item" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Chicken Wrap");
  await dialog.getByLabel("Category").selectOption({ index: 1 });
  await dialog.getByLabel(/^Price/).fill("6.50");
  await dialog.getByLabel("Recipe ingredient 1", { exact: true }).selectOption({ label: "Chicken" });
  await dialog.getByLabel("Recipe unit 1", { exact: true }).selectOption("kg");
  await dialog.getByLabel("Recipe quantity 1", { exact: true }).fill("0.15");
  await dialog.getByRole("button", { name: "Add item" }).click();
  await expect(dialog).toHaveCount(0);

  const dish = ((await (await request.get(`${API}/menu/items`, { headers: s.auth })).json()) as { id: string; name: string }[]).find((i) => i.name === "Chicken Wrap")!;
  const recipes = (await (await request.get(`${API}/recipes`, { headers: s.auth })).json()) as { menu_item_id: string; ingredients: { item_id: string; quantity: string }[] }[];
  const rec = recipes.find((r) => r.menu_item_id === dish.id)!;
  expect(rec.ingredients.map((g) => [g.item_id, Number(g.quantity)])).toEqual([[chicken.id, 150]]);

  // sell 2 -> 300 g leaves stock
  const o = await (await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "takeaway", table_id: null, lines: [{ item_id: dish.id, quantity: 2 }] } })).json();
  expect((await request.post(`${API}/orders/${o.id}/bill`, { headers: s.auth, data: {} })).status()).toBe(201);
  const stock = (await (await request.get(`${API}/inventory/items`, { headers: s.auth })).json()) as { id: string; balance: string }[];
  expect(Number(stock.find((i) => i.id === chicken.id)!.balance)).toBe(4700);

  // editing shows the saved recipe; saving without touching it does not create a new version
  await page.reload();
  await page.getByRole("button", { name: "Edit Chicken Wrap" }).click();
  await expect(dialog.getByLabel("Recipe quantity 1", { exact: true })).toHaveValue("150");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toHaveCount(0);
  const again = ((await (await request.get(`${API}/recipes`, { headers: s.auth })).json()) as { menu_item_id: string; version: number }[]).find((r) => r.menu_item_id === dish.id)!;
  expect(again.version).toBe(1);
});
