import { describe, expect, it } from "vitest";
import { discountValueError } from "./discountInput";

describe("discount value messages (QA D06)", () => {
  it("accepts plain amounts", () => { for (const v of ["10", "2.5", "2.50", " 12 ", "0.01", "100"]) expect(discountValueError(v), v).toBeNull(); });
  it("empty and whitespace say the same thing", () => {
    expect(discountValueError("")).toBe(discountValueError("   "));
    expect(discountValueError("")).toMatch(/Enter the discount/);
  });
  it("more than 2 decimals is named as such, not 'greater than zero'", () => {
    expect(discountValueError("10.555")).toMatch(/at most 2 decimal places/);
  });
  it("exponent, sign, comma, letters say digits only", () => {
    for (const v of ["1e1", "-5", "1,5", "abc", "+3", "٣"]) expect(discountValueError(v), v).toMatch(/digits only/);
  });
  it("zero says greater than zero", () => { for (const v of ["0", "0.00"]) expect(discountValueError(v), v).toMatch(/greater than zero/); });
});
