import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { API, openAs, seedMenu, type MenuSeed } from "./helpers";

/**
 * Starting from an EMPTY stock list: create items from invoice lines, auto-match chips, pack-size conversion,
 * spreadsheet import, empty-state guidance. The e2e API has no Gemini key, so an uploaded invoice lands as "failed";
 * we then PUT the lines OCR would have produced (same API the review screen saves with) and open the review screen.
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

interface Line { description: string; quantity: string; unit: string; unit_price: string; item_id?: string | null }
interface Item { id: string; name: string; base_unit: string; balance: string; last_received: { invoice_number: string | null } | null }

const items = async (request: APIRequestContext, s: MenuSeed) => (await (await request.get(`${API}/inventory/items`, { headers: s.auth })).json()) as Item[];
const byName = async (request: APIRequestContext, s: MenuSeed, name: string) => (await items(request, s)).find((i) => i.name === name);

/** Uploads a PNG, waits for the (failed, no key) extraction, then stores OCR-like lines. Returns the invoice id. */
async function draftInvoice(request: APIRequestContext, s: MenuSeed, lines: Line[], opts: { color?: [number, number, number]; supplier?: string; number?: string } = {}) {
  const up = await request.post(`${API}/purchases`, { headers: s.auth, multipart: { file: { name: "inv.png", mimeType: "image/png", buffer: makePng(opts.color ?? [200, 120, 40]) } } });
  expect(up.status()).toBe(202);
  const id = (await up.json()).id as string;
  await expect.poll(async () => (await (await request.get(`${API}/purchases/${id}`, { headers: s.auth })).json()).status, { timeout: 20_000 }).toBe("failed");
  const put = await request.put(`${API}/purchases/${id}`, { headers: s.auth, data: { supplier_id: null, invoice_number: opts.number ?? "CC-1001", invoice_date: "2026-10-20",
    lines: lines.map((l) => ({ item_id: null, ...l })) } });
  expect(put.status(), await put.text()).toBe(200);
  return id;
}
const openInvoice = (page: Page, s: MenuSeed, id: string) => openAs(page, s.token, `/manage?tab=suppliers&view=invoices&invoice=${id}&from=inventory`, s.refresh);
const mkItem = async (request: APIRequestContext, s: MenuSeed, name: string, base_unit: string) => {
  const r = await request.post(`${API}/inventory/items`, { headers: s.auth, data: { name, base_unit, reorder_level: "0" } });
  expect(r.status()).toBe(201);
  return (await r.json()) as Item;
};

