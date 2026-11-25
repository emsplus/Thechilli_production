import { describe, expect, it } from "vitest";
import { businessDate, ordersCreated, todayRange } from "./today";

describe("Today date range", () => {
  it("uses the restaurant's calendar date, not UTC", () => {
    const lateEvening = new Date("2026-10-31T20:00:00Z"); // 01:30 on 1 Nov in India
    expect(businessDate(lateEvening, "Asia/Kolkata")).toBe("2026-11-01");
    expect(businessDate(lateEvening, "UTC")).toBe("2026-10-31");
  });
  it("queries a single day: from = to = today", () => {
    expect(todayRange(new Date("2026-10-31T06:00:00Z"), "Asia/Kolkata")).toEqual({ from: "2026-10-31", to: "2026-10-31" });
  });
  it("falls back to the device zone for an unknown zone", () => {
    expect(businessDate(new Date("2026-10-31T06:00:00Z"), "Not/AZone")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("counts every order created today", () => {
    expect(ordersCreated({ open: 2, billed: 5, cancelled: 1 })).toBe(8);
    expect(ordersCreated(undefined)).toBe(0);
  });
});
