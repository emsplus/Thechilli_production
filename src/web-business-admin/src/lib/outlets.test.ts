import { describe, expect, it } from "vitest";
import { cleanCode, MAX_PREFIX_LENGTH, outletQuota, quotaText } from "./outlets";
import type { Outlet } from "./types";

const o = (active: boolean): Outlet => ({ id: String(Math.random()), name: "x", code: "X", invoice_prefix: "", is_default: false, is_active: active, currency: "INR", timezone: "Asia/Kolkata", country: "IN" });

describe("outlet quota", () => {
  it("no entitlements: unlimited, never reached", () => {
    const q = outletQuota({}, [o(true), o(true)]);
    expect(q).toEqual({ limit: null, used: 2, reached: false });
    expect(quotaText(q)).toBe("2 active outlets");
  });
  it("counts active outlets against the limit", () => {
    const q = outletQuota({ entitlements: { outlet_limit: 2 } }, [o(true), o(true), o(false)]);
    expect(q.reached).toBe(true);
    expect(quotaText(q)).toBe("2 of 2 outlets in use");
    expect(outletQuota({ entitlements: { outlet_limit: 3 } }, [o(true), o(false)]).reached).toBe(false);
  });
  it("limit 0 means none, null means unlimited", () => {
    expect(outletQuota({ entitlements: { outlet_limit: 0 } }, []).reached).toBe(true);
    expect(outletQuota({ entitlements: { outlet_limit: null } }, [o(true)]).reached).toBe(false);
  });
  it("code cleaning and India prefix length", () => {
    expect(cleanCode("m-g road 2")).toBe("MGROAD2");
    expect(MAX_PREFIX_LENGTH).toBe(4);
  });
});
