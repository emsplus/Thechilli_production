import { describe, expect, it } from "vitest";
import { gstinCheckChar, gstinError, gstinState, normaliseGstin } from "./gstin";

describe("gstin", () => {
  it("computes the mod-36 check character of known GSTINs", () => {
    expect(gstinCheckChar("27AAPFU0939F1Z")).toBe("V");
    expect(gstinCheckChar("29AAGCB7383J1Z")).toBe("4");
  });
  it("accepts valid, empty, lower-case and spaced GSTINs", () => {
    expect(gstinError("27AAPFU0939F1ZV")).toBeNull();
    expect(gstinError(" 27aapfu0939f1zv ")).toBeNull();
    expect(gstinError("27 AAPFU 0939F1ZV")).toBeNull();
    expect(gstinError("")).toBeNull();
    expect(normaliseGstin("27-aapfu0939f1zv")).toBe("27AAPFU0939F1ZV");
  });
  it("rejects wrong length, wrong shape and a bad check character", () => {
    expect(gstinError("27AAPFU0939F1Z")).toMatch(/15 characters/);
    expect(gstinError("00AAPFU0939F1ZV")).toMatch(/not a GSTIN/);
    expect(gstinError("27AAPFU0939F1XV")).toMatch(/not a GSTIN/);
    expect(gstinError("27AAPFU0939F1ZW")).toMatch(/check digit/);
  });
  it("names the state from the first two digits", () => {
    expect(gstinState("27AAPFU0939F1ZV")).toBe("Maharashtra");
    expect(gstinState("29")).toBe("Karnataka");
    expect(gstinState("97AAAAA0000A1Z5")).toBe("Other Territory");
    expect(gstinState("00")).toBeNull();
    expect(gstinState("")).toBeNull();
  });
});
