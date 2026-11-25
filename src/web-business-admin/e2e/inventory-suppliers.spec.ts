import { expect, test } from "@playwright/test";
import { API, openAs } from "./helpers";
import { makePng, seedActivity, seedInventory } from "./inventory-helpers";

// Suppliers and purchase invoices (Manage > Suppliers & Purchases) against the real API. OCR has no key here: the scan must say so and manual entry must work.

test("add and edit a supplier; archive hides it", async ({ page, request }) => {
  const s = await seedInventory(request);
  await openAs(page, s.token, "/manage?tab=suppliers", s.refresh);
  await expect(page.getByText("Sharma Dairy")).toBeVisible();
  await page.getByRole("button", { name: "Add supplier" }).click();
  await page.getByLabel("Supplier name").fill("Verma Masale");
  await page.getByLabel("Phone").fill("98765 43210");
  await page.getByLabel("Email", { exact: true }).fill("verma@example.in");
  await page.getByRole("dialog").getByRole("button", { name: /Add supplier|Save/ }).click();
  await expect(page.getByText("Verma Masale", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit Verma Masale" }).click();
  await page.getByLabel("Contact person").fill("Rajesh");
  await page.getByRole("dialog").getByRole("button", { name: /Save/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const list = (await (await request.get(`${API}/suppliers`, { headers: s.auth })).json()) as { name: string; contact_name: string | null; phone: string | null }[];
  expect(list.find((x) => x.name === "Verma Masale")).toMatchObject({ contact_name: "Rajesh", phone: "+919876543210" });
  await page.getByRole("button", { name: "Archive Verma Masale" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText("Verma Masale", { exact: true })).toHaveCount(0);
});

test("scan without OCR says so, manual entry adds the stock once; a bill already received on a GRN adds none", async ({ page, request }) => {
  const s = await seedInventory(request);
  await seedActivity(request, s); // GRN-000001: 8 kg paneer, supplier bill SD-7781
  await openAs(page, s.token, "/manage?tab=suppliers&view=invoices", s.refresh);
  await page.getByLabel("Invoice file").setInputFiles({ name: "sd-7781.png", mimeType: "image/png", buffer: makePng([200, 120, 40]) });
  await expect(page.getByText("We could not read this invoice")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/GEMINI|RuntimeError/)).toHaveCount(0); // the server's raw error text stays out of the page
  await expect(page.getByText("Automatic invoice reading is not switched on for this account")).toBeVisible();
  if (process.env.INVENTORY_SHOTS !== "0") await page.screenshot({ path: "docs/inventory-ui-shots/invoice-ocr-off-1280-light.png" });

  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Sharma Dairy" });
  await page.getByLabel("Invoice number").fill("SD-7781");
  await page.getByRole("button", { name: "Add line", exact: true }).click();
  await page.getByLabel("Description, line 1").fill("Paneer 8 kg");
  await page.getByLabel("Inventory item, line 1").selectOption({ label: "Paneer (g)" });
  await page.getByLabel("Unit, line 1").selectOption("kg");
  await page.getByLabel("Quantity, line 1").fill("8");
  await page.getByLabel("Unit price, line 1").fill("320");
  await page.getByRole("button", { name: "Confirm & add to stock" }).click();
  const confirmed = page.waitForResponse((r) => /\/purchases\/.+\/confirm/.test(r.url()) && r.request().method() === "POST");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm & add to stock" }).click();
  const res = await confirmed;
  expect(res.status()).toBe(200);

  const items = (await (await request.get(`${API}/inventory/items`, { headers: s.auth })).json()) as { id: string; balance: string }[];
  // 12 kg opening + 8 kg GRN - 1 kg returned - 0.3 kg sold (2 dishes x 150 g) = 18.7 kg; the bill for the same delivery must not add 8 kg again
  expect(Number(items.find((i) => i.id === s.paneer)!.balance)).toBe(18700);
  await expect(page.getByRole("heading", { name: "Bill saved, no stock added" })).toBeVisible();
  await expect(page.getByText(/already received on a goods receipt/)).toBeVisible();
});
