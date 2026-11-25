import { formatINR } from "@chilli/ui";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
/** "Asia/Kolkata"-free on purpose: the browser's local time. ICU says "Sept" for en-IN, so the month names are fixed here. */
const datePart = (x: Date) => `${pad(x.getDate())} ${MONTHS[x.getMonth()]} ${x.getFullYear()}`;
const timePart = (x: Date) => `${x.getHours() % 12 || 12}:${pad(x.getMinutes())} ${x.getHours() < 12 ? "AM" : "PM"}`;
/** Date-only API values ("2026-10-31") are calendar dates, not UTC instants. */
const parse = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso));

/** One house style for timestamps: "31 Oct 2026, 5:57 PM" (dd MMM yyyy, h:mm AM/PM). */
export const fmtDateTime = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const x = parse(iso);
  return `${datePart(x)}, ${timePart(x)}`;
};
export const fmtDate = (iso: string | null | undefined) => (iso ? datePart(parse(iso)) : "—");
export const fmtTime = (iso: string) => timePart(new Date(iso));

/**
 * Integer minor units -> "₹1,25,00,000" (lakh/crore grouping, from the design system); `compact` gives "₹12.3 L" / "₹1.2 Cr".
 * TheChilli.ai sells in India only: every amount is shown in rupees, whatever currency code a record carries (old demo/test
 * rows were created with a non-INR default; UI review MK-1). The `currency` argument is kept for call-site compatibility.
 */
export function fmtMoney(minor: number, _currency?: string, opts: { compact?: boolean } = {}): string {
  return formatINR(minor, opts);
}
export const fmtPct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;

/** "12 Oct, 4:30 pm" -> local date-time-input value ("2026-10-29T16:30") for <input type="datetime-local">. */
export function toLocalInput(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}
export const startOfToday = () => { const x = new Date(); x.setHours(0, 0, 0, 0); return x; };
export const endOfToday = () => { const x = new Date(); x.setHours(23, 59, 59, 999); return x; };
export const isOverdue = (iso: string | null) => !!iso && new Date(iso).getTime() < Date.now();

/** Local date-time-input value for N days from now at the given hour. */
export function inputAt(days: number, hour: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setHours(hour, 0, 0, 0);
  return toLocalInput(d);
}
