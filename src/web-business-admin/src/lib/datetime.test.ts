import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatDayMonth, formatMonthYear, formatTime, formatWeekdayDate, relativeTime } from "./datetime";

describe("one app-wide date / time style (en-IN, Asia/Kolkata)", () => {
  const iso = "2026-10-05T12:27:09Z"; // 05 Oct 2026, 5:57:09 PM in Kolkata
  it("date is dd MMM yyyy", () => {
    expect(formatDate(iso)).toBe("05 Oct 2026");
    expect(formatDate("2026-10-31")).toBe("31 Oct 2026");
  });
  it("time is h:mm a (upper-case AM / PM, no leading zero)", () => {
    expect(formatTime(iso)).toBe("5:57 PM");
    expect(formatTime("2026-10-05T19:00:00Z")).toBe("12:30 AM");
    expect(formatTime("2026-10-05T06:30:00Z")).toBe("12:00 PM");
    expect(formatTime(iso, undefined, true)).toBe("5:57:09 PM");
  });
  it("date and time together", () => {
    expect(formatDateTime(iso)).toBe("05 Oct 2026, 5:57 PM");
  });
  it("Kolkata is the default zone, whatever the device zone; a restaurant zone can be passed", () => {
    expect(formatDate("2026-10-31T20:00:00Z")).toBe("01 Nov 2026");
    expect(formatDateTime("2026-10-31T20:00:00Z", "UTC")).toBe("31 Oct 2026, 8:00 PM");
  });
  it("calendar dates are never shifted by a zone", () => {
    expect(formatDate("2026-01-01", "Pacific/Kiritimati")).toBe("01 Jan 2026");
  });
  it("short forms keep the same day / month style", () => {
    expect(formatDayMonth("2026-10-05")).toBe("05 Oct");
    expect(formatWeekdayDate("2026-10-31")).toBe("Sat, 31 Oct");
    expect(formatWeekdayDate("2026-10-31", undefined, true)).toBe("Saturday, 31 Oct 2026");
    expect(formatMonthYear("2026-10")).toBe("Oct 2026");
  });
  it("empty or invalid input is a dash", () => {
    expect(formatDate(null)).toBe("-");
    expect(formatDateTime("nope")).toBe("-");
    expect(formatTime(undefined)).toBe("-");
  });
  it("relative time falls back to the date style", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    expect(relativeTime("2026-10-31T11:50:00Z", now)).toBe("10 min ago");
    expect(relativeTime("2026-09-01T10:00:00Z", now)).toBe("01 Sep 2026");
  });
});
