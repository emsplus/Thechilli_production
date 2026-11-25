import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { cashierMethods, isMissing, methodLabel, reportQuery } from "./reportsApi";

describe("reportsApi helpers", () => {
  it("treats 404, 405 and 501 as a missing endpoint, nothing else", () => {
    for (const s of [404, 405, 501]) expect(isMissing(new ApiError(s, "x"))).toBe(true);
    for (const s of [0, 400, 401, 403, 422, 500, 503]) expect(isMissing(new ApiError(s, "x"))).toBe(false);
    expect(isMissing(new Error("x"))).toBe(false);
  });
  it("builds the query with from/to and only a chosen outlet", () => {
    expect(reportQuery({ from: "2026-01-01", to: "2026-01-31" })).toBe("?from=2026-01-01&to=2026-01-31");
    expect(reportQuery({ from: "a", to: "b", outletId: "o1" }, { group_by: "month", limit: 10, empty: undefined })).toBe("?from=a&to=b&outlet_id=o1&group_by=month&limit=10");
  });
  it("labels payment methods", () => {
    expect(methodLabel("upi")).toBe("UPI");
    expect(methodLabel("cash")).toBe("Cash");
    expect(methodLabel("gift_card")).toBe("Gift card");
  });
  it("orders cashier columns by the method totals, then any extra", () => {
    const r = { by_method: [{ method: "cash" }, { method: "card" }], by_cashier: [{ by_method: { upi: "1", cash: "2" } }, { by_method: { zed: "1" } }] } as never;
    expect(cashierMethods(r)).toEqual(["cash", "card", "upi", "zed"]);
  });
});
