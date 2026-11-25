import { describe, expect, it } from "vitest";
import { billTitle, countryInfo, taxNumberError } from "./countries";

describe("countries", () => {
  it("India uses GSTIN / INR / Asia/Kolkata", () => {
    const i = countryInfo("IN");
    expect([i.taxNumberLabel, i.currency, i.timezone, i.currencySymbol]).toEqual(["GSTIN", "INR", "Asia/Kolkata", "₹"]);
  });
  it("validates a GSTIN, lets it be empty, normalises spaces and case", () => {
    expect(taxNumberError("IN", "27AAPFU0939F1ZV")).toBeNull();
    expect(taxNumberError("IN", "27aapfu0939f1zv")).toBeNull();
    expect(taxNumberError("IN", "")).toBeNull();
    expect(taxNumberError("IN", "12345")).toMatch(/GSTIN/);
  });
  it("a bill is a tax invoice, or a bill of supply when not GST registered", () => {
    expect(billTitle("IN", true)).toBe("Tax invoice");
    expect(billTitle("IN", false)).toBe("Bill of supply");
  });
});
