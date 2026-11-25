import { describe, expect, it } from "vitest";
import { formatWait, KITCHEN_TARGET_MIN, minutesSince, ticketWaitState, waitCounts, waitState } from "./ticketAge";

const now = Date.parse("2026-10-30T12:00:00Z");
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();

describe("waitState: three states around the target", () => {
  it("defaults to a 15-minute target", () => expect(KITCHEN_TARGET_MIN).toBe(15));
  it("is ok below the target, warn from the target, late from twice the target", () => {
    expect(waitState(0)).toBe("ok");
    expect(waitState(14)).toBe("ok");
    expect(waitState(15)).toBe("warn");
    expect(waitState(29)).toBe("warn");
    expect(waitState(30)).toBe("late");
    expect(waitState(265)).toBe("late");
  });
  it("follows a custom target", () => {
    expect(waitState(9, 10)).toBe("ok");
    expect(waitState(10, 10)).toBe("warn");
    expect(waitState(20, 10)).toBe("late");
  });
});

describe("ticketWaitState", () => {
  it("only new and preparing tickets can run late", () => {
    expect(ticketWaitState("pending", at(40), now)).toBe("late");
    expect(ticketWaitState("preparing", at(20), now)).toBe("warn");
    for (const s of ["ready", "served", "cancelled"]) expect(ticketWaitState(s, at(300), now)).toBe("ok");
  });
  it("a missing or unreadable time is never late", () => {
    expect(ticketWaitState("pending", null, now)).toBe("ok");
    expect(ticketWaitState("pending", "nope", now)).toBe("ok");
  });
});

describe("minutesSince", () => {
  it("accepts epoch ms and ISO text, never negative", () => {
    expect(minutesSince(now - 90_000, now)).toBe(1);
    expect(minutesSince(at(12), now)).toBe(12);
    expect(minutesSince(now + 60_000, now)).toBe(0);
    expect(minutesSince(undefined, now)).toBeNull();
  });
});

describe("formatWait: human text, not '265 min'", () => {
  it.each([[0, "0 min"], [12, "12 min"], [59, "59 min"], [60, "1 h"], [265, "4 h 25 min"], [1501, "25 h 1 min"]] as const)("%i -> %s", (m, s) => {
    expect(formatWait(m)).toBe(s);
  });
});

describe("waitCounts (Today tile)", () => {
  it("counts getting-late and late tickets that are still being worked", () => {
    expect(waitCounts([
      { status: "pending", created_at: at(5) }, { status: "pending", created_at: at(16) }, { status: "preparing", created_at: at(31) },
      { status: "ready", created_at: at(60) }, { status: "served", created_at: at(90) }, { status: "cancelled", created_at: at(90) },
      { status: "pending" },
    ], now)).toEqual({ warn: 1, late: 1 });
  });
});

describe("KOT-only kitchen: no late warning at all (nobody clicks in the kitchen)", () => {
  it("tickets are never 'being worked', whatever their age or status; track mode is unchanged", () => {
    for (const st of ["pending", "preparing", "ready"]) expect(ticketWaitState(st, at(90), now, 15, "kot_only")).toBe("ok");
    expect(ticketWaitState("pending", at(31), now, 15, "track")).toBe("late");
    expect(waitCounts([{ status: "pending", created_at: at(40) }, { status: "pending", created_at: at(16) }], now, 15, "kot_only")).toEqual({ warn: 0, late: 0 });
  });
});
