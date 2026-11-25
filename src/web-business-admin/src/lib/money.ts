/**
 * Money helpers that never use floating point for arithmetic.
 * The API sends money as Decimal strings ("12.50"); we keep them as strings and use BigInt
 * (scaled integers) for any sum or rounding.
 */
const SCALE_DIGITS = 6; // enough for any value the API returns

function toScaled(v: string | number): bigint {
  const s = String(v).trim().replace(/,/g, "");
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return 0n;
  const frac = (m[3] ?? "").padEnd(SCALE_DIGITS, "0").slice(0, SCALE_DIGITS);
  const n = BigInt((m[2] || "0") + frac);
  return m[1] ? -n : n;
}

function fromScaled(n: bigint, decimals: number): string {
  const neg = n < 0n;
  let abs = neg ? -n : n;
  const drop = SCALE_DIGITS - decimals;
  if (drop > 0) { const p = 10n ** BigInt(drop); abs = (abs + p / 2n) / p; } // round half up
  else if (drop < 0) abs *= 10n ** BigInt(-drop);
  const s = abs.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = decimals ? "." + s.slice(s.length - decimals) : "";
  return (neg && abs !== 0n ? "-" : "") + int + frac;
}

/** 12,34,567: last three digits, then groups of two (same rule as groupIndian in @chilli/ui). Kept local because e2e specs import this file in plain Node, where the ESM-only package cannot load. */
function groupIndian(intDigits: string): string {
  if (intDigits.length <= 3) return intDigits;
  const head = intDigits.slice(0, -3), tail = intDigits.slice(-3);
  return head.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + tail;
}

/** "1234.5" -> "1,234.50"; "1234567" -> "12,34,567" (Indian lakh/crore grouping, same as <Money>). String-based, rounds half up. Invalid input -> "0.00". */
export function formatMoney(value: string | number | null | undefined, decimals = 2): string {
  const plain = fromScaled(toScaled(value ?? "0"), decimals);
  const [i, f] = plain.split(".");
  const grouped = groupIndian(i.replace("-", "")); const sign = i.startsWith("-") ? "-" : "";
  return `${sign}${f ? `${grouped}.${f}` : grouped}`;
}

/** Exact sum of Decimal strings, returned as a plain decimal string with `decimals` places. */
export function sumMoney(values: (string | number)[], decimals = 2): string {
  return fromScaled(values.reduce<bigint>((a, v) => a + toScaled(v), 0n), decimals);
}

/** Exact value * integer quantity. */
export function mulMoney(value: string | number, qty: number, decimals = 2): string {
  return fromScaled(toScaled(value) * BigInt(Math.round(qty)), decimals);
}

/** -1 | 0 | 1 comparison of two Decimal strings. */
export function cmpMoney(a: string | number, b: string | number): number {
  const x = toScaled(a), y = toScaled(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function isNegativeMoney(v: string | number): boolean { return toScaled(v) < 0n; }

/** value * percent / 100 (e.g. a GST estimate), rounded half up to `decimals`. Exact BigInt math, non-negative values. */
export function pctOfMoney(value: string | number, percent: string | number, decimals = 2): string {
  const prod = toScaled(value) * toScaled(percent); // scale 1e12
  const div = 10n ** BigInt(SCALE_DIGITS) * 100n;
  return fromScaled((prod + div / 2n) / div, decimals);
}

/**
 * Printed prefix of the money on every screen: "₹". The product is INR only (owner rule), so a missing or unexpected
 * currency code still shows rupees. `code` is kept so callers stay unchanged; "" (config not known yet) also shows ₹.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function currencyPrefix(code?: string | null): string {
  return "₹";
}
/** The rupee as plain ASCII, for printed output whose font has no ₹ glyph (thermal code pages). The only place it is spelled out. */
export const RUPEE_ASCII = "Rs.";

/** formatCurrency for a printer or font without the ₹ glyph: RUPEE_ASCII, a space, then 1,23,456.50 (negatives start with "-"). */
export function formatInrAscii(value: string | number | null | undefined, decimals = 2): string {
  const t = formatMoney(value, decimals);
  return t.startsWith("-") ? `-${RUPEE_ASCII} ${t.slice(1)}` : `${RUPEE_ASCII} ${t}`;
}

/** The currency marker without padding: "₹" (for labels like "Price (₹)"). */
export const currencyMark = (code?: string | null) => currencyPrefix(code).trim();

/** "123456.5" -> "₹1,23,456.50"; negatives -> "-₹5.00". Plain text (toasts, aria-labels, messages). */
export function formatCurrency(value: string | number | null | undefined, code?: string | null, decimals = 2): string {
  const t = formatMoney(value, decimals);
  return t.startsWith("-") ? `-${currencyPrefix(code)}${t.slice(1)}` : `${currencyPrefix(code)}${t}`;
}

/**
 * Short money for tiles and charts, Indian style: 1,23,456 -> "1.2 L", 1,23,45,678 -> "1.2 Cr" (hi: "लाख" / "करोड़").
 * Truncates, never rounds up (9,99,999 reads 9.9 L, not 10 L). Under one lakh it is the full figure with two decimals. This is the single
 * place the app abbreviates money; pages never format lakh/crore themselves.
 */
export function formatCompactMoney(value: string | number | null | undefined, code?: string | null, locale: "en" | "hi" | "hinglish" = "en"): string {
  const full = formatMoney(value, 2).split(".")[0].replace(/[^0-9-]/g, "");
  const neg = full.startsWith("-");
  const rupees = BigInt(full.replace("-", "") || "0");
  const unit = (n: bigint, big: boolean) => {
    const tenths = (rupees * 10n) / n;
    const num = tenths % 10n === 0n ? `${tenths / 10n}` : `${tenths / 10n}.${tenths % 10n}`;
    const word = big ? (locale === "hi" ? "करोड़" : "Cr") : (locale === "hi" ? "लाख" : locale === "hinglish" ? "lakh" : "L");
    return `${num} ${word}`;
  };
  const body = rupees >= 10_000_000n ? unit(10_000_000n, true) : rupees >= 100_000n ? unit(100_000n, false) : null;
  if (body === null) return formatCurrency(value, code, 2);
  return `${neg ? "-" : ""}${currencyPrefix(code)}${body}`;
}
