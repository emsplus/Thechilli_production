import { describe, expect, it } from "vitest";
import { billedOf, causeText, gapLines, hasTakingsSplit, notReceivedOf, onlyUnpaid } from "./takings";

const NEW = { total_takings: "200.00", billed_total: "960.00", takings: { payments: "200.00", refunds_paid: "0.00", billed_not_received: "760.00" } };
const OLD = { total_takings: "960.00" };

describe("X report takings vs billed", () => {
  it("new server: billed_total is the billed figure, takings is money received", () => {
    expect(hasTakingsSplit(NEW)).toBe(true);
    expect(billedOf(NEW)).toBe("960.00");
    expect(notReceivedOf(NEW)).toBe("760.00");
  });
  it("older server without the fields: total_takings stays the billed figure, nothing is invented", () => {
    expect(hasTakingsSplit(OLD)).toBe(false);
    expect(billedOf(OLD)).toBe("960.00");
    expect(notReceivedOf(OLD)).toBeNull();
  });
});

describe("payments gap sentences", () => {
  it("each cause has its own plain sentence and signed amount", () => {
    expect(causeText({ code: "unpaid_bills", count: 1, amount: "-760.00" }, "INR")).toBe("Unpaid bills of this period: 1 bill, -₹760.00");
    expect(causeText({ code: "settled_other_period", count: 2, amount: "120.00" }, "INR")).toBe("Money received for bills of an earlier period: 2 bills, +₹120.00");
    expect(causeText({ code: "refunds", count: 1, amount: "50.00" }, "INR")).toBe("Refunds paid out: 1 refund, +₹50.00");
    expect(causeText({ code: "corrections", count: 3, amount: "10.00" }, "INR")).toContain("Corrected bills: 3 bills");
    expect(causeText({ code: "voided_bills", count: 1, amount: "-30.00" }, "INR")).toBe("Bills voided in this period: 1 bill, -₹30.00");
    expect(causeText({ code: "mystery", label: "Something new", count: 1, amount: "5.00" }, "INR")).toBe("Something new: +₹5.00");
  });
  it("'Unexplained' only when it is not zero; missing field gives null (old text)", () => {
    const gap = { causes: [{ code: "unpaid_bills", count: 1, amount: "-760.00" }], unexplained: "0.00", explained: true };
    expect(gapLines(gap, "INR")?.unexplained).toBeNull();
    expect(gapLines({ ...gap, unexplained: "12.50" }, "INR")?.unexplained).toBe("Unexplained: ₹12.50");
    expect(gapLines(undefined, "INR")).toBeNull();
  });
  it("an unpaid-bills-only gap is information, not a leak", () => {
    expect(onlyUnpaid({ causes: [{ code: "unpaid_bills", count: 1, amount: "-760.00" }], unexplained: "0.00" })).toBe(true);
    expect(onlyUnpaid({ causes: [{ code: "unpaid_bills", count: 1, amount: "-760.00" }, { code: "refunds", count: 1, amount: "5.00" }] })).toBe(false);
    expect(onlyUnpaid({ causes: [{ code: "unpaid_bills", count: 1, amount: "-760.00" }], unexplained: "3.00" })).toBe(false);
    expect(onlyUnpaid(undefined)).toBe(false);
  });
});
