import { describe, expect, it } from "vitest";
import { computeInvoice, tryComputeInvoice, type EstimateConfig } from "./taxEstimate";

// QA break-ui D05: a discount WITHOUT a reason (the dialog says it is optional, the server accepts it) made the client estimate throw,
// so the draft ticket lost its totals block and the way to edit / remove the discount.
const cfg: EstimateConfig = {
  country: "IN", currency: "INR", prices_include_tax: true, vat_registered: true, service_charge_percent: "0",
  rates: [{ code: "standard", rate_percent: "5.00" }, { code: "zero", rate_percent: "0.00" }],
  rules: { eat_in: "standard", takeaway: {}, eat_in_order_types: ["dine_in"] },
};
const lines = [{ description: "Paneer Tikka", quantity: 1, unit_price: "320.00" }, { description: "Masala Chai", quantity: 1, unit_price: "50.00" }];

describe("estimate discount reason is optional", () => {
  it("empty reason: priced, labelled 'Discount'", () => {
    const inv = computeInvoice(lines, cfg, "takeaway", { type: "percent", value: "10", reason: "" });
    expect(inv.total).toBe("333.00");
    expect(inv.discount_reason).toBe("Discount");
  });
  it("whitespace-only reason behaves as empty", () => {
    expect(tryComputeInvoice(lines, cfg, "takeaway", { type: "amount", value: "20", reason: "   " }).invoice?.total).toBe("350.00");
  });
  it("100% discount is allowed (a comp)", () => {
    expect(tryComputeInvoice(lines, cfg, "takeaway", { type: "percent", value: "100", reason: "" }).invoice?.total).toBe("0.00");
  });
  it("a 1-2 character reason is still refused, over 200 too", () => {
    expect(tryComputeInvoice(lines, cfg, "takeaway", { type: "percent", value: "10", reason: "ab" }).error).toMatch(/3-200/);
    expect(tryComputeInvoice(lines, cfg, "takeaway", { type: "percent", value: "10", reason: "x".repeat(201) }).error).toMatch(/3-200/);
  });
  it("a discount bigger than the bill gives an error message, not a crash", () => {
    expect(tryComputeInvoice(lines, cfg, "takeaway", { type: "amount", value: "371", reason: "Loyalty" }).error).toMatch(/cannot exceed/);
  });
});
