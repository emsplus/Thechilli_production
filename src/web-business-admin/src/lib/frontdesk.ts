/** Pure helpers for Reservations and Attendance (unit tested). Times from the API are UTC with offset; shown in the outlet zone. */
import { formatTime, formatWeekdayDate } from "./datetime";
import type { AttendanceRecord, AvailabilityTable, Reservation } from "./extras";

const TZ_DEFAULT = "Asia/Kolkata";

/** "7:30 PM" in the restaurant's zone (lib/datetime: the one app-wide style). */
export function timeIn(iso: string | null | undefined, tz = TZ_DEFAULT): string {
  return formatTime(iso, tz);
}

/** "HH:MM" (24 h) of an ISO time in the zone: the value of a time input. */
export function hhmmIn(iso: string, tz = TZ_DEFAULT): string {
  const parts = new Intl.DateTimeFormat("en-IN", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  return `${parts.find((p) => p.type === "hour")?.value ?? "00"}:${parts.find((p) => p.type === "minute")?.value ?? "00"}`;
}

/** Naive local time for the API ("2026-10-31T19:30:00"): the server reads it in the outlet's zone. */
export const localStart = (date: string, hhmm: string) => `${date}T${hhmm}:00`;

/** "Thu, 31 Oct" for a YYYY-MM-DD. */
export function dayLabel(date: string): string {
  return formatWeekdayDate(date);
}

/** Indian mobile check before sending (the server normalises to +91). Empty is not allowed for a booking. */
/** The Guests field as typed ("2.5", "-3", "1e3" used to be silently turned into 25, 3 and 13: QA D20). null = fine. */
export function partyProblem(raw: string): string | null {
  const v = raw.trim();
  if (!/^\d+$/.test(v)) return "Guests must be a whole number, like 4";
  const n = Number(v);
  return n < 1 || n > 500 ? "Party size must be 1 to 500" : null;
}

export function bookingProblem(f: { guest: string; phone: string; party: string; time: string }): string | null {
  if (!f.guest.trim()) return "Enter the guest's name";
  const digits = f.phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 13) return "Enter a 10-digit mobile number, like 98765 43210";
  const partyBad = partyProblem(f.party);
  if (partyBad) return partyBad;
  if (!/^\d{2}:\d{2}$/.test(f.time)) return "Choose a time";
  return null;
}

/** One sentence for the availability hint. */
export function availabilityText(a: { available_count: number; party_size: number; tables: AvailabilityTable[] } | null): string {
  if (!a) return "";
  if (a.tables.length === 0) return "No tables set up yet. Add tables to hold them for bookings.";
  const fits = a.tables.filter((t) => t.fits).length;
  if (fits === 0) return `No table seats ${a.party_size}. Book without a table or join tables when they arrive.`;
  if (a.available_count === 0) return `All tables for ${a.party_size} are booked at this time.`;
  return `${a.available_count} ${a.available_count === 1 ? "table is" : "tables are"} free for ${a.party_size} at this time.`;
}

export const STATUS_TEXT: Record<Reservation["status"], string> = { booked: "Booked", seated: "Seated", cancelled: "Cancelled", no_show: "No-show" };

/** Day summary: "6 bookings · 18 guests · 2 seated". Cancelled / no-show are not counted as guests. */
export function daySummary(list: Reservation[]): string {
  const live = list.filter((r) => r.status === "booked" || r.status === "seated");
  const guests = live.reduce((n, r) => n + r.party_size, 0);
  const seated = list.filter((r) => r.status === "seated").length;
  return `${list.length} ${list.length === 1 ? "booking" : "bookings"} · ${guests} ${guests === 1 ? "guest" : "guests"} · ${seated} seated`;
}

/** "3 h 05 m" from minutes. */
export function hoursText(min: number): string {
  const m = Math.max(0, Math.round(min));
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} m`;
}

/** Datetime-local input value ("2026-10-31T09:05") of an ISO time, in the zone. */
export function localInputValue(iso: string | null, tz = TZ_DEFAULT): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

/** Edit reason rule shared with the server (3-300 characters). */
export const reasonOk = (r: string) => r.trim().length >= 3 && r.trim().length <= 300;

/** Attendance rows sorted: open first, then by clock-in (newest first). */
export const sortRecords = (rs: AttendanceRecord[]) => [...rs].sort((a, b) => Number(b.open) - Number(a.open) || b.clock_in_at.localeCompare(a.clock_in_at));
