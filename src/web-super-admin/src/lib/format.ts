/** Display helpers. Dates render in the viewer's locale, India-first (en-IN). Money is always integer paise. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
/** Fixed month names: ICU gives "Sept" for en-IN. Viewer's local time. */
const datePart = (x: Date) => `${pad(x.getDate())} ${MONTHS[x.getMonth()]} ${x.getFullYear()}`;
const timePart = (x: Date) => `${x.getHours() % 12 || 12}:${pad(x.getMinutes())} ${x.getHours() < 12 ? "AM" : "PM"}`;
/** Date-only API values ("2026-10-31") are calendar dates, not UTC instants. */
const parse = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso));

/** One house style for timestamps: "31 Oct 2026, 5:57 PM" (dd MMM yyyy, h:mm AM/PM). */
export const fmtDateTime = (iso: string | null | undefined) => (iso ? `${datePart(parse(iso))}, ${timePart(parse(iso))}` : "–");
export const fmtDate = (iso: string | null | undefined) => (iso ? datePart(parse(iso)) : "–");
/** Short month label for charts: "Oct 2026" from "2026-10". */
export const fmtMonth = (ym: string) => { const [y, m] = ym.split("-").map(Number); return `${MONTHS[(m ?? 1) - 1]} ${y}`; };
export const fmtNumber = (n: number) => new Intl.NumberFormat("en-IN").format(n);

export function timeAgo(iso: string, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Basis points to percent text without float noise: 1800 -> "18%", 250 -> "2.5%". */
export const bpsToPercent = (bps: number) => `${(bps / 100).toString()}%`;

/** AI cost is integer micro-rupees (1 rupee = 1,000,000). Convert to paise (rounded half up) for the shared money formatter. */
export const microInrToPaise = (micro: number) => Math.floor((micro + 5_000) / 10_000);

export const titleCase = (s: string) => s.replace(/[_.]/g, " ").replace(/^./, (c) => c.toUpperCase());

export function minutesLeft(iso: string, nowMs = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - nowMs) / 60_000));
}

/** "1 outlet", "3 outlets": units arrive plural from the catalog ("outlets"), so singularise for exactly 1. */
export function fmtLimit(n: number, unit?: string | null): string {
  if (!unit) return String(n);
  const u = n === 1 && unit.length > 1 && unit.endsWith("s") ? unit.slice(0, -1) : unit;
  return `${n} ${u}`;
}

/** Event details as readable text ("Attempts: 5 · Path: /x") instead of raw JSON. Nested values are flattened. */
export function fmtDetails(details: unknown): string {
  const parts: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (v === null || v === undefined || v === "") return;
    if (Array.isArray(v)) { if (v.length) parts.push(`${titleCase(key)}: ${v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ")}`); return; }
    if (typeof v === "object") { for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, key ? `${key}.${k}` : k); return; }
    parts.push(`${titleCase(key)}: ${typeof v === "boolean" ? (v ? "yes" : "no") : String(v)}`);
  };
  if (details && typeof details === "object") walk(details, "");
  else if (details !== null && details !== undefined) return String(details);
  return parts.join(" · ");
}
