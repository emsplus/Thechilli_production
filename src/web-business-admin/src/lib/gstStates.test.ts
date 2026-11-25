import { describe, expect, it } from "vitest";
import { stateOfGstin } from "./gstStates";
import { taxNumberError } from "./countries";

describe("GSTIN helpers", () => {
  it("names the state from the first two digits", () => {
    expect(stateOfGstin("27AAPFU0939F1ZV")).toBe("Maharashtra");
    expect(stateOfGstin("29 aapfu0939f1zv")).toBe("Karnataka");
    expect(stateOfGstin("99AAPFU0939F1ZV")).toBeNull();
    expect(stateOfGstin("")).toBeNull();
  });
  it("accepts a well-formed GSTIN with spaces, rejects a short one", () => {
    expect(taxNumberError("IN", "27 AAPFU 0939 F1ZV")).toBeNull();
    expect(taxNumberError("IN", "27AAPFU0939")).toMatch(/15 characters/);
  });
});
