import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { API, openAs, seedMenu, type MenuSeed } from "./helpers";

/**
 * Invoices that carry pack x size (Natco / Khosla layouts), consumables, an expense bill and a wrong date. The e2e API has no
 * Gemini key, so the drafts are stored through PUT /purchases with exactly the line shape the OCR step produces (that
 * derivation itself is covered by tests/test_packs.py and tests/test_invoice_packs.py in the API suite).
 */

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


interface Item { id: string; name: string; base_unit: string; balance: string }
const items = async (request: APIRequestContext, s: MenuSeed) => (await (await request.get(`${API}/inventory/items`, { headers: s.auth })).json()) as Item[];

type PackJson = Record<string, unknown>;
const pack = (text: string, invoicedQty: string, invoicedPrice: string, extra: PackJson = {}): PackJson => ({
  status: "ok", text, count_total: null, measure: null, options: [], invoiced: { quantity: invoicedQty, unit: "", unit_price: invoicedPrice }, ...extra });

async function draft(request: APIRequestContext, s: MenuSeed, lines: Record<string, unknown>[], opts: { color: [number, number, number]; date?: string; doc?: string; number?: string }) {
  const up = await request.post(`${API}/purchases`, { headers: s.auth, multipart: { file: { name: "inv.png", mimeType: "image/png", buffer: makePng(opts.color) } } });
  expect(up.status()).toBe(202);
  const id = (await up.json()).id as string;
  await expect.poll(async () => (await (await request.get(`${API}/purchases/${id}`, { headers: s.auth })).json()).status, { timeout: 20_000 }).toBe("failed");
  const put = await request.put(`${API}/purchases/${id}`, { headers: s.auth, data: { supplier_id: null, invoice_number: opts.number ?? "316582", invoice_date: opts.date ?? "2026-10-20", document_type: opts.doc ?? "stock_purchase", lines } });
  expect(put.status(), await put.text()).toBe(200);
  return id;
}
const open = (page: Page, s: MenuSeed, id: string) => openAs(page, s.token, `/manage?tab=suppliers&view=invoices&invoice=${id}&from=inventory`, s.refresh);

