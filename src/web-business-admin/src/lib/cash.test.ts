import { describe, expect, it } from "vitest";
import { cashVariance, needsVarianceReason, validAmount } from "./cash";

describe("cash session maths", () => {
  it("variance is counted minus expected, negative when short", () => {
    expect(cashVariance("1180", "1200")).toBe("-20.00");
    expect(cashVariance("1200.50", "1200")).toBe("0.50");
    expect(cashVariance("1200", "1200.00")).toBe("0.00");
  });
  it("a reason is needed for any non-zero variance, not for an exact count", () => {
    expect(needsVarianceReason("1199.99", "1200")).toBe(true);
    expect(needsVarianceReason("1200", "1200.00")).toBe(false);
  });
  it("accepts only sane amounts", () => {
    for (const ok of ["0", "500", "99.5", "1200.25"]) expect(validAmount(ok)).toBe(true);
    for (const bad of ["", "-5", "1.234", "abc", "1,200"]) expect(validAmount(bad)).toBe(false);
  });
});
