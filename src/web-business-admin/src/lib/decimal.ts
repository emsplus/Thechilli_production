/** Exact decimal multiplication for Decimal strings (BigInt, no floats). Used for line totals (quantity x unit price). */
function parts(v: string | number): { n: bigint; scale: number } | null {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(String(v).trim());
  if (!m || (m[2] === "" && !m[3])) return null;
  const frac = m[3] ?? "";
  const n = BigInt((m[2] || "0") + frac);
  return { n: m[1] ? -n : n, scale: frac.length };
}
export function mulDecimal(a: string | number, b: string | number, decimals = 2): string {
  const x = parts(a), y = parts(b);
  if (!x || !y) return (0).toFixed(decimals);
  let n = x.n * y.n;
  const drop = x.scale + y.scale - decimals;
  if (drop > 0) { const p = 10n ** BigInt(drop); const neg = n < 0n; let abs = neg ? -n : n; abs = (abs + p / 2n) / p; n = neg ? -abs : abs; }
  else if (drop < 0) n *= 10n ** BigInt(-drop);
  const neg = n < 0n; const s = (neg ? -n : n).toString().padStart(decimals + 1, "0");
  return `${neg && n !== 0n ? "-" : ""}${s.slice(0, s.length - decimals)}${decimals ? "." + s.slice(s.length - decimals) : ""}`;
}
export const isDecimal = (v: string) => /^\d+(\.\d+)?$/.test(v.trim());
/** Exact a / b rounded half up to `decimals` places (BigInt, no floats). Returns null for a bad or zero divisor. */
export function divDecimal(a: string | number, b: string | number, decimals = 4): string | null {
  const x = parts(a), y = parts(b);
  if (!x || !y || y.n === 0n || x.n < 0n || y.n < 0n) return null;
  const num = x.n * 10n ** BigInt(y.scale + decimals), den = y.n * 10n ** BigInt(x.scale);
  const q = (2n * num + den) / (2n * den);
  const s = q.toString().padStart(decimals + 1, "0");
  return decimals ? `${s.slice(0, s.length - decimals)}.${s.slice(s.length - decimals)}` : s;
}
/** "1.500" -> "1.5", "2.000" -> "2": for showing and re-editing decimals. */
export const trimDecimal = (v: string) => (/^\d+\.\d+$/.test(v) ? v.replace(/0+$/, "").replace(/\.$/, "") : v);
/** Exact a + b for non-negative Decimal strings. */
export function addDecimal(a: string | number, b: string | number): string {
  const x = parts(a), y = parts(b);
  if (!x || !y) return "0";
  const sc = Math.max(x.scale, y.scale);
  const n = x.n * 10n ** BigInt(sc - x.scale) + y.n * 10n ** BigInt(sc - y.scale);
  const s = n.toString().padStart(sc + 1, "0");
  return sc ? `${s.slice(0, s.length - sc)}.${s.slice(s.length - sc)}` : s;
}
