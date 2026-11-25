import { expect, test, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { API, openAs, seedMenu, type MenuSeed } from "./helpers";

// The e2e API never uses a real mailbox: start-api.sh blanks SMTP_* and sets EMAIL_SINK_DIR, so a "sent" email is a JSON file here.
const SINK = `/tmp/pos-e2e-mail-${process.env.E2E_API_PORT ?? "8120"}`;
const sunk = () => (existsSync(SINK) ? readdirSync(SINK).map((f) => JSON.parse(readFileSync(`${SINK}/${f}`, "utf8")) as { to: string; subject: string; text: string }) : []);

const post = async <T,>(request: APIRequestContext, s: MenuSeed, path: string, data: unknown): Promise<T> => {
  const r = await request.post(`${API}${path}`, { headers: s.auth, data });
  expect(r.ok(), `${path}: ${await r.text()}`).toBe(true);
  return r.json() as Promise<T>;
};

test("supplier with phone and email, invoice links the item, a sale that runs it low emails the supplier, manual email", async ({ page, request }) => {
  const s = await seedMenu(request);
  const rice = await post<{ id: string }>(request, s, "/inventory/items", { name: "Basmati Rice", base_unit: "g", reorder_level: "1000" });
  await post(request, s, "/inventory/items", { name: "Sea Salt", base_unit: "g", reorder_level: "0" });
  await post(request, s, "/recipes", { menu_item_id: s.itemId, ingredients: [{ item_id: rice.id, quantity: "300", unit: "g" }] });

  // 1. The owner adds the supplier with phone + email + contact person.
  await openAs(page, s.token, "/manage?tab=suppliers", s.refresh);
  await page.getByRole("button", { name: "Add supplier" }).first().click();
  await page.getByLabel("Supplier name").fill("Karachi Wholesale");
  await page.getByLabel("Phone").fill("022 4000 1234");
  await page.getByLabel("Email", { exact: true }).fill("not-an-email");
  await page.getByLabel("Contact person").fill("Imran");
  await page.getByRole("button", { name: "Add supplier" }).last().click();
  await expect(page.getByText("Enter a valid email address")).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill("orders@karachi-wholesale.example.com");
  await page.getByRole("button", { name: "Add supplier" }).last().click();
  const row = page.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Edit Karachi Wholesale" }) });
  await expect(row).toContainText("+912240001234");
  await expect(row).toContainText("orders@karachi-wholesale.example.com");
  await expect(row).toContainText("Imran");
  const sup = ((await (await request.get(`${API}/suppliers`, { headers: s.auth })).json()) as { id: string; name: string; phone: string }[]).find((x) => x.name === "Karachi Wholesale")!;
  expect(sup.phone).toBe("+912240001234");

  // 2. A scanned invoice that is confirmed links the item to the supplier (OCR is off in e2e: the lines are typed in, like in the other specs).
  const up = await request.post(`${API}/purchases`, { headers: s.auth, multipart: { file: { name: "i.pdf", mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4 ${Math.random()}`) } } });
  const pid = (await up.json()).id as string;
  await expect.poll(async () => (await (await request.get(`${API}/purchases/${pid}`, { headers: s.auth })).json()).status, { timeout: 20_000 }).toBe("failed");
  const put = await request.put(`${API}/purchases/${pid}`, { headers: s.auth, data: { supplier_id: sup.id, invoice_number: "KW-1", invoice_date: "2026-10-20", document_type: "stock_purchase", lines: [
    { description: "Basmati rice 1.2kg", item_id: rice.id, quantity: "1.2", unit: "kg", unit_price: "2.00", line_total: "2.40", vat_rate: "0" }] } });
  expect(put.status()).toBe(200);
  expect((await request.post(`${API}/purchases/${pid}/confirm`, { headers: s.auth })).status()).toBe(200);
  await page.goto("/manage?tab=inventory");
  const riceRow = page.getByRole("listitem").filter({ hasText: "Basmati Rice" }).filter({ hasText: "Reorder at" });
  await expect(riceRow).toContainText("Usual supplier: Karachi Wholesale");

  // 3. One sale takes 300 g: 1.2 kg -> 900 g, at or below the 1 kg reorder level -> the supplier is emailed (in the background).
  const order = await post<{ id: string }>(request, s, "/orders", { client_uuid: randomUUID(), order_type: "takeaway", table_id: null, lines: [{ item_id: s.itemId, quantity: 1 }] });
  const billed = await request.post(`${API}/orders/${order.id}/bill`, { headers: s.auth, data: {} });
  expect(billed.ok()).toBe(true);
  await expect.poll(async () => ((await (await request.get(`${API}/supplier-emails`, { headers: s.auth })).json()) as { status: string }[])[0]?.status, { timeout: 20_000 }).toBe("sent");
  expect(sunk().filter((m) => m.to === "orders@karachi-wholesale.example.com" && m.subject === "Re-order request - Karahi Test - 1 item")).toHaveLength(1);

  await page.goto("/manage?tab=suppliers");
  const history = page.getByRole("region", { name: "Sent emails" });
  await expect(history.getByTestId("sent-email")).toHaveCount(1);
  await expect(history).toContainText("Re-order request - Karahi Test - 1 item");
  await expect(history).toContainText("Automatic");
  await expect(history).toContainText("Sent");
  await history.getByText("1 item · show email").click();
  await expect(history).toContainText("Hello Imran,");
  await expect(history).toContainText("Basmati Rice: current stock 900 g, please send 1.5 kg");

  // 4. Inventory shows it, and the manual dialog previews, lets the quantity be edited, adds a note and an item that is not low.
  await page.goto("/manage?tab=inventory");
  await expect(riceRow).toContainText("Supplier emailed");
  await riceRow.getByRole("button", { name: "Email supplier about Basmati Rice" }).click();
  const dlg = page.getByRole("dialog", { name: "Email supplier now" });
  await expect(dlg.getByTestId("reorder-to")).toHaveText("orders@karachi-wholesale.example.com");
  await expect(dlg.getByTestId("reorder-subject")).toHaveText("Re-order request - Karahi Test - 1 item");
  await dlg.getByLabel("Quantity of Basmati Rice").fill("3");
  await dlg.getByLabel("Unit of Basmati Rice").selectOption("kg");
  await dlg.getByLabel("Add another item").selectOption({ label: "Sea Salt (low)" });
  await dlg.getByLabel("Quantity of Sea Salt").fill("500");
  await dlg.getByLabel("Note for the supplier").fill("Deliver before 9am");
  await expect(dlg.getByTestId("reorder-subject")).toHaveText("Re-order request - Karahi Test - 2 items");
  await expect(dlg.getByTestId("reorder-body")).toContainText("Basmati Rice: current stock 900 g, please send 3 kg");
  await expect(dlg.getByTestId("reorder-body")).toContainText("Note: Deliver before 9am");
  await dlg.getByRole("button", { name: "Send email" }).click();
  await expect.poll(async () => ((await (await request.get(`${API}/supplier-emails`, { headers: s.auth })).json()) as { kind: string; status: string }[]).filter((e) => e.kind === "manual" && e.status === "sent").length, { timeout: 20_000 }).toBe(1);
  expect(sunk().some((m) => m.subject.endsWith("2 items") && m.text.includes("please send 3 kg") && m.text.includes("Sea Salt"))).toBe(true);
  await page.goto("/manage?tab=suppliers");
  await expect(page.getByRole("region", { name: "Sent emails" }).getByTestId("sent-email")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Sent emails" })).toContainText("Manual");
});

test("email settings: the switch and the window are saved, a supplier without an email cannot be emailed", async ({ page, request }) => {
  const s = await seedMenu(request);
  await post(request, s, "/suppliers", { name: "No Mail Ltd" });
  await openAs(page, s.token, "/manage?tab=suppliers", s.refresh);
  const sw = page.getByRole("switch", { name: /Email suppliers automatically/ });
  await expect(sw).toBeChecked();
  await sw.click();
  await page.getByLabel("At most one email per supplier every").selectOption({ label: "6 hours" });
  await expect.poll(async () => (await (await request.get(`${API}/email/settings`, { headers: s.auth })).json()) as { auto_enabled: boolean; window_hours: number }).toMatchObject({ auto_enabled: false, window_hours: 6 });
  await expect(page.getByRole("button", { name: /Email No Mail Ltd now/ })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("switch", { name: /Email suppliers automatically/ })).not.toBeChecked();
});

test("AI recipe drafts (mocked): bulk draft, review, create the missing stock item, edit, save one, save all", async ({ page, request }) => {
  const s = await seedMenu(request);
  const chicken = await post<{ id: string }>(request, s, "/inventory/items", { name: "Chicken", base_unit: "g", reorder_level: "0" });
  const oil = await post<{ id: string }>(request, s, "/inventory/items", { name: "Cooking Oil", base_unit: "ml", reorder_level: "0" });
  let calls = 0;
  await page.route("**/recipes/ai-draft", async (route) => {
    calls++;
    const ids = (route.request().postDataJSON() as { menu_item_ids: string[] }).menu_item_ids;
    await route.fulfill({ json: { stock_items: 2, drafts: ids.map((id, n) => ({
      menu_item_id: id, menu_item_name: `Dish ${n}`, warnings: n === 0 ? ["An ingredient that is not in your stock list was ignored"] : [],
      ingredients: [{ item_id: chicken.id, name: "Chicken", unit: "g", quantity: "300.000" }, { item_id: oil.id, name: "Cooking Oil", unit: "ml", quantity: "30.000" }],
      missing: n === 0 ? [{ name: "Kasuri Methi", base_unit: "g", quantity: "2.000" }] : [],
    })) } });
  });
  await openAs(page, s.token, "/manage?tab=recipes", s.refresh);
  const panel = page.getByTestId("recipe-ai-panel");
  await panel.getByRole("button", { name: /Draft recipes for dishes without one \(4\)/ }).click();
  await expect(panel.getByText("4 to review")).toBeVisible();
  expect(calls).toBe(1);
  await expect(panel.getByText("AI draft - check quantities")).toBeVisible();
  // nothing is saved by drafting
  expect(((await (await request.get(`${API}/recipes`, { headers: s.auth })).json()) as unknown[]).length).toBe(0);

  // the draft that names an ingredient we do not stock: create it (opening stock 0)
  await panel.getByRole("button", { name: "Create the missing stock items" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  await expect.poll(async () => ((await (await request.get(`${API}/inventory/items`, { headers: s.auth })).json()) as { name: string; balance: string }[]).find((i) => i.name === "Kasuri Methi")?.balance).toMatch(/^0(\.0+)?$/); // "0" or "0.000" depending on the server's balance scale

  // review one: edit a quantity, save it
  await panel.getByRole("button", { name: /Review the draft for Dish 0/ }).click();
  await expect(page.getByText("AI draft - check quantities").first()).toBeVisible();
  await expect(page.getByLabel("Quantity 1", { exact: true })).toHaveValue("300");
  await expect(page.getByLabel("Ingredient 3", { exact: true })).toHaveValue(/.+/); // Kasuri Methi became a row
  await page.getByLabel("Quantity 1", { exact: true }).fill("320");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page.getByText("Recipe saved as version 1")).toBeVisible();
  const saved = (await (await request.get(`${API}/recipes`, { headers: s.auth })).json()) as { ingredients: { item_id: string; quantity: string }[] }[];
  expect(saved).toHaveLength(1);
  expect(Number(saved[0].ingredients.find((g) => g.item_id === chicken.id)!.quantity)).toBe(320);

  // the rest in one go, after the confirmation
  await page.getByRole("button", { name: "All dishes" }).click();
  await page.getByRole("button", { name: /Save all drafts \(3\)/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save 3" }).click();
  await expect(page.getByText("3 recipes saved")).toBeVisible();
  expect(((await (await request.get(`${API}/recipes`, { headers: s.auth })).json()) as unknown[]).length).toBe(4);
});

test("AI recipe draft for one dish (mocked), and a restaurant without stock is told so", async ({ page, request }) => {
  const s = await seedMenu(request);
  await openAs(page, s.token, "/manage?tab=recipes", s.refresh);
  await expect(page.getByText("Add inventory items first")).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan a supplier bill" })).toBeVisible();
  await page.getByRole("button", { name: "Go to inventory" }).click();
  await expect(page).toHaveURL(/tab=inventory/);

  const flour = await post<{ id: string }>(request, s, "/inventory/items", { name: "Flour", base_unit: "g", reorder_level: "0" });
  await page.route("**/recipes/ai-draft", (route) => route.fulfill({ json: { stock_items: 1, drafts: [{
    menu_item_id: s.items["Garlic Naan"].id, menu_item_name: "Garlic Naan", warnings: [], missing: [], ingredients: [{ item_id: flour.id, name: "Flour", unit: "g", quantity: "90.000" }] }] } }));
  await page.goto("/manage?tab=recipes");
  await page.getByRole("button", { name: /Garlic Naan/ }).click();
  await page.getByRole("button", { name: "Suggest recipe with AI" }).click();
  await expect(page.getByText("AI draft - check quantities").first()).toBeVisible();
  await expect(page.getByLabel("Quantity 1", { exact: true })).toHaveValue("90");
  expect(((await (await request.get(`${API}/recipes`, { headers: s.auth })).json()) as unknown[]).length).toBe(0);
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page.getByText("Recipe saved as version 1")).toBeVisible();
});
