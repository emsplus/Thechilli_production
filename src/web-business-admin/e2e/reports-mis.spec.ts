import { expect, test } from "@playwright/test";
import { openAs, seed } from "./helpers";

// Management reports (GST, payments, sales, items, outlets) against mocked /reports/* endpoints (phase2/reports contract, docs/REPORTS.md).
const GONE = { status: 404, json: { detail: "Not Found" } };
const meta = { from_date: "2026-10-01", to_date: "2026-10-31", currency: "INR", timezone: "Asia/Kolkata" };
const gst = { ...meta, tax_label: "GST", split_available: true, by_rate: [{ code: "gst_5", rate_percent: "5.00", taxable_value: "123456.00", tax: "6172.80", cgst: "3086.40", sgst: "3086.40", igst: null, gross: "129628.80" }],
  totals: { taxable_value: "123456.00", tax: "6172.80", gross: "129628.80", bills: 42, credit_note_tax: "0.00", credit_note_taxable_value: "0.00", net_tax: "6172.80" } };

test("GST summary uses lakh formatting; a 404 section stays out of the page", async ({ page, request }) => {
  const s = await seed(request);
  let gstQuery = "";
  await page.route("**/reports/gst-summary*", (r) => { gstQuery = r.request().url(); return r.fulfill({ json: gst }); });
  for (const p of ["**/reports/payments*", "**/reports/sales-summary*", "**/reports/top-items*", "**/reports/outlet-comparison*"]) await page.route(p, (r) => r.fulfill(GONE));
  await openAs(page, s.token, "/reports", s.refresh);
  const block = page.getByTestId("mis-gst");
  await expect(block).toBeVisible();
  await expect(block.getByRole("columnheader", { name: "Taxable value" })).toHaveCSS("text-align", "end"); // numeric header over numbers
  await expect(block).toContainText("1,23,456.00");            // exact figure in the table, Indian grouping
  expect(gstQuery).toContain("/reports/gst-summary");
  await expect(page.getByTestId("mis-payments")).toHaveCount(0);
  await expect(page.getByTestId("mis-outlets")).toHaveCount(0);
});
