import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { alreadySent, dailyReportApi, dailyReportMissing, isHHMM, skipReason, statusLabel, statusTone, timeLabel, triggerLabel, type DailyReportRow } from "./dailyReport";

const row = (o: Partial<DailyReportRow> = {}): DailyReportRow => ({ id: "r1", outlet_id: "o1", business_date: "2026-11-01", trigger: "manual", status: "sent", attempts: 1, recipients: 2, ...o });

describe("daily report helpers", () => {
  it("time format", () => {
    expect(isHHMM("23:00")).toBe(true);
    expect(isHHMM("24:00")).toBe(false);
    expect(isHHMM("9:00")).toBe(false);
    expect(timeLabel("23:00")).toBe("11:00 pm");
    expect(timeLabel("00:30")).toBe("12:30 am");
    expect(timeLabel("12:05")).toBe("12:05 pm");
  });
  it("labels", () => {
    expect(triggerLabel("z_close")).toBe("Day closed");
    expect(triggerLabel("schedule")).toBe("Scheduled");
    expect(statusLabel("queued")).toBe("Sending");
    expect(statusTone("failed")).toBe("danger");
    expect(statusTone("skipped")).toBe("neutral");
    expect(skipReason("no activity")).toBe("No sales that day");
    expect(skipReason(null)).toBeNull();
  });
  it("alreadySent: an old sent row came back from send now", () => {
    const click = Date.parse("2026-11-01T18:00:00Z");
    expect(alreadySent(row({ sent_at: "2026-11-01T17:30:00Z" }), click)).toBe(true);
    expect(alreadySent(row({ sent_at: "2026-11-01T18:00:01Z" }), click)).toBe(false);
    expect(alreadySent(row({ status: "failed", sent_at: "2026-11-01T17:30:00Z" }), click)).toBe(false);
  });
  it("missing routes", () => {
    expect(dailyReportMissing(new ApiError(404, "Not Found"))).toBe(true);
    expect(dailyReportMissing(new ApiError(403, "Missing permission"))).toBe(false);
  });
});

describe("dailyReportApi (fetch mocked)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("PUT sends only the changed field; send posts resend", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await dailyReportApi.save({ daily_report_time: "22:30" });
    await dailyReportApi.send({ resend: true });
    await dailyReportApi.history(10);
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toMatch(/\/restaurant\/daily-report$/);
    expect(calls[0][1].method).toBe("PUT");
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ daily_report_time: "22:30" });
    expect(calls[1][0]).toMatch(/\/restaurant\/daily-report\/send$/);
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ resend: true });
    expect(calls[2][0]).toMatch(/\/history\?limit=10$/);
  });
});
