import { cmpMoney, sumMoney } from "./money";

/** An opening float above this (rupees) is unusual on its own. */
export const FLOAT_LIMIT = "10000";
/** ... and so is one more than this many times the average of the last opening floats. */
export const FLOAT_MULTIPLE = 3;
export const FLOAT_HISTORY = 5;
/** A shift open longer than this needs closing before a new day starts. */
export const SHIFT_STALE_HOURS = 24;

/** Whole hours a shift has been open (floor). Uses the server's `opened_at` instant, so the restaurant timezone does not change it. */
export function hoursOpen(openedAt: string, now: number): number {
  const t = Date.parse(openedAt);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 3_600_000)) : 0;
}
export const shiftTooLong = (openedAt: string, now: number) => now - Date.parse(openedAt) > SHIFT_STALE_HOURS * 3_600_000;

/** Average of up to `FLOAT_HISTORY` earlier opening floats (Decimal strings); null when there are none. Two decimals. */
export function averageFloat(prev: string[]): string | null {
  const last = prev.slice(0, FLOAT_HISTORY);
  if (!last.length) return null;
  const total = sumMoney(last);
  const paise = Math.round((Number(total) * 100) / last.length);
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;
}

/** Why an opening float looks unusual (null = normal). `previous`: the opening floats of the last shifts, newest first. */
export function unusualFloat(amount: string, previous: string[]): { reason: "limit" | "average"; limit: string; average?: string } | null {
  if (cmpMoney(amount, FLOAT_LIMIT) > 0) return { reason: "limit", limit: FLOAT_LIMIT };
  const avg = averageFloat(previous);
  if (avg !== null && cmpMoney(avg, 0) > 0 && Number(amount) > Number(avg) * FLOAT_MULTIPLE) return { reason: "average", limit: FLOAT_LIMIT, average: avg };
  return null;
}