test("Natco-style invoice: derived pack quantities, merge, consumable, bottles in pieces, a flagged line, then confirm", async ({ page, request }) => {
  const s = await seedMenu(request);
  const sup = await (await request.post(`${API}/suppliers`, { headers: s.auth, data: { name: "Natco Cash and Carry", trn: "27 aapfu 0939 f1zv" } })).json();
  expect(sup.trn).toBe("27AAPFU0939F1ZV");
  const ketchup = { description: "KTC TOMATO KETCHUP", quantity: "18", unit: "kg", unit_price: "0.8878", line_total: "15.98", item_code: "2727081", vat_code: "1", vat_rate: "0", pack: pack("2 cases x 2 x 4.5 kg", "2", "7.99") };
  const id = await draft(request, s, [
    { description: "TS COCONUT MILK 99p", quantity: "4.8", unit: "l", unit_price: "1.8729", line_total: "8.99", vat_code: "1", vat_rate: "0", pack: pack("1 case x 12 x 400 ml", "1", "8.99", { count_total: "12" }) },
    { description: "NATCO CHOPPED TOMATOES", quantity: "61.2", unit: "kg", unit_price: "1.0255", line_total: "62.76", vat_code: "1", vat_rate: "0", pack: pack("4 cases x 6 x 2.55 kg", "4", "15.69") },
    ketchup, { ...ketchup },
    { description: "LEO KESTREL BLUE CARRIER BAGS 11x17x21", quantity: "2000", unit: "pcs", unit_price: "0.018", line_total: "35.99", vat_code: "2", vat_rate: "18", pack: pack("1 case x 20 x 100 pcs", "1", "35.99") },
    { description: "Budweiser Beer Bottles 12x660ml", quantity: "7.92", unit: "l", unit_price: "2.9659", line_total: "23.49", pack: pack("1 case x 12 x 66 cl", "1", "23.49", { count_total: "12", pack_count: "12" }) },
    { description: "Corona Extra Beer Bottles 12x620ml", quantity: "1", unit: "case", unit_price: "23.99", line_total: "23.99", needs_check: true, check_reason: "The pack sizes disagree: 1 x 1 cl (pack columns) vs 12 x 620 ml (description). Check the invoice.",
      pack: pack("", "1", "23.99", { status: "uncertain", text: null, options: [
        { label: "1 x 1 cl (pack columns) = 0.01 l", quantity: "0.01", unit: "l" }, { label: "12 x 620 ml (description) = 7.44 l", quantity: "7.44", unit: "l", count_total: "12" }] }) },
  ], { color: [210, 40, 40] });
  await open(page, s, id);
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Natco Cash and Carry" });

  // the derivation is shown, with the way back to what is printed
  await expect(page.getByLabel("Derived quantity").nth(1)).toContainText("= 61.2 kg (4 cases x 6 x 2.55 kg)");
  await expect(page.getByLabel("Quantity, line 2")).toHaveValue("61.2");
  await expect(page.getByText("GST 18%")).toBeVisible();
  await expect(page.getByText("Code 2727081").first()).toBeVisible();
  // never silently confirmable: line 7 is flagged and Confirm says why
  const alert = page.getByRole("alert").filter({ hasText: "Check the quantity" });
  await expect(alert).toContainText("The pack sizes disagree");
  await expect(page.getByRole("button", { name: "Confirm & add to stock" })).toBeDisabled();

  // the same ketchup twice: one-click merge (never automatic)
  await expect(page.getByText("KTC TOMATO KETCHUP is listed 2 times with the same price.")).toBeVisible();
  await page.getByRole("button", { name: "Merge into one line" }).click();
  await expect(page.getByLabel("Description, line 5")).toHaveValue(/Budweiser/);
  await expect(page.getByLabel("Quantity, line 3")).toHaveValue("36");
  await expect(page.getByLabel("Inventory item, line 3")).toBeVisible();

  // carrier bags are packaging: leave out of stock, kept on the invoice
  await expect(page.getByLabel("Description, line 4")).toHaveValue(/CARRIER BAGS/);
  await page.getByRole("button", { name: /Looks like packaging or supplies/ }).click();
  await expect(page.getByText("Not added to stock. Kept on the invoice")).toBeVisible();

  await page.getByRole("button", { name: "Create all unmatched lines as new items" }).click();
  const dlg = page.getByRole("dialog", { name: "Create items from this invoice" });
  const rows = dlg.getByRole("list", { name: "Items to create" }).getByRole("listitem");
  await expect(rows).toHaveCount(5); // coconut milk, tomatoes, ketchup (merged), Budweiser, Corona; not the bags
  await expect(dlg.getByLabel("Name, row 3")).toHaveValue("Ktc Tomato Ketchup");
  await expect(dlg.getByLabel("Unit, row 1")).toHaveValue("ml");
  await expect(dlg.getByLabel("Unit, row 2")).toHaveValue("g");
  await expect(dlg.getByLabel("Unit, row 4")).toHaveValue("pcs"); // a case of bottles is counted in bottles
  await expect(rows.nth(3)).toContainText("12 bottles or cans per case");
  await expect(dlg.getByLabel("Unit, row 5")).toHaveValue("pcs");
  await dlg.getByRole("button", { name: "Create 5 items & map lines" }).click();
  await expect(dlg).toBeHidden();

  // Budweiser restated as 12 pieces (total unchanged); Corona still flagged until a human picks
  await expect(page.getByLabel("Quantity, line 5")).toHaveValue("12");
  await expect(page.getByLabel("Unit, line 5")).toHaveValue("pcs");
  await expect(page.getByLabel("Derived quantity").last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm & add to stock" })).toBeDisabled();
  await alert.getByRole("button", { name: /12 x 620 ml \(description\)/ }).click();
  await expect(page.getByLabel("Quantity, line 6")).toHaveValue("12");
  await expect(page.getByLabel("Unit, line 6")).toHaveValue("pcs");
  await expect(alert).toHaveCount(0);
  await expect(page.getByText("The lines add up to the invoice net")).toHaveCount(0); // no invoice net on a hand-built draft: no false "matches"

  await page.getByRole("button", { name: "Confirm & add to stock" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm & add to stock" }).click();
  await expect(page.getByRole("heading", { name: "Stock updated" })).toBeVisible();

  const got = Object.fromEntries((await items(request, s)).map((i) => [i.name, Number(i.balance)]));
  expect(got).toEqual({ "Ts Coconut Milk": 4800, "Natco Chopped Tomatoes": 61200, "Ktc Tomato Ketchup": 36000, "Budweiser Beer Bottles": 12, "Corona Extra Beer Bottles": 12 });
  const p = await (await request.get(`${API}/purchases/${id}`, { headers: s.auth })).json();
  expect(p.status).toBe("confirmed");
  expect(p.lines.find((l: { exclude_from_stock: boolean }) => l.exclude_from_stock).description).toContain("CARRIER BAGS");
  const lines = p.lines as { line_total: string }[];
  expect(lines.reduce((a, l) => a + Number(l.line_total), 0)).toBeCloseTo(8.99 + 62.76 + 31.96 + 35.99 + 23.49 + 23.99, 2); // money never changes, consumables included
  const tom = p.lines.find((l: { description: string }) => l.description.startsWith("NATCO"));
  expect(tom.pack.text).toBe("4 cases x 6 x 2.55 kg");
});

test("'Show as invoiced' hands the line back to the pack helper", async ({ page, request }) => {
  const s = await seedMenu(request);
  await request.post(`${API}/inventory/items`, { headers: s.auth, data: { name: "Chopped Tomatoes", base_unit: "g", reorder_level: "0" } });
  const id = await draft(request, s, [{ description: "NATCO CHOPPED TOMATOES", quantity: "61.2", unit: "kg", unit_price: "1.0255", line_total: "62.76", pack: pack("4 cases x 6 x 2.55 kg", "4", "15.69") }], { color: [10, 120, 60] });
  await open(page, s, id);
  await page.getByRole("button", { name: "Use Chopped Tomatoes?" }).click();
  await page.getByRole("button", { name: "Show as invoiced" }).click();
  await expect(page.getByLabel("Quantity, line 1")).toHaveValue("4");
  await expect(page.getByLabel("Unit, line 1")).toHaveValue("case");
  await expect(page.getByLabel("Unit price, line 1")).toHaveValue("15.69");
  const helper = page.getByRole("group", { name: "Pack size" });
  await expect(helper).toContainText("How much is in one case?");
  await helper.getByLabel("Quantity in one pack").fill("15.3");
  await helper.getByLabel("Unit of one pack").selectOption("kg");
  await expect(helper).toContainText("61.2 kg @ ₹1.0255");
  await expect(helper).toContainText("total ₹62.76 unchanged");
});

test("an expense bill is recorded as an expense: nothing posts to stock, double entry is refused", async ({ page, request }) => {
  const s = await seedMenu(request);
  const id = await draft(request, s, [{ description: "Broadband charges", quantity: "1", unit: "case", unit_price: "69.95", line_total: "69.95" }, { description: "Telephone charges", quantity: "1", unit: "case", unit_price: "0.34", line_total: "0.34" }],
    { color: [120, 20, 120], doc: "expense", number: "280949802/001/1026", date: "2026-10-08" });
  await open(page, s, id);
  // behaviour change: an expense document no longer hides its lines behind a panel; the choice is a radio and the lines stay editable
  await expect(page.getByRole("radio", { name: "Record as expense" })).toBeChecked();
  await expect(page.getByLabel("Quantity, line 1")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Confirm & add to stock" })).toHaveCount(0);
  await page.getByRole("button", { name: "Record as expense" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Record as expense" });
  await expect(dlg.getByLabel("Date")).toHaveValue("2026-10-08");
  await expect(dlg.getByLabel("Invoice number")).toHaveValue("280949802/001/1026");
  await dlg.getByLabel("From").fill("Airtel Business");
  await dlg.getByLabel("Category").selectOption("Telecom");
  await dlg.getByLabel("Net").fill("74.29");
  await dlg.getByLabel("GST", { exact: true }).fill("13.37");
  await expect(dlg).toContainText("₹87.66");
  await dlg.getByRole("button", { name: "Record expense" }).click();
  const table = page.getByRole("table", { name: "Expenses" });
  await expect(table).toContainText("Airtel Business");
  await expect(table).toContainText("87.66");
  expect(await items(request, s)).toEqual([]);
  expect(await (await request.get(`${API}/inventory/ledger`, { headers: s.auth })).json()).toEqual([]);
  const p = await (await request.get(`${API}/purchases/${id}`, { headers: s.auth })).json();
  expect(p.status).toBe("confirmed");
  expect(p.document_type).toBe("expense");
  // the same bill typed in again is a duplicate
  await page.getByRole("button", { name: "Add expense" }).click();
  const add = page.getByRole("dialog", { name: "Add expense" });
  await add.getByLabel("From").fill("airtel business"); // duplicate = same supplier (any case) + same invoice number
  await add.getByLabel("Invoice number").fill("280949802/001/1026");
  await add.getByLabel("Date").fill("2026-10-08");
  await add.getByLabel("Net").fill("74.29");
  await add.getByRole("button", { name: "Record expense" }).click();
  await expect(add.getByRole("alert")).toContainText("already recorded as an expense");
  await add.getByRole("button", { name: "Cancel" }).click();
  // open the filed invoice from the list: read-only, says expense
  await page.getByRole("button", { name: /Open invoice 280949802/ }).click();
  await expect(page.getByText("Recorded as an expense")).toBeVisible();
  await expect(page.getByLabel("Invoice number")).toBeDisabled();
});

test("a stock invoice can be switched to expense by hand, and back", async ({ page, request }) => {
  const s = await seedMenu(request);
  const id = await draft(request, s, [{ description: "Cleaning contract", quantity: "1", unit: "pcs", unit_price: "50", line_total: "50" }], { color: [30, 30, 200] });
  await open(page, s, id);
  await page.getByRole("radio", { name: "Record as expense" }).click();
  await expect(page.getByRole("radio", { name: "Record as expense" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Confirm & add to stock" })).toHaveCount(0);
  await page.getByRole("radio", { name: "Add to stock" }).click();
  await expect(page.getByRole("button", { name: "Confirm & add to stock" })).toBeVisible();
});

test("a day/month mix-up in the invoice date is flagged", async ({ page, request }) => {
  const s = await seedMenu(request);
  const id = await draft(request, s, [{ description: "Onions 25kg", quantity: "1", unit: "kg", unit_price: "10", line_total: "10" }], { color: [200, 200, 20], date: "2020-10-07" });
  await open(page, s, id);
  await expect(page.getByRole("alert").filter({ hasText: "days ago" })).toContainText("day/month/year");
  await page.getByLabel("Invoice date").fill("2099-01-01");
  await expect(page.getByRole("alert").filter({ hasText: "in the future" })).toBeVisible();
  const today = new Date().toISOString().slice(0, 10);
  await page.getByLabel("Invoice date").fill(today);
  await expect(page.getByRole("alert").filter({ hasText: /days ago|future/ })).toHaveCount(0);
});
