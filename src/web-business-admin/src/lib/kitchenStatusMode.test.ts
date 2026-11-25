import { beforeEach, describe, expect, it } from "vitest";
import { adoptServerKitchenMode, DEFAULT_DISPLAY_MINUTES, DEFAULT_KITCHEN_MODE, getKitchenDisplayMinutes, parseDisplayMinutes, splitTickets, getKitchenMode, isOpenKot, parseKitchenMode, setKitchenMode } from "./kitchenStatusMode";

const store = new Map<string, string>();
describe("kitchen status mode", () => {
  beforeEach(() => {
    store.clear();
    (globalThis as unknown as { window: unknown }).window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
    (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    (globalThis as unknown as { Event: unknown }).Event = class { constructor(public type: string) {} };
  });
  it("defaults to KOT only for anything unknown", () => {
    expect(DEFAULT_KITCHEN_MODE).toBe("kot_only");
    for (const v of [undefined, null, "", "KDS", 3, "kot_only"]) expect(parseKitchenMode(v)).toBe("kot_only");
    expect(parseKitchenMode("track")).toBe("track");
    expect(getKitchenMode()).toBe("kot_only");
  });
  it("the server value wins, a bad or missing value changes nothing", () => {
    setKitchenMode("track");
    expect(getKitchenMode()).toBe("track");
    adoptServerKitchenMode({ kitchen_status_mode: "bogus" });
    adoptServerKitchenMode(null);
    adoptServerKitchenMode({});
    expect(getKitchenMode()).toBe("track");
    adoptServerKitchenMode({ kitchen_status_mode: "kot_only" });
    expect(getKitchenMode()).toBe("kot_only");
  });
  it("an open ticket is one the kitchen has not finished or cancelled (pending / preparing / ready, no done_at)", () => {
    expect(isOpenKot({ status: "pending" })).toBe(true);
    expect(isOpenKot({ status: "preparing" })).toBe(true);
    expect(isOpenKot({ status: "ready" })).toBe(true);
    expect(isOpenKot({ status: "served" })).toBe(false);
    expect(isOpenKot({ status: "cancelled" })).toBe(false);
    expect(isOpenKot({ status: "pending", done_at: "2026-11-02T10:00:00Z" })).toBe(false);
  });
});

describe("show tickets for N minutes", () => {
  beforeEach(() => {
    store.clear();
    (globalThis as unknown as { window: unknown }).window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
    (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    (globalThis as unknown as { Event: unknown }).Event = class { constructor(public type: string) {} };
  });
  it("whole minutes 5..120, default 20", () => {
    expect(DEFAULT_DISPLAY_MINUTES).toBe(20);
    for (const v of [4, 121, 7.5, "x", null, undefined, ""]) expect(parseDisplayMinutes(v)).toBe(20);
    expect(parseDisplayMinutes(5)).toBe(5); expect(parseDisplayMinutes("120")).toBe(120);
  });
  it("the server value wins", () => {
    adoptServerKitchenMode({ kitchen_status_mode: "kot_only", kitchen_display_minutes: 45 });
    expect(getKitchenDisplayMinutes()).toBe(45);
    adoptServerKitchenMode({ kitchen_display_minutes: 999 });
    expect(getKitchenDisplayMinutes()).toBe(45);
  });
  const now = Date.parse("2026-11-02T12:00:00Z");
  const k = (number: number, minsAgo: number | null, extra: object = {}) => ({ id: `k${number}`, number, status: "pending", created_at: minsAgo === null ? null : new Date(now - minsAgo * 60_000).toISOString(), ...extra });
  it("auto-archive: live = arrived less than N minutes ago, newest first; the rest is 'earlier' (never deleted); cancelled is dropped", () => {
    const { live, earlier } = splitTickets([k(1, 25), k(2, 19), k(3, 1), k(4, 30, { status: "cancelled" }), k(5, 5, { done_at: "2026-11-02T11:59:00Z" }), k(6, 2, { status: "served" })], now, 20, "UTC");
    expect(live.map((x) => x.number)).toEqual([3, 2]);
    expect(earlier.map((x) => x.number)).toEqual([6, 5, 1]);
    expect(splitTickets([k(1, 25)], now, 30, "UTC").live.map((x) => x.number)).toEqual([1]); // the setting moves the line
    expect(splitTickets([k(1, null)], now, 20, "UTC").live).toHaveLength(1);                   // no arrival time: stays live
  });
  it("end of day: yesterday's ticket is earlier even inside the window", () => {
    const nowLate = Date.parse("2026-11-02T00:10:00Z");
    const t = (mins: number) => ({ id: "a", number: 1, status: "pending", created_at: new Date(nowLate - mins * 60_000).toISOString() });
    expect(splitTickets([t(15)], nowLate, 20, "UTC").earlier).toHaveLength(1); // 23:55 the day before, 15 min ago
    expect(splitTickets([t(15)], nowLate, 20, "Asia/Kolkata").live).toHaveLength(1); // same IST day (05:25 -> 05:40)
  });
});
