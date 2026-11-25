import { describe, expect, it } from "vitest";
import { planPayment, validEntry, type PayLine } from "./pay-plan";

const line = (kind: PayLine["kind"], amount: string): PayLine => ({ kind, amount, key: kind + amount });

describe("planPayment", () => {
  it("exact cash settles with no change", () => {
    expect(planPayment("120.00", [], "cash", "120")).toMatchObject({ remaining: "120.00", applied: "120.00", change: "0.00", canConfirm: true, canSplit: false });
  });
  it("cash over the balance gives change", () => {
    expect(planPayment("120.00", [], "cash", "500")).toMatchObject({ applied: "120.00", change: "380.00", canConfirm: true });
  });
  it("card or UPI can not exceed the balance", () => {
    expect(planPayment("120.00", [], "card", "500")).toMatchObject({ change: "0.00", canConfirm: false });
    expect(planPayment("120.00", [], "upi", "120")).toMatchObject({ canConfirm: true });
  });
  it("less than the balance is a split line, not a confirm", () => {
    expect(planPayment("120.00", [], "cash", "50")).toMatchObject({ canSplit: true, canConfirm: false });
  });
  it("a split of cash + UPI sums to the balance", () => {
    const lines = [line("cash", "50.00")];
    expect(planPayment("120.00", lines, "upi", "70")).toMatchObject({ remaining: "70.00", applied: "70.00", canConfirm: true });
    expect(planPayment("120.00", [...lines, line("upi", "70.00")], "cash", "")).toMatchObject({ remaining: "0.00", canConfirm: true });
  });
  it("empty entry never confirms while money is due", () => {
    expect(planPayment("120.00", [], "cash", "")).toMatchObject({ canConfirm: false, canSplit: false, applied: "0.00" });
  });
  it("handles paise exactly", () => {
    expect(planPayment("0.30", [line("cash", "0.10")], "cash", "0.2")).toMatchObject({ remaining: "0.20", canConfirm: true });
  });
});

describe("validEntry", () => {
  it("accepts up to 2 decimals only", () => {
    expect(validEntry("12.50")).toBe(true);
    expect(validEntry("12.505")).toBe(false);
    expect(validEntry("1a")).toBe(false);
  });
});
