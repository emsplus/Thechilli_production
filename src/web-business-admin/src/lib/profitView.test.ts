import { describe, expect, it } from "vitest";
import { costKnown } from "./profitView";

describe("costKnown (gross profit tile)", () => {
  it("sales with no cost at all: unknown (no 100% margin)", () => {
    expect(costKnown({ ingredient_cost: "0.00", revenue_excl_vat: "1200.00" })).toBe(false);
    expect(costKnown({ ingredient_cost: "0", net_sales_excl_vat: "50" })).toBe(false);
  });
  it("a real cost is known; no sales is not an error", () => {
    expect(costKnown({ ingredient_cost: "300.00", revenue_excl_vat: "1200.00" })).toBe(true);
    expect(costKnown({ ingredient_cost: "0.00", revenue_excl_vat: "0.00" })).toBe(true);
  });
  it("the server can say so itself", () => {
    expect(costKnown({ ingredient_cost: "10.00", revenue_excl_vat: "100.00", cost_known: false })).toBe(false);
  });
});
