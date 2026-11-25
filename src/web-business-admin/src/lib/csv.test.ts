import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";

const one = (v: string | number) => toCsv([[v]]);

describe("csv formula neutralisation", () => {
  it.each(["=1+1", "+cmd|' /c calc'!A1", "-2+3", "@SUM(A1)", "\t=1+1", "\r=1+1", "\n=1+1", " =1+1", "  @x", "\u0001=1", "＝1+1"])(
    "prefixes %j with an apostrophe", (v) => {
      expect(one(v).replace(/^"|"$/g, "")[0]).toBe("'");
    });
  it("keeps real numbers and plain text unchanged", () => {
    expect(one(-5)).toBe("-5");
    expect(one("-5.25")).toBe("-5.25");
    expect(one("+3")).toBe("+3");
    expect(one("Paneer tikka")).toBe("Paneer tikka");
    expect(one("a=b")).toBe("a=b");
  });
  it("still quotes commas, quotes and newlines", () => {
    expect(one('a,"b"')).toBe('"a,""b"""');
  });
});