test("empty stock list: guidance card, calm recipe hint, no recipe badge until an item exists", async ({ page, request }) => {
  const s = await seedMenu(request); // 4 dishes without a recipe
  await openAs(page, s.token, "/manage", s.refresh);
  const card = page.getByRole("region", { name: "Start your stock list" });
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Scan a supplier invoice" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Import a spreadsheet" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Add items one by one" })).toBeVisible();
  await expect(page.getByText("dishes have no recipe")).toHaveCount(0);
  await expect(page.getByText("Recipes are optional: add them when you want sales to deduct stock automatically.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Manage sections" })).toBeVisible(); // the original Manage panel
  await expect(page.getByRole("link", { name: "Recipes" }).first()).toBeVisible();

  // The same card heads an empty Inventory tab; "Add items one by one" opens the add dialog.
  await page.goto("/manage?tab=inventory");
  await expect(page.getByRole("region", { name: "Start your stock list" })).toBeVisible();
  await page.getByRole("region", { name: "Start your stock list" }).getByRole("button", { name: "Add items one by one" }).click();
  await expect(page.getByRole("dialog", { name: "Add inventory item" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Once there is stock the card goes away and the recipe warning and badge return.
  await mkItem(request, s, "Milk", "ml");
  await page.goto("/manage");
  await expect(page.getByRole("region", { name: "Start your stock list" })).toHaveCount(0);
  await expect(page.getByText("4 dishes have no recipe")).toBeVisible();
});

test("create an item from one invoice line, then convert the pack size and undo", async ({ page, request }) => {
  const s = await seedMenu(request);
  const id = await draftInvoice(request, s, [{ description: "ONIONS 25kg sack", quantity: "2", unit: "sack", unit_price: "18.00" }]);
  await openInvoice(page, s, id);
  const sel = page.getByLabel("Inventory item, line 1");
  await expect(page.getByRole("button", { name: "Confirm & add to stock" })).toBeDisabled();
  await sel.selectOption({ label: "➕ Create new item from this line" });
  const dlg = page.getByRole("dialog", { name: "Create stock item" });
  await expect(dlg.getByLabel("Name")).toHaveValue("Onions");
  await expect(dlg.getByRole("radio", { name: "g", exact: true })).toHaveAttribute("aria-checked", "true"); // 25kg in the text, so counted in grams
  await dlg.getByLabel(/Reorder level/).fill("5000");
  await dlg.getByRole("button", { name: "Create & map line" }).click();
  await expect(dlg).toBeHidden();
  await expect(sel).toContainText("Onions (g)");
  const onions = (await byName(request, s, "Onions"))!;
  expect(onions.base_unit).toBe("g");
  expect(Number(onions.balance)).toBe(0);

  // "sack" cannot convert to grams: the helper asks, prefilled from "25kg".
  const pack = page.getByRole("group", { name: "Pack size" });
  await expect(pack).toContainText("How much is in one sack?");
  await expect(pack.getByLabel("Quantity in one pack")).toHaveValue("25");
  await expect(pack.getByLabel("Unit of one pack")).toHaveValue("kg");
  await expect(pack).toContainText("2 sack @ ₹18.00");
  await expect(pack).toContainText("50 kg @ ₹0.72");
  await expect(pack).toContainText("total ₹36.00 unchanged");
  await expect(page.getByRole("button", { name: "Confirm & add to stock" })).toBeDisabled();
  await pack.getByRole("button", { name: "Convert" }).click();
  await expect(pack).toBeHidden();
  await expect(page.getByLabel("Quantity, line 1")).toHaveValue("50");
  await expect(page.getByLabel("Unit, line 1")).toHaveValue("kg");
  await expect(page.getByLabel("Unit price, line 1")).toHaveValue("0.72");
  await expect(page.getByText("Converted from 2 sack @ ₹18.00 to 50 kg @ ₹0.72")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByLabel("Quantity, line 1")).toHaveValue("2");
  await expect(page.getByLabel("Unit, line 1")).toHaveValue("sack");
  await expect(page.getByLabel("Unit price, line 1")).toHaveValue("18.00");
  // Do it again with a different size to prove the maths follows the input: 20 kg sacks.
  await page.getByLabel("Quantity in one pack").fill("20");
  await page.getByRole("button", { name: "Convert" }).click();
  await expect(page.getByLabel("Quantity, line 1")).toHaveValue("40");
  await expect(page.getByLabel("Unit price, line 1")).toHaveValue("0.9");

  // The same file again is refused with a clear message.
  const dup = await request.post(`${API}/purchases`, { headers: s.auth, multipart: { file: { name: "again.png", mimeType: "image/png", buffer: makePng([200, 120, 40]) } } });
  expect(dup.status()).toBe(409);
  expect((await dup.json()).detail).toContain("already uploaded");
});

test("scan to stock from an empty list: chips, create-all preview, pack sizes, confirm posts the right base quantities", async ({ page, request }) => {
  const s = await seedMenu(request);
  const chicken = await mkItem(request, s, "Chicken Breast", "g");
  const milk = await mkItem(request, s, "Whole Milk", "ml");
  await request.post(`${API}/suppliers`, { headers: s.auth, data: { name: "Cash & Carry Ltd" } });
  const id = await draftInvoice(request, s, [
    { description: "Basmati Rice 20kg bag", quantity: "2", unit: "bag", unit_price: "38.00" },
    { description: "Chicken Breast Fillet 10kg", quantity: "10", unit: "kg", unit_price: "5.50" },
    { description: "Whole Milk 4 pint x 6", quantity: "1", unit: "case", unit_price: "12.00" },
    { description: "Eggs Large tray 30", quantity: "2", unit: "tray", unit_price: "4.99" },
    { description: "BASMATI RICE 20KG", quantity: "1", unit: "bag", unit_price: "38.00" },
    { description: "Cooking Oil 20L", quantity: "1", unit: "each", unit_price: "28.50" },
    { description: "Fresh Coriander bunch", quantity: "10", unit: "bunch", unit_price: "0.60" },
  ]);
  await openInvoice(page, s, id);
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Cash & Carry Ltd" });

  // Auto-match: suggestions are chips, never applied silently.
  await expect(page.getByLabel("Inventory item, line 2")).toHaveValue("");
  await page.getByRole("button", { name: "Use Chicken Breast?" }).click();
  await expect(page.getByLabel("Inventory item, line 2")).toHaveValue(chicken.id);
  await expect(page.getByRole("button", { name: "Use Whole Milk?" })).toBeVisible(); // exact match after cleaning, but still the human's call
  await expect(page.getByRole("button", { name: /^Use .*\?$/ })).toHaveCount(1);

  // Create all unmatched lines: preview merges the two rice lines and pre-matches the existing milk.
  await page.getByRole("button", { name: "Create all unmatched lines as new items" }).click();
  const dlg = page.getByRole("dialog", { name: "Create items from this invoice" });
  const rows = dlg.getByRole("list", { name: "Items to create" }).getByRole("listitem");
  await expect(rows).toHaveCount(5); // rice (merged), milk, eggs, oil, coriander; nothing for the mapped chicken
  await expect(dlg.getByLabel("Name, row 1")).toHaveValue("Basmati Rice");
  await expect(rows.nth(0)).toContainText("merged 2 lines");
  await expect(dlg.getByLabel("Unit, row 1")).toHaveValue("g"); // 20kg in the text
  await expect(dlg.getByLabel("Action, row 2")).toHaveValue(milk.id); // existing item matched, not created
  await expect(rows.nth(1)).toContainText("Matched to your existing");
  await expect(dlg.getByLabel("Unit, row 4")).toHaveValue("ml"); // "each" + 20L
  await expect(dlg.getByLabel("Unit, row 3")).toHaveValue("pcs"); // eggs
  await expect(dlg.getByLabel("Name, row 5")).toHaveValue("Fresh Coriander");
  await dlg.getByLabel("Name, row 3").fill("Eggs");
  await dlg.getByLabel("Skip row 5").check(); // coriander stays for later
  // The same item typed twice is caught before anything is sent.
  await dlg.getByLabel("Name, row 4").fill("eggs");
  await expect(dlg.getByText("Same name as another row").first()).toBeVisible();
  await expect(dlg.getByRole("button", { name: /Create \d+ items?/ })).toBeDisabled();
  await dlg.getByLabel("Name, row 4").fill("Cooking Oil");
  // A teammate creates Basmati Rice a moment before we save: the retry-safe path maps to it instead of failing.
  await mkItem(request, s, "Basmati Rice", "g");
  await dlg.getByRole("button", { name: "Create 3 items & map lines" }).click();
  await expect(dlg).toBeHidden();
  const inv = await items(request, s);
  expect(inv.map((i) => i.name).sort()).toEqual(["Basmati Rice", "Chicken Breast", "Cooking Oil", "Eggs", "Whole Milk"]);
  await expect(page.getByLabel("Inventory item, line 1")).toContainText("Basmati Rice (g)");
  await expect(page.getByLabel("Inventory item, line 5")).toContainText("Basmati Rice (g)");
  await expect(page.getByLabel("Inventory item, line 7")).toHaveValue(""); // skipped

  // Coriander: create it from its own line.
  await page.getByLabel("Inventory item, line 7").selectOption({ label: "➕ Create new item from this line" });
  const one = page.getByRole("dialog", { name: "Create stock item" });
  await expect(one.getByLabel("Name")).toHaveValue("Fresh Coriander");
  await expect(one.getByRole("radio", { name: "pcs", exact: true })).toHaveAttribute("aria-checked", "true");
  await one.getByRole("button", { name: "Create & map line" }).click();
  await expect(one).toBeHidden();

  // Confirm stays blocked until every pack is converted.
  const confirmBtn = page.getByRole("button", { name: "Confirm & add to stock" });
  await expect(confirmBtn).toBeDisabled();
  const packs = page.getByRole("group", { name: "Pack size" });
  await expect(packs).toHaveCount(6); // rice x2, milk, eggs, oil, coriander ("bunch")
  // rice 2 bag -> 40 kg, rice 1 bag -> 20 kg (prefilled 20 kg from the text)
  for (const line of [1, 5]) {
    const li = page.getByRole("listitem").filter({ has: page.getByLabel(`Inventory item, line ${line}`) });
    await expect(li.getByLabel("Quantity in one pack")).toHaveValue("20");
    await li.getByRole("button", { name: "Convert" }).click();
  }
  await expect(page.getByLabel("Quantity, line 1")).toHaveValue("40");
  await expect(page.getByLabel("Unit price, line 1")).toHaveValue("1.9");
  // milk "4 pint x 6" = 24 pints = 13632 ml
  const milkLi = page.getByRole("listitem").filter({ has: page.getByLabel("Inventory item, line 3") });
  await expect(milkLi.getByLabel("Quantity in one pack")).toHaveValue("13632");
  await milkLi.getByRole("button", { name: "Convert" }).click();
  // eggs: 2 trays of 30 = 60 pcs, total 9.98 kept exactly
  const eggLi = page.getByRole("listitem").filter({ has: page.getByLabel("Inventory item, line 4") });
  await expect(eggLi.getByLabel("Quantity in one pack")).toHaveValue("30");
  await eggLi.getByRole("button", { name: "Convert" }).click();
  await expect(page.getByLabel("Quantity, line 4")).toHaveValue("60");
  // oil: 1 each of 20L -> 20 l
  const oilLi = page.getByRole("listitem").filter({ has: page.getByLabel("Inventory item, line 6") });
  await expect(oilLi.getByLabel("Quantity in one pack")).toHaveValue("20");
  await oilLi.getByRole("button", { name: "Convert" }).click();
  // coriander: a bunch is 1 piece
  const corLi = page.getByRole("listitem").filter({ has: page.getByLabel("Inventory item, line 7") });
  await expect(corLi.getByRole("group", { name: "Pack size" })).toBeVisible();
  await corLi.getByLabel("Quantity in one pack").fill("1");
  await corLi.getByRole("button", { name: "Convert" }).click();
  await expect(packs).toHaveCount(0);
  await expect(confirmBtn).toBeEnabled();

  await confirmBtn.click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm & add to stock" }).click();
  await expect(page.getByRole("heading", { name: "Stock updated" })).toBeVisible();

  const got = Object.fromEntries((await items(request, s)).map((i) => [i.name, Number(i.balance)]));
  expect(got).toEqual({ "Basmati Rice": 60000, "Chicken Breast": 10000, "Whole Milk": 13632, "Eggs": 60, "Cooking Oil": 20000, "Fresh Coriander": 10 });
  const purchase = await (await request.get(`${API}/purchases/${id}`, { headers: s.auth })).json();
  expect(purchase.status).toBe("confirmed");
  const total = (purchase.lines as { line_total: string }[]).reduce((a, l) => a + Number(l.line_total), 0);
  expect(total).toBeCloseTo(2 * 38 + 55 + 12 + 9.98 + 38 + 28.5 + 6, 2); // pack conversion never changes money
  const eggs = await byName(request, s, "Eggs");
  const led = (await (await request.get(`${API}/inventory/ledger?item_id=${eggs!.id}`, { headers: s.auth })).json()) as { movement_type: string; source: { kind: string; invoice_number: string } }[];
  expect(led).toHaveLength(1);
  expect(led[0].source).toMatchObject({ kind: "purchase", invoice_number: "CC-1001" });

  await page.getByRole("button", { name: "View stock" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Eggs" }).filter({ hasText: "Reorder at" })).toContainText("Last received: 60 pcs · Cash & Carry Ltd · CC-1001");
});

test("a second invoice maps known items by chip and only creates what is new", async ({ page, request }) => {
  const s = await seedMenu(request);
  await mkItem(request, s, "Onions", "g");
  await mkItem(request, s, "Cooking Oil", "ml");
  const id = await draftInvoice(request, s, [
    { description: "Onion 25 kg sack", quantity: "1", unit: "sack", unit_price: "18.00" },
    { description: "Cooking Oil 20L", quantity: "1", unit: "each", unit_price: "28.50" },
    { description: "Paneer 1kg x 5", quantity: "5", unit: "pcs", unit_price: "6.00" },
  ], { color: [20, 90, 160], number: "CC-1002" });
  await openInvoice(page, s, id);
  await expect(page.getByRole("button", { name: /^Use .*\?$/ })).toHaveCount(2);
  await page.getByRole("button", { name: "Use Onions?" }).click();
  await page.getByRole("button", { name: "Use Cooking Oil?" }).click();
  await page.getByRole("button", { name: "Create all unmatched lines as new items" }).click();
  const dlg = page.getByRole("dialog", { name: "Create items from this invoice" });
  await expect(dlg.getByRole("list", { name: "Items to create" }).getByRole("listitem")).toHaveCount(1);
  await expect(dlg.getByLabel("Name, row 1")).toHaveValue("Paneer");
  await expect(dlg.getByLabel("Unit, row 1")).toHaveValue("g"); // 5 pcs of "1kg x 5": a weight item
  await dlg.getByRole("button", { name: "Create 1 item & map lines" }).click();
  await expect(dlg).toBeHidden();
  // 5 pcs of 1 kg: the helper reads "x 5" with quantity 5 as five 1 kg pieces
  const pack = page.getByRole("listitem").filter({ has: page.getByLabel("Inventory item, line 3") }).getByRole("group", { name: "Pack size" });
  await expect(pack.getByLabel("Quantity in one pack")).toHaveValue("1");
  await pack.getByRole("button", { name: "Convert" }).click();
  await expect(page.getByLabel("Quantity, line 3")).toHaveValue("5");
  await expect(page.getByLabel("Unit, line 3")).toHaveValue("kg");
  await expect(page.getByLabel("Unit price, line 3")).toHaveValue("6");
  expect((await items(request, s)).map((i) => i.name).sort()).toEqual(["Cooking Oil", "Onions", "Paneer"]);
});

test("import a stock list from pasted spreadsheet text (Indian number formats, a bad row, a duplicate)", async ({ page, request }) => {
  const s = await seedMenu(request);
  await mkItem(request, s, "Salt", "g");
  await openAs(page, s.token, "/manage?tab=inventory", s.refresh);
  await page.getByRole("button", { name: "Import stock list" }).click();
  const dlg = page.getByRole("dialog", { name: "Import stock list" });
  await expect(dlg.getByRole("button", { name: "Download template" })).toBeVisible();
  const dl = page.waitForEvent("download");
  await dlg.getByRole("button", { name: "Download template" }).click();
  expect((await dl).suggestedFilename()).toBe("stock-list-template.csv");

  const sheet = [
    "name\tunit\topening_quantity\treorder_level\tunit_cost",
    'Basmati Rice\tkg\t"1,250.50"\t100\t₹185',
    "Whole Milk\tL\t24\t12\t1.10",
    "basmati rice\tkg\t1\t\t",
    "Eggs\tdozen\t2\t1\t",
    "Flour\tbag\t5\t\t",
    "Salt\tkg\t2\t\t",
  ].join("\n");
  await dlg.getByLabel("Paste your list").fill(sheet);
  const table = dlg.getByRole("table", { name: "Import preview" });
  await expect(table.getByRole("row")).toHaveCount(7);
  await expect(table.getByRole("row").filter({ hasText: "Flour" })).toContainText('Unit "bag" cannot be counted');
  await expect(table.getByRole("row").filter({ hasText: "Same as row 2; skipped" })).toContainText("basmati rice");
  await expect(table.getByRole("row").filter({ hasText: "Salt" })).toContainText("Already in your stock list");
  await expect(dlg).toContainText("3 ready");
  await expect(dlg).toContainText("1 need fixing");
  await dlg.getByRole("button", { name: "Import 3 items" }).click();
  const doneDlg = page.getByRole("dialog", { name: "Stock list imported" });
  await expect(doneDlg.getByText("3 items created")).toBeVisible();
  await expect(doneDlg).toContainText("Opening stock set");

  const got = Object.fromEntries((await items(request, s)).map((i) => [i.name, i]));
  expect(Object.keys(got).sort()).toEqual(["Basmati Rice", "Eggs", "Salt", "Whole Milk"]);
  expect(Number(got["Basmati Rice"].balance)).toBe(1250500); // 1,250.50 kg in grams
  expect(Number(got["Whole Milk"].balance)).toBe(24000);
  expect(Number(got["Eggs"].balance)).toBe(24);
  expect(Number(got["Salt"].balance)).toBe(0); // existing items are never touched
  const led = (await (await request.get(`${API}/inventory/ledger?item_id=${got["Basmati Rice"].id}`, { headers: s.auth })).json()) as { note: string; unit_cost: string; source: { reason: string } }[];
  expect(led[0].note).toBe("Opening stock (import)");
  expect(Number(led[0].unit_cost)).toBe(0.185); // ₹185 per kg = ₹0.185 per g (rupees, India only: the cost is no longer read in minor units)

  await doneDlg.getByRole("button", { name: "View stock list" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Basmati Rice" }).filter({ hasText: "Reorder at" })).toContainText("1250.5 kg");
  await expect(page.getByRole("region", { name: "Start your stock list" })).toHaveCount(0);
});

test("the guidance card's spreadsheet button opens the import dialog on an empty list", async ({ page, request }) => {
  const s = await seedMenu(request);
  await openAs(page, s.token, "/manage?tab=inventory", s.refresh);
  await page.getByRole("region", { name: "Start your stock list" }).getByRole("button", { name: "Import a spreadsheet" }).click();
  await expect(page.getByRole("dialog", { name: "Import stock list" })).toBeVisible();
  // From Overview the same button deep-links to the dialog.
  await page.goto("/manage");
  await page.getByRole("region", { name: "Start your stock list" }).getByRole("button", { name: "Import a spreadsheet" }).click();
  await expect(page).toHaveURL(/tab=inventory&action=import/);
  await expect(page.getByRole("dialog", { name: "Import stock list" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/action=import/);
});
