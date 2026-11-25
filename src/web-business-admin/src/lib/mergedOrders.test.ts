import { describe, expect, it } from "vitest";
import { isMergedOrder, mergedIntoText } from "./mergedOrders";

describe("merged orders", () => {
  it("detects the new server fields and the old reason text", () => {
    expect(isMergedOrder({ kind: "merged", status: "cancelled" })).toBe(true);
    expect(isMergedOrder({ status: "cancelled", merged_into_number: 12 })).toBe(true);
    expect(isMergedOrder({ status: "cancelled", merged_into_order_id: "abc" })).toBe(true);
    expect(isMergedOrder({ status: "cancelled", cancel_reason: "Merged into order 3f2a9c10-1111-4222-8333-444455556666" })).toBe(true);
    expect(isMergedOrder({ status: "cancelled", cancel_reason: "Customer left" })).toBe(false);
    expect(isMergedOrder({ status: "open" })).toBe(false);
  });
  it("says 'Merged into order #<number>', never an internal id", () => {
    expect(mergedIntoText({ kind: "merged", merged_into_number: 12 })).toBe("Merged into order #12");
    expect(mergedIntoText({ merged_into_number: "#7" })).toBe("Merged into order #7");
    const id = "3f2a9c10-1111-4222-8333-444455556666";
    const t = mergedIntoText({ cancel_reason: `Merged into order ${id}` });
    expect(t).toBe("Merged into order #3F2A9C");
    expect(t).not.toContain(id);
    expect(mergedIntoText({ cancel_reason: `Merged into order ${id}` }, () => "A-14")).toBe("Merged into order #A-14");
    expect(mergedIntoText({ kind: "merged" })).toBe("Merged into another order");
  });
});
