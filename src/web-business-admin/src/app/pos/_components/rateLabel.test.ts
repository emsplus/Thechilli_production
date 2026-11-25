import { describe, expect, it } from "vitest";
import { rateLabel } from "./Receipts";

describe("rateLabel (tax breakdown rows on a bill)", () => {
  it("prints the rate for Indian GST codes, never Exempt", () => {
    expect(rateLabel("gst_5", "5.0000", "IN")).toBe("5%");
    expect(rateLabel("gst_12", "12.0000", "IN")).toBe("12%");
    expect(rateLabel("gst_18", "18.0000", "IN")).toBe("18%");
    expect(rateLabel("gst_28", "28.0000", "IN")).toBe("28%");
  });
  it("keeps the generic codes", () => {
    expect(rateLabel("standard", "5", "IN")).toBe("5%");
    expect(rateLabel("zero", "0", "IN")).toBe("Zero rate 0%");
    expect(rateLabel("gst_0", "0", "IN")).toBe("Zero rate 0%");
  });
  it("prints Exempt only for a no-tax code or a zero rate without a zero code", () => {
    expect(rateLabel("none", "0", "IN")).toBe("Exempt");
    expect(rateLabel("weird", "0", "IN")).toBe("Exempt");
  });
});
