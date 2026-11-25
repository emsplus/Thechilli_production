import { describe, expect, it } from "vitest";
import { flagTitle, hasUnpaidFlag, unpaidSummary } from "./leakageView";

describe("leakage wording", () => {
  it("a low flag is information, never 'High priority'", () => {
    expect(flagTitle("low")).toBe("For your information");
    expect(flagTitle("high")).toBe("High priority");
    expect(flagTitle("medium")).toBe("Medium priority");
  });
  it("one unpaid figure for Leakage and Payments", () => {
    const leak = { count: 0, balance: "0.00", min_age_days: 1, bills: [] };
    expect(unpaidSummary(leak).any).toBe(false);
    const s = unpaidSummary(leak, { bills: 2, balance: "540.00" });
    expect(s).toMatchObject({ any: true, count: 2, balance: "540.00", listed: 0 });
    expect(unpaidSummary({ ...leak, count: 3, balance: "900.00" }, { bills: 2, balance: "540.00" })).toMatchObject({ count: 3, balance: "900.00" });
  });
  it("detects the server's unpaid flag", () => {
    expect(hasUnpaidFlag([{ severity: "low", code: "unpaid_bills", message: "x" }])).toBe(true);
    expect(hasUnpaidFlag([{ severity: "high", code: "discounts_high", message: "x" }])).toBe(false);
  });
});

import { cancelledView } from "./leakageView";
describe("cancelled count in Payments and Leakage", () => {
  it("the same number: both sections show it as 'Cancelled orders'", () => {
    expect(cancelledView(2, 2)).toEqual({ conflict: false, hidePaymentsTile: false, leakageLabel: "Cancelled orders" });
    expect(cancelledView(null, 2).hidePaymentsTile).toBe(false);
  });
  it("two different numbers (Payments 0, Leakage 2): Leakage's only, as 'Cancelled by staff'; no conflicting Payments tile", () => {
    expect(cancelledView(0, 2)).toEqual({ conflict: true, hidePaymentsTile: true, leakageLabel: "Cancelled by staff" });
  });
});
