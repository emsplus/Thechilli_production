import { describe, expect, it } from "vitest";
import { billDiscountEditable, discountLimitFor, previewRows } from "./discountPreview";
import type { BillPreview } from "@/lib/types";

const line = (line_total: string) => ({ description: "x", quantity: 1, unit_price: line_total, line_total, discount: "0.00", gross: line_total, net: line_total, vat: "0.00", tax_code: "gst_5", rate_percent: "5.00" });
/** Paneer 2 x 135 (5%) + Brownie 120 (18%), 10 % off, prices include GST (the numbers pos-service returns). */
const gst: BillPreview = {
  lines: [line("270.00"), line("120.00")], discount_amount: "39.00", discount_reason: "Staff meal", service_charge_amount: "0.00", service_charge_percent: "0.00",
  subtotal: "323.00", tax_amount: "28.06", total: "351.00", round_off: "-0.06", currency: "INR", prices_include_tax: true, vat_registered: true, country: "IN",
  tax_breakdown: [
    { code: "gst_5", rate_percent: "5.00", net: "231.42", vat: "11.58", gross: "243.00", cgst: "5.79", sgst: "5.79", igst: "0.00" },
    { code: "gst_18", rate_percent: "18.00", net: "91.52", vat: "16.48", gross: "108.00", cgst: "8.24", sgst: "8.24", igst: "0.00" },
  ],
};

describe("previewRows", () => {
  it("lists items, the discount with its reason, CGST / SGST per rate on the discounted value, round off and total", () => {
    const r = previewRows(gst);
    expect(r.map((x) => x.key)).toEqual(["items", "discount", "gst_5-cgst", "gst_5-sgst", "gst_18-cgst", "gst_18-sgst", "round", "total"]);
    expect(r[0].value).toBe("390.00");
    expect(r[1]).toMatchObject({ label: "Discount (Staff meal)", value: "39.00", tone: "discount" });
    expect(r[2]).toMatchObject({ label: "CGST 2.5%", value: "5.79", hint: "231.42" });
    expect(r[5]).toMatchObject({ label: "SGST 9%", value: "8.24", hint: "91.52" });
    expect(r.at(-1)).toMatchObject({ label: "Total", value: "351.00", tone: "total" });
  });
  it("a discount without a reason says just Discount", () => {
    expect(previewRows({ ...gst, discount_reason: "Discount" })[1].label).toBe("Discount");
    expect(previewRows({ ...gst, discount_reason: null })[1].label).toBe("Discount");
  });
  it("no discount, no round off: those rows are absent", () => {
    const keys = previewRows({ ...gst, discount_amount: "0.00", discount_reason: null, round_off: "0.00" }).map((x) => x.key);
    expect(keys).not.toContain("discount");
    expect(keys).not.toContain("round");
  });
  it("without CGST / SGST (generic engine) the rate row carries the tax word; zero-rate and unregistered rows are skipped", () => {
    const g: BillPreview = { ...gst, round_off: undefined, tax_breakdown: [{ code: "standard", rate_percent: "5.00", net: "279.00", vat: "13.95", gross: "292.95" }, { code: "zero", rate_percent: "0.00", net: "10.00", vat: "0.00", gross: "10.00" }] };
    const r = previewRows(g);
    expect(r.find((x) => x.key === "standard")?.label).toBe("GST 5%");
    expect(r.some((x) => x.key === "zero")).toBe(false);
    expect(previewRows({ ...g, vat_registered: false }).some((x) => x.key === "standard")).toBe(false);
  });
  it("inter-state invoices show IGST", () => {
    const r = previewRows({ ...gst, tax_breakdown: [{ code: "gst_5", rate_percent: "5.00", net: "231.42", vat: "11.58", gross: "243.00", cgst: "0.00", sgst: "0.00", igst: "11.58" }] });
    expect(r.find((x) => x.key === "gst_5-igst")).toMatchObject({ label: "IGST 5%", value: "11.58" });
  });
  it("service charge is its own line", () => {
    const r = previewRows({ ...gst, service_charge_amount: "12.50", service_charge_percent: "12.50" });
    expect(r.find((x) => x.key === "sc")).toMatchObject({ label: "Service charge 12.5%", value: "12.50" });
  });
});

describe("discountLimitFor", () => {
  it("is the cashier cap unless the user holds bills.discount.over_limit", () => {
    expect(discountLimitFor((p) => p === "bills.discount", "15.00")).toBe("15.00");
    expect(discountLimitFor((p) => p === "bills.discount", undefined)).toBe("10");
    expect(discountLimitFor((p) => p === "bills.discount.over_limit", "15.00")).toBeNull();
  });
});

describe("billDiscountEditable", () => {
  const open = { paid: "0.00", balance_due: "351.00", offer_amount: "0.00", status: "active" as const };
  it("an open, unpaid bill takes a discount", () => expect(billDiscountEditable(open)).toBe(true));
  it("a paid, part-paid, offer, superseded or voided bill does not", () => {
    expect(billDiscountEditable({ ...open, paid: "351.00", balance_due: "0.00" })).toBe(false);
    expect(billDiscountEditable({ ...open, paid: "100.00", balance_due: "251.00" })).toBe(false);
    expect(billDiscountEditable({ ...open, offer_amount: "27.00" })).toBe(false);
    expect(billDiscountEditable({ ...open, status: "superseded" })).toBe(false);
    expect(billDiscountEditable({ ...open, status: "voided" })).toBe(false);
    expect(billDiscountEditable(null)).toBe(false);
  });
});
