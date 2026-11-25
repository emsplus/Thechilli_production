import { describe, expect, it } from "vitest";
import { bulkPrice, priceInputProblem } from "./bulkPrice";

describe("bulkPrice", () => {
  it("sets, adds and applies a percentage exactly", () => {
    expect(bulkPrice("120.00", "set", "99.5")).toBe("99.50");
    expect(bulkPrice("120.00", "add", "10")).toBe("130.00");
    expect(bulkPrice("120.00", "add", "-20.50")).toBe("99.50");
    expect(bulkPrice("120.00", "percent", "5")).toBe("126.00");
    expect(bulkPrice("120.00", "percent", "-10")).toBe("108.00");
    expect(bulkPrice("99.99", "percent", "10")).toBe("109.99");
  });
  it("refuses a negative result", () => { expect(bulkPrice("5.00", "add", "-6")).toBeNull(); });
  it("validates the typed value per mode", () => {
    expect(priceInputProblem("set", "120")).toBeNull();
    expect(priceInputProblem("set", "-1")).not.toBeNull();
    expect(priceInputProblem("add", "0")).not.toBeNull();
    expect(priceInputProblem("percent", "-10")).toBeNull();
    expect(priceInputProblem("percent", "abc")).not.toBeNull();
  });
});
