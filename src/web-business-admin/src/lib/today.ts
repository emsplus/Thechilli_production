/**
 * The restaurant's calendar date ("2026-10-31") at `now` in its time zone (falls back to the device zone when the zone is unknown).
 * "Today" tiles query exactly this date (from = to = today), never "since the last end-of-day close".
 */
export function businessDate(now: Date, timeZone?: string | null): string {
  const fmt = (tz?: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  try { return fmt(timeZone || undefined); } catch { return fmt(undefined); }
}

/** Query string range for a today-only report: from_date = to_date = the business date. */
export const todayRange = (now: Date, timeZone?: string | null) => { const d = businessDate(now, timeZone); return { from: d, to: d }; };

/** Orders created in the range, from /reports/order-summary (every status, cancelled included). */
export const ordersCreated = (byStatus: Record<string, number> | undefined) => Object.values(byStatus ?? {}).reduce((n, k) => n + k, 0);
