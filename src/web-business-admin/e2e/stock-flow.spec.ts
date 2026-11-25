import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { API, seed, signIn, type Seed } from "./helpers";

/** A valid solid-colour PNG, built in memory (no fixture files). */
function makePng(rgb: [number, number, number]): Buffer {
  const w = 64, h = 48;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function openAs(page: Page, s: Seed, path: string) {
  await signIn(page, s.token, s.refresh);
  await page.goto(path);
}

const post = async <T,>(request: APIRequestContext, s: Seed, path: string, data: unknown): Promise<T> => {
  const r = await request.post(`${API}${path}`, { headers: s.auth, data });
  expect(r.ok(), `${path}: ${await r.text()}`).toBe(true);
  return r.json() as Promise<T>;
};

test("invoice to stock: scan, review, confirm, then see where the stock came from", async ({ page, request }) => {
  const s = await seed(request);
  await post(request, s, "/inventory/items", { name: "Flour", base_unit: "g", reorder_level: "1000" });
  const milk = await post<{ id: string }>(request, s, "/inventory/items", { name: "Milk", base_unit: "ml", reorder_level: "500" });
  await post(request, s, "/suppliers", { name: "Al Noor Foodstuff" });
  // Milk has opening stock and is used by the Latte recipe, so one sale shows up in its ledger.
  await post(request, s, "/inventory/adjustments", { idempotency_key: randomUUID(), item_id: milk.id, kind: "adjustment", quantity: "5", unit: "l", reason: "opening stock" });
  await post(request, s, "/recipes", { menu_item_id: s.itemId, ingredients: [{ item_id: milk.id, quantity: "200", unit: "ml" }] });
  const order = await post<{ id: string }>(request, s, "/orders", { client_uuid: randomUUID(), order_type: "takeaway", table_id: null, lines: [{ item_id: s.itemId, quantity: 1 }] });
  const bill = await post<{ invoice_number: string }>(request, s, `/orders/${order.id}/bill`, {});

  await openAs(page, s, "/manage?tab=inventory");
  const flourRow = page.getByRole("listitem").filter({ hasText: "Flour" }).filter({ hasText: "Reorder at" });
  await expect(flourRow).toContainText("No deliveries recorded yet");
  await expect(page.getByRole("list", { name: "How invoices become stock" })).toContainText("Check the lines");

  // 1. Scan: the button is right on the Inventory tab. OCR is off in e2e, so the invoice lands as "failed" and we type the lines.
  await page.getByRole("button", { name: "Scan invoice", exact: true }).click();
  await expect(page).toHaveURL(/tab=suppliers&view=invoices&from=inventory/);
  await page.getByLabel("Invoice file").setInputFiles({ name: "an-2041.png", mimeType: "image/png", buffer: makePng([180, 90, 30]) });
  await expect(page.getByText("We could not read this invoice")).toBeVisible({ timeout: 30_000 });

  // 2. Review: fill the invoice by hand and map the line to Flour.
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Al Noor Foodstuff" });
  await page.getByLabel("Invoice number").fill("AN-2041");
  await page.getByRole("button", { name: "Add line", exact: true }).click();
  await page.getByLabel("Description, line 1").fill("Plain flour 25kg sack");
  await page.getByLabel("Inventory item, line 1").selectOption({ label: "Flour (g)" });
  await page.getByLabel("Unit, line 1").selectOption("kg");
  await page.getByLabel("Quantity, line 1").fill("25");
  await page.getByLabel("Unit price, line 1").fill("4");

  // 3. Confirm
  await page.getByRole("button", { name: "Confirm & add to stock" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm & add to stock" }).click();

  // 4. Stock updated: a clear result with before and after.
  await expect(page.getByRole("heading", { name: "Stock updated" })).toBeVisible();
  const added = page.getByRole("table", { name: "Stock added" }).getByRole("row").filter({ hasText: "Flour" });
  await expect(added).toContainText("+25 kg");
  await expect(added.getByRole("cell").nth(2)).toHaveText("0 g");
  await expect(added.getByRole("cell").nth(3)).toHaveText("25 kg");
  const purchases = (await (await request.get(`${API}/purchases`, { headers: s.auth })).json()) as { id: string; status: string; stock_added: { balance_after: string }[] }[];
  expect(purchases[0].status).toBe("confirmed");
  expect(Number(purchases[0].stock_added[0].balance_after)).toBe(25000);
  const invoiceId = purchases[0].id;

  await page.getByRole("button", { name: "View stock" }).click();
  await expect(page).toHaveURL(/tab=inventory&highlight=/);
  await expect(flourRow).toContainText("Last received: 25 kg · Al Noor Foodstuff · AN-2041");

  // The ledger names the invoice and links back to it.
  await page.getByRole("button", { name: "Ledger for Flour" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Purchase invoice AN-2041 · Al Noor Foodstuff")).toBeVisible();
  await expect(sheet.getByText("+25 kg")).toBeVisible();
  await sheet.getByRole("button", { name: "Open invoice AN-2041" }).click();
  await expect(page).toHaveURL(new RegExp(`invoice=${invoiceId}`));
  await expect(page.getByText("Stock added by this invoice")).toBeVisible();
  await expect(page.getByLabel("Invoice number")).toBeDisabled();
  await expect(page.getByLabel("Invoice number")).toHaveValue("AN-2041");

  // A sale shows its bill as the source of the milk that went out.
  await page.getByRole("link", { name: "Inventory", exact: true }).first().click();
  await page.getByRole("button", { name: "Ledger for Milk" }).click();
  await expect(page.getByRole("dialog").getByText(`Sold · bill ${bill.invoice_number}`)).toBeVisible();
  await page.getByRole("dialog").getByRole("radio", { name: "Sales" }).click();
  await expect(page.getByRole("dialog").getByText("opening stock")).toHaveCount(0);
});
