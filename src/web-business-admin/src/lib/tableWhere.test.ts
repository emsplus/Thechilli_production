import { describe, expect, it } from "vitest";
import { areaLabel, orderWhere, tableWhere } from "./tableWhere";

// Tester: the same table (AC1) showed Dine-in on one order and Outdoor on another. A table order always names the TABLE's area.
describe("tableWhere / orderWhere", () => {
  it("names the table with its own area", () => {
    expect(tableWhere({ label: "AC1", area: "indoor" })).toBe("Table AC1 · Indoor");
    expect(tableWhere({ label: "G2", area: "outdoor" })).toBe("Table G2 · Outdoor");
    expect(tableWhere({ label: "T9" })).toBe("Table T9");
  });
  it("two orders on the same table read the same whatever their own order_type says", () => {
    const t = { label: "AC1", area: "indoor" };
    expect(orderWhere({ order_type: "indoor", table_id: "t1" }, t)).toBe("Table AC1 · Indoor");
    expect(orderWhere({ order_type: "outdoor", table_id: "t1" }, t)).toBe("Table AC1 · Indoor");
  });
  it("never prints a type that could contradict the table when the table is not loaded", () => {
    expect(orderWhere({ order_type: "outdoor", table_id: "t1" })).toBe("Table");
    expect(orderWhere({ order_type: "outdoor", table_id: "t1" }, null, "AC1")).toBe("Table AC1");
  });
  it("orders without a table", () => {
    expect(orderWhere({ order_type: "takeaway", table_id: null })).toBe("Takeaway");
    expect(orderWhere({ order_type: "delivery", table_id: null })).toBe("Delivery");
    expect(orderWhere({ order_type: "indoor", table_id: null })).toBe("No table");
  });
  it("area labels", () => {
    expect(areaLabel("indoor")).toBe("Indoor");
    expect(areaLabel("takeaway")).toBeNull();
  });
});
