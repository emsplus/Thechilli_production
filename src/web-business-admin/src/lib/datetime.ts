/**
 * THE date / time formatter of the app (one style everywhere, docs/UI_REVIEW.md BA-17):
 *   date      "05 Oct 2026"            (dd MMM yyyy)
 *   time      "5:57 PM"                (h:mm a)
 *   date+time "05 Oct 2026, 5:57 PM"
 * Locale en-IN, zone Asia/Kolkata unless a caller passes the restaurant's own zone. Plain calendar dates
 * ("2026-10-05") are formatted as that calendar day, never shifted by a zone. Never use toLocale*String in pages.
 */
export const APP_LOCALE = "en-IN";
export const APP_TZ = "Asia/Kolkata";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

type Input = string | number | Date | null | undefined;
interface Parts { y: number; m: number; d: number; h: number; min: number; s: number; wd: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function zoned(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    try { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short" }); }
    catch { f = new Intl.DateTimeFormat("en-CA", { timeZone: APP_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short" }); }
    fmtCache.set(tz, f);
  }
  return f;
}
const WD_SHORT: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of `v` in `tz`; a plain "YYYY-MM-DD" is that calendar day at 00:00. null when unparseable. */
function parts(v: Input, tz: string): Parts | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" && DATE_ONLY.test(v)) {
    const [y, m, d] = v.split("-").map(Number);
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return Number.isNaN(wd) ? null : { y, m, d, h: 0, min: 0, s: 0, wd };
  }
  const t = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(t.getTime())) return null;
  const p = zoned(tz).formatToParts(t);
  const get = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return { y: +get("year"), m: +get("month"), d: +get("day"), h: +get("hour") % 24, min: +get("minute"), s: +get("second"), wd: WD_SHORT[get("weekday")] ?? 0 };
}

const pad = (n: number) => String(n).padStart(2, "0");
const dateOf = (p: Parts) => `${pad(p.d)} ${MONTHS[p.m - 1]} ${p.y}`;
const timeOf = (p: Parts, seconds = false) => `${p.h % 12 || 12}:${pad(p.min)}${seconds ? `:${pad(p.s)}` : ""} ${p.h < 12 ? "AM" : "PM"}`;

/** "05 Oct 2026". */
export function formatDate(v: Input, tz: string = APP_TZ): string {
  const p = parts(v, tz); return p ? dateOf(p) : "-";
}
/** "5:57 PM" (with `seconds`: "5:57:09 PM"). */
export function formatTime(v: Input, tz: string = APP_TZ, seconds = false): string {
  const p = parts(v, tz); return p ? timeOf(p, seconds) : "-";
}
/** "05 Oct 2026, 5:57 PM". */
export function formatDateTime(v: Input, tz: string = APP_TZ, seconds = false): string {
  const p = parts(v, tz); return p ? `${dateOf(p)}, ${timeOf(p, seconds)}` : "-";
}
/** "05 Oct": chart axes and tight lists only (same day / month style, no year). */
export function formatDayMonth(v: Input, tz: string = APP_TZ): string {
  const p = parts(v, tz); return p ? `${pad(p.d)} ${MONTHS[p.m - 1]}` : "-";
}
/** "Sat, 05 Oct" (`long`: "Saturday, 05 Oct 2026"). */
export function formatWeekdayDate(v: Input, tz: string = APP_TZ, long = false): string {
  const p = parts(v, tz);
  if (!p) return "-";
  return long ? `${WEEKDAYS[p.wd]}, ${dateOf(p)}` : `${WEEKDAYS[p.wd].slice(0, 3)}, ${pad(p.d)} ${MONTHS[p.m - 1]}`;
}
/** "Oct 2026" for a "YYYY-MM" month key or any date. */
export function formatMonthYear(v: Input, tz: string = APP_TZ): string {
  const s = typeof v === "string" && /^\d{4}-\d{2}$/.test(v) ? `${v}-01` : v;
  const p = parts(s, tz); return p ? `${MONTHS[p.m - 1]} ${p.y}` : "-";
}

/** Local-time helpers shared by the admin pages. Never call during render of a prerendered tree without an effect. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Calendar arithmetic on YYYY-MM-DD, in UTC so the browser's own zone/DST can never shift the date. */
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** Today's date (YYYY-MM-DD) in an IANA zone, e.g. the restaurant's "Asia/Kolkata", whatever the browser's zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  try {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch { return isoDate(now); } // unknown zone: fall back to the device's date
}
/** "5 min ago", "yesterday", "3 days ago". `now` is passed in so callers control the clock (effects/state). */
export function relativeTime(v: string | null | undefined, now: number): string {
  if (!v) return "-";
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return "-";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  return formatDate(v);
}
