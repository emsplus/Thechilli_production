import { beforeEach, describe, expect, it } from "vitest";
import { adoptServerTarget, getKitchenTarget, parseTarget, setKitchenTarget } from "./kitchenTarget";
import { waitCounts } from "./ticketAge";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { window: unknown }).window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
  (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  (globalThis as unknown as { Event: unknown }).Event = class { constructor(public type: string) {} };
});

describe("kitchen target (per device until the API stores it)", () => {
  it("defaults to 15 and only accepts whole minutes between 5 and 90", () => {
    expect(getKitchenTarget()).toBe(15);
    expect(parseTarget("20")).toBe(20);
    for (const bad of ["", "abc", "4", "91", "12.5", null, undefined, -3]) expect(parseTarget(bad)).toBe(15);
  });
  it("is remembered on this device", () => {
    setKitchenTarget(25);
    expect(getKitchenTarget()).toBe(25);
    setKitchenTarget(200);
    expect(getKitchenTarget()).toBe(15);
  });
  it("a server value wins once the API has one", () => {
    setKitchenTarget(25);
    adoptServerTarget({});
    expect(getKitchenTarget()).toBe(25);
    adoptServerTarget({ kitchen_target_minutes: 10 });
    expect(getKitchenTarget()).toBe(10);
  });
  it("drives the lateness counts", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    const kots = [{ status: "pending", created_at: "2026-10-31T11:48:00Z" }]; // waiting 12 min
    expect(waitCounts(kots, now, 15)).toEqual({ warn: 0, late: 0 });
    expect(waitCounts(kots, now, 10)).toEqual({ warn: 1, late: 0 });
    expect(waitCounts(kots, now, 5)).toEqual({ warn: 0, late: 1 });
  });
});
