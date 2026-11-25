/** Prices are decimal strings from the API; compute in integer minor units to avoid float drift. */
export const toMinor = (s: string): number => Math.round(Number(s) * 100);
export const fromMinor = (n: number): string => (n / 100).toFixed(2);
export const addDecimal = (a: string, b: string): string => fromMinor(toMinor(a) + toMinor(b));
export const mulDecimal = (a: string, q: number): string => fromMinor(toMinor(a) * q);

/** Indian digit grouping: the last three digits, then pairs (1,23,456). `digits` is an unsigned integer string. */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${head},${digits.slice(-3)}`;
}

export const DEFAULT_SYMBOL = "₹";
let symbol = DEFAULT_SYMBOL;
/**
 * Owner decision 2026-10-31 (docs/DECISIONS.md): all money is INR. The restaurant's currency from GET /restaurant is
 * passed in, but only an INR answer is honoured; legacy AED/GBP restaurants (old backends, demo data) still show ₹,
 * and a restaurant with no currency defaults to ₹. Screens just call formatMoney.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept so a later multi-currency change has one place to edit
export const currencySymbolFor = (reported: string | null | undefined): string => DEFAULT_SYMBOL;
export const setCurrencySymbol = (s: string | null | undefined) => { symbol = currencySymbolFor(s); };

/** "1,23,456.50" with a leading symbol. Negative values keep the sign in front of the symbol. */
export function formatMoney(s: string, sym: string = symbol): string {
  const minor = toMinor(s);
  if (!Number.isFinite(minor)) return `${sym}0.00`;
  const abs = Math.abs(minor);
  const whole = groupIndian(String(Math.floor(abs / 100)));
  return `${minor < 0 ? "-" : ""}${sym}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** Variant price delta label: "+₹20.00" or "-₹10.00" (never "+-"); empty for no change. */
export function formatDelta(s: string, sym: string = symbol): string {
  const minor = toMinor(s);
  if (!minor) return "";
  return `${minor < 0 ? "-" : "+"}${formatMoney(String(Math.abs(minor) / 100), sym)}`;
}

/** Menu-card price: "₹250" for whole rupees, "₹249.50" otherwise. Bills and totals keep formatMoney (always paise). */
export function formatPrice(s: string, sym: string = symbol): string {
  const full = formatMoney(s, sym);
  return full.endsWith(".00") ? full.slice(0, -3) : full;
}
