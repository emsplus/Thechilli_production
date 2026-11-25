/** "Reserved 7:30 pm · Asha" on a table tile (time in the phone's zone, 12-hour, lower-case am/pm as staff write it). */
export function reservationTime(startsAt: string, timeZone?: string): string {
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).replace(/\s?(AM|PM|am|pm)$/, (m) => ` ${m.trim().toLowerCase()}`);
}
export const reservationHint = (r: { guest_name: string; starts_at: string }, timeZone?: string): string =>
  `Reserved ${reservationTime(r.starts_at, timeZone)} · ${r.guest_name}`;
