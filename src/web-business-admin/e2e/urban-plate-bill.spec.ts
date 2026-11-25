import { expect, test, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import { API, openAs, seed } from "./helpers";

/**
 * A restaurant dine-in bill (e2e/fixtures/urban-plate-bill.png: 8 dishes, CGST/SGST, ₹1,470.00) scanned as a purchase.
 * The e2e API answers this exact file from apps/api/tests/fixtures/ocr/<sha256>.json (OCR_FIXTURE_DIR), so no Gemini call is made;
 * the extraction pipeline itself (supplier auto-create, lines, totals) is the real one. Run at phone, tablet and desktop widths.
 */
const BILL = path.join(__dirname, "fixtures", "urban-plate-bill.png");
const VIEWPORTS = [
  { name: "phone", viewport: { width: 390, height: 844 }, mobile: true },
  { name: "tablet", viewport: { width: 820, height: 1180 }, mobile: true },
  { name: "desktop", viewport: { width: 1280, height: 900 }, mobile: false },
] as const;

const shot = async (page: Page, name: string) => { if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: true }); };
const noSideScroll = (page: Page) => page.evaluate(() => {
  if (document.documentElement.scrollWidth > window.innerWidth) return false;
  const scrolls = (e: Element | null): boolean => { for (let n = e?.parentElement; n && n !== document.body; n = n.parentElement) if (/(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true; return false; };
  return [...document.querySelectorAll("main *")].every((e) => { const r = e.getBoundingClientRect(); return r.width === 0 || r.right <= window.innerWidth + 1 || scrolls(e); });
});
/** Centre the control first: the fixed bottom tab bar / sticky confirm bar can sit over a control Playwright scrolled just into view. */
const tap = async (l: Locator) => { await l.evaluate((e) => e.scrollIntoView({ block: "center" })); await l.click(); };
const fillNum = async (l: Locator, v: string) => { await l.evaluate((e) => e.scrollIntoView({ block: "center" })); await l.fill(v); };

const PRINTED = [["Paneer Butter Masala", "1", "280.00", "280.00"], ["Dal Tadka", "1", "180.00", "180.00"], ["Butter Naan", "2", "50.00", "100.00"], ["Jeera Rice", "1", "160.00", "160.00"],
  ["Chicken Biryani", "1", "320.00", "320.00"], ["Masala Papad", "1", "60.00", "60.00"], ["Fresh Lime Soda", "2", "90.00", "180.00"], ["Gulab Jamun (2 pcs)", "1", "120.00", "120.00"]];

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: vp.viewport, isMobile: vp.mobile, hasTouch: vp.mobile });

    test(`${vp.name}: the bill reads as printed, supplier is picked, edits recompute, stock or expense, confirm`, async ({ page, request }) => {
      const s = await seed(request); // an Indian restaurant: the bill is in rupees
      await openAs(page, s.token, "/manage?tab=suppliers&view=invoices", s.refresh);
      await page.getByLabel("Invoice file").setInputFiles(BILL);

      // supplier is already selected (created from the bill, name tidy-cased), no typing needed
      const picked = page.getByTestId("supplier-picked");
      await expect(picked).toBeVisible({ timeout: 40_000 });
      await expect(picked).toContainText("The Urban Plate");
      await expect(picked).toContainText("Bill says: THE URBAN PLATE");
      await expect(picked.getByRole("button", { name: "Not the right supplier? Change" })).toBeVisible();
      await expect(page.getByLabel("Invoice number")).toHaveValue("TUP/2026/10/0845");
      await expect(page.getByLabel("Invoice date")).toHaveValue("2026-10-26");
      const printed = page.getByRole("list", { name: "Printed on the bill" }).or(page.getByLabel("Printed on the bill"));
      await expect(printed).toContainText("01:42 PM");
      await expect(printed).toContainText("T-12");
      await expect(printed).toContainText("UPI");

      // INR bill on an INR-only app: no "foreign currency" notice
      await expect(page.getByTestId("not-inr")).toHaveCount(0);
      await expect(page.getByLabel("Printed on the bill")).toBeVisible();

      // the table is the printed bill: description, qty, unit price, amount
      for (const [n, row] of PRINTED.entries()) {
        const i = n + 1;
        await expect(page.getByLabel(`Description, line ${i}`)).toHaveValue(row[0]);
        await expect(page.getByLabel(`Quantity, line ${i}`)).toHaveValue(row[1]);
        await expect(page.getByLabel(`Unit price, line ${i}`)).toHaveValue(row[2]);
        await expect(page.getByLabel(`Unit, line ${i}`)).toHaveValue("pcs"); // none printed: never "case"
        await expect(page.getByTestId(`line-amount-${i}`)).toHaveText(row[3]);
      }
      // "(2 pcs)" stays 1 x 120.00; the pieces are offered, not applied
      const per = page.getByRole("group", { name: "Stock multiplier, line 8" });
      await expect(per).toContainText("Adds 2 pcs to stock per unit");
      const totals = page.getByRole("region", { name: "Bill totals" });
      await expect(totals).toContainText("Sub total");
      await expect(totals).toContainText("1,400.00");
      await expect(totals).toContainText("CGST @ 2.5%");
      await expect(totals).toContainText("SGST @ 2.5%");
      await expect(totals.getByText("35.00")).toHaveCount(2);
      await expect(totals).toContainText("Grand total");
      await expect(totals).toContainText("1,470.00");
      await expect(totals).toContainText("Rupees One Thousand Four Hundred Seventy Only");
      await expect(page.getByText("The lines add up to the invoice net of")).toBeVisible();

      // the classifier's guess is the default, both actions stay available
      const stockRadio = page.getByRole("radio", { name: "Add to stock" }), expenseRadio = page.getByRole("radio", { name: "Record as expense" });
      await expect(expenseRadio).toBeChecked();
      await expect(page.getByRole("button", { name: "Confirm & add to stock" })).toHaveCount(0);
      await shot(page, `${vp.name}-1-review`);
      expect(await noSideScroll(page)).toBe(true);

      // edit a quantity on a line of an "expense" document: amount and totals follow, the printed values stay visible
      const qty = page.getByLabel("Quantity, line 3");
      await fillNum(qty, "3");
      await expect(page.getByTestId("line-amount-3")).toHaveText("150.00");
      await expect(totals).toContainText("1,450.00");
      await expect(totals).toContainText("1,520.00"); // grand total = new sub total + the tax rows as printed
      await expect(page.locator("#invoice-line-2")).toContainText("On the bill: 2 × 50.00 = 100.00");
      await expect(page.getByText(/The lines add up to .* but the invoice net is/)).toBeVisible();
      await fillNum(page.getByLabel("Unit price, line 3"), "45.50");
      await expect(page.getByTestId("line-amount-3")).toHaveText("136.50");
      await expect(totals).toContainText("1,436.50");
      await fillNum(page.getByLabel("Unit price, line 3"), "50.00");
      await fillNum(qty, "2");
      await expect(page.getByText("The lines add up to the invoice net of")).toBeVisible();
      await expect(page.locator("#invoice-line-2")).not.toContainText("On the bill:");
      // unit is editable too
      await page.getByLabel("Unit, line 1").selectOption("kg");
      await expect(page.getByLabel("Unit, line 1")).toHaveValue("kg");
      await page.getByLabel("Unit, line 1").selectOption("pcs");

      // phone: large touch targets on the editable fields
      if (vp.name === "phone") {
        const small = await page.locator("main").evaluate((root) => [...root.querySelectorAll("li[id^=invoice-line-] input:not([type=checkbox]), li[id^=invoice-line-] select, li[id^=invoice-line-] button")]
          .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 44; })
          .map((e) => `${e.tagName} ${(e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 40)} ${Math.round(e.getBoundingClientRect().height)}px`));
        expect(small, "touch targets under 44px").toEqual([]);
      }

      // switch to stock: mapping controls and the confirm bar appear; nothing reached stock yet
      await tap(stockRadio);
      await expect(stockRadio).toBeChecked();
      await expect(page.getByLabel("Inventory item, line 1")).toBeVisible();
      await expect(page.getByRole("button", { name: "Confirm & add to stock" })).toBeDisabled();
      expect(((await (await request.get(`${API}/inventory/items`, { headers: s.auth })).json()) as unknown[]).length).toBe(0);
      await shot(page, `${vp.name}-2-stock`);
      // ...and back to expense, then to stock again (both always available)
      await tap(expenseRadio);
      await expect(page.getByRole("button", { name: "Record as expense" }).first()).toBeVisible();
      await tap(stockRadio);

      // dishes with no stock item: one tap creates the items (counted in pcs) and maps every line
      await tap(page.getByRole("button", { name: "Create all unmatched lines as new items" }));
      const dlg = page.getByRole("dialog", { name: "Create items from this invoice" });
      await expect(dlg.getByRole("list", { name: "Items to create" }).getByRole("listitem")).toHaveCount(8);
      for (let r = 1; r <= 8; r++) await expect(dlg.getByLabel(`Unit, row ${r}`)).toHaveValue("pcs");
      await dlg.getByRole("button", { name: "Create 8 items & map lines" }).click();
      await expect(dlg).toBeHidden();
      await expect(page.getByLabel("Quantity, line 8")).toHaveValue("1"); // the printed quantity survived mapping
      await expect(page.getByLabel("Unit price, line 8")).toHaveValue("120.00");

      // the owner chooses to count the 2 pieces of dessert; it is undoable and keeps the line total
      await tap(per.getByRole("button", { name: "Add 2 pcs to stock" }));
      await expect(page.getByLabel("Quantity, line 8")).toHaveValue("2");
      await expect(page.getByLabel("Unit price, line 8")).toHaveValue("60");
      await expect(page.getByTestId("line-amount-8")).toHaveText("120.00");
      await tap(page.locator("#invoice-line-7").getByRole("button", { name: "Undo" }));
      await expect(page.getByLabel("Quantity, line 8")).toHaveValue("1");

      await expect(page.getByRole("button", { name: "Confirm & add to stock" })).toBeEnabled();
      await tap(page.getByRole("button", { name: "Confirm & add to stock" }));
      await page.getByRole("dialog").getByRole("button", { name: "Confirm & add to stock" }).click();
      await expect(page.getByRole("heading", { name: "Stock updated" })).toBeVisible();
      await shot(page, `${vp.name}-3-done`);

      // server side: one supplier, lines as printed, immutable, 10 pieces in stock (the 2 pcs hint was not applied), money unchanged
      const sup = (await (await request.get(`${API}/suppliers`, { headers: s.auth })).json()) as { id: string; name: string }[];
      expect(sup.map((x) => x.name)).toEqual(["The Urban Plate"]);
      const list = (await (await request.get(`${API}/purchases`, { headers: s.auth })).json()) as { id: string }[];
      const p = await (await request.get(`${API}/purchases/${list[0].id}`, { headers: s.auth })).json();
      expect(p.status).toBe("confirmed");
      expect(p.supplier_id).toBe(sup[0].id);
      expect((p.lines as { line_total: string }[]).reduce((a, l) => a + Number(l.line_total), 0)).toBeCloseTo(1400, 2);
      expect((p.lines as { unit: string }[]).every((l) => l.unit === "pcs")).toBe(true);
      const stock = (await (await request.get(`${API}/inventory/items`, { headers: s.auth })).json()) as { name: string; balance: string; base_unit: string }[];
      expect(stock).toHaveLength(8);
      expect(stock.reduce((a, i) => a + Number(i.balance), 0)).toBe(10);
      expect(stock.every((i) => i.base_unit === "pcs")).toBe(true);
      expect((await request.put(`${API}/purchases/${p.id}`, { headers: s.auth, data: { supplier_id: sup[0].id, invoice_number: "X", invoice_date: "2026-10-26", document_type: "expense", lines: [{ description: "x", quantity: "1", unit: "pcs", unit_price: "1" }] } })).status()).toBe(409);
    });

    test(`${vp.name}: the same bill recorded as an expense uses the edited amounts; reopening does not duplicate the supplier`, async ({ page, request }) => {
      const s = await seed(request);
      await openAs(page, s.token, "/manage?tab=suppliers&view=invoices", s.refresh);
      await page.getByLabel("Invoice file").setInputFiles(BILL);
      await expect(page.getByTestId("supplier-picked")).toBeVisible({ timeout: 40_000 });
      await fillNum(page.getByLabel("Quantity, line 7"), "3"); // Fresh Lime Soda 3 x 90.00
      await expect(page.getByTestId("line-amount-7")).toHaveText("270.00");
      await tap(page.getByRole("button", { name: "Record as expense" }).first());
      const dlg = page.getByRole("dialog", { name: "Record as expense" });
      await expect(dlg.getByLabel("Invoice number")).toHaveValue("TUP/2026/10/0845");
      await expect(dlg.getByLabel("From")).toHaveValue("The Urban Plate");
      await expect(dlg.getByLabel("Net")).toHaveValue("1490.00");
      await expect(dlg.getByLabel("GST", { exact: true })).toHaveValue("70.00");
      await expect(dlg).toContainText("₹1,560.00");
      await dlg.getByRole("button", { name: "Record expense" }).click();
      await expect(page.getByRole("table", { name: "Expenses" })).toContainText("The Urban Plate");

      const exp = (await (await request.get(`${API}/expenses`, { headers: s.auth })).json()) as { net: string; vat: string; gross: string; invoice_id: string }[];
      expect(exp).toHaveLength(1);
      expect([exp[0].net, exp[0].vat, exp[0].gross]).toEqual(["1490.00", "70.00", "1560.00"]);
      const p = await (await request.get(`${API}/purchases/${exp[0].invoice_id}`, { headers: s.auth })).json();
      expect(p.lines.find((l: { description: string }) => l.description === "Fresh Lime Soda").line_total).toBe("270.00"); // the edit was saved with the invoice
      expect(p.bill.currency).toBe("INR");
      // opening the screen again (retry / second tab) finds the same supplier
      await request.post(`${API}/purchases/${p.id}/resolve-supplier`, { headers: s.auth });
      expect(((await (await request.get(`${API}/suppliers`, { headers: s.auth })).json()) as unknown[]).length).toBe(1);
    });
  });
}

