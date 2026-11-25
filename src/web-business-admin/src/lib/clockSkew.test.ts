import { describe, expect, it } from "vitest";
import { learnClockSkew, tokenSecondsLeft } from "./api";

describe("device clock skew vs the 15 min access token", () => {
  const serverNow = Date.parse("2026-11-02T10:00:00Z") / 1000;
  const exp = serverNow + 15 * 60; // a token the server just issued
  it("a device 45 min ahead sees the token as already expired without the correction (the refresh storm)", () => {
    expect(tokenSecondsLeft(exp, serverNow + 45 * 60, 0)).toBeLessThan(0);
  });
  it("after learning the skew from the server's Date header the token has its real 15 min", () => {
    learnClockSkew("Mon, 02 Nov 2026 10:00:00 GMT", serverNow + 45 * 60);
    expect(tokenSecondsLeft(exp, serverNow + 45 * 60)).toBeCloseTo(15 * 60, -1);
    learnClockSkew("Mon, 02 Nov 2026 10:00:00 GMT", serverNow - 10 * 60);   // behind by 10 min: no longer trusts an expired token
    expect(tokenSecondsLeft(exp, serverNow - 10 * 60)).toBeCloseTo(15 * 60, -1);
  });
  it("ignores small differences (network latency) and garbage headers", () => {
    learnClockSkew("Mon, 02 Nov 2026 10:00:00 GMT", serverNow - 3);
    expect(tokenSecondsLeft(exp, serverNow - 3)).toBe(exp - (serverNow - 3));
    learnClockSkew("not a date", serverNow + 3600);
    expect(tokenSecondsLeft(exp, serverNow)).toBe(15 * 60);
  });
});
