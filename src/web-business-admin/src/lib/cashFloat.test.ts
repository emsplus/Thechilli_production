import { describe, expect, it } from "vitest";
import { averageFloat, hoursOpen, shiftTooLong, unusualFloat } from "./cashFloat";

const H = 3_600_000;
describe("shift open too long", () => {
  const opened = "2026-11-01T09:00:00Z";
  const at = (h: number) => Date.parse(opened) + h * H;
  it("counts whole hours from the server's opened_at", () => {
    expect(hoursOpen(opened, at(30) + 5 * 60_000)).toBe(30);
    expect(hoursOpen("garbage", at(30))).toBe(0);
  });
  it("only over 24 hours", () => {
    expect(shiftTooLong(opened, at(23))).toBe(false);
    expect(shiftTooLong(opened, at(24))).toBe(false); // exactly 24 h is not "over"
    expect(shiftTooLong(opened, at(24) + 60_000)).toBe(true);
    expect(shiftTooLong(opened, at(70))).toBe(true);
  });
});

describe("unusual opening float", () => {
  it("above 10,000 rupees", () => {
    expect(unusualFloat("78789", [])).toMatchObject({ reason: "limit" });
    expect(unusualFloat("10000", [])).toBeNull();
    expect(unusualFloat("10000.01", [])).not.toBeNull();
  });
  it("more than 3x the average of the last 5 floats", () => {
    expect(averageFloat(["500", "1000", "1500"])).toBe("1000.00");
    expect(averageFloat(["100", "100", "100", "100", "100", "9000"])).toBe("100.00"); // only the last five
    expect(unusualFloat("3001", ["500", "1000", "1500"])).toMatchObject({ reason: "average", average: "1000.00" });
    expect(unusualFloat("3000", ["500", "1000", "1500"])).toBeNull();
  });
  it("no history and a normal amount: fine", () => {
    expect(unusualFloat("2000", [])).toBeNull();
    expect(unusualFloat("2000", ["0", "0"])).toBeNull();
  });
});