test("a supplier the bill names that already exists is selected, and 'Not the right supplier?' lets the owner pick another", async ({ page, request }) => {
  const s = await seed(request);
  const saved = (await (await request.post(`${API}/suppliers`, { headers: s.auth, data: { name: "Urban Plate Restaurant & Cafe Ltd" } })).json()) as { id: string };
  await request.post(`${API}/suppliers`, { headers: s.auth, data: { name: "Bestway Wholesale" } });
  await openAs(page, s.token, "/manage?tab=suppliers&view=invoices", s.refresh);
  await page.getByLabel("Invoice file").setInputFiles(BILL);
  const picked = page.getByTestId("supplier-picked");
  await expect(picked).toContainText("Urban Plate Restaurant & Cafe Ltd", { timeout: 40_000 });
  expect(((await (await request.get(`${API}/suppliers`, { headers: s.auth })).json()) as unknown[]).length).toBe(2); // none created
  await picked.getByRole("button", { name: "Not the right supplier? Change" }).click();
  const sel = page.getByLabel("Supplier", { exact: true });
  await expect(sel).toHaveValue(saved.id);
  await sel.selectOption({ label: "Bestway Wholesale" });
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect.poll(async () => ((await (await request.get(`${API}/purchases`, { headers: s.auth })).json()) as { supplier_id: string }[])[0].supplier_id).not.toBe(saved.id);
});
