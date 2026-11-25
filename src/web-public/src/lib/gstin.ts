/** GSTIN validation shared by the signup form and the tests. Format matches platform-core GSTIN_RE; the checksum (mod-36) is extra and client-side only. */
export const GSTIN_FORMAT = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** State / UT codes in use: 01-38, 97 (other territory), 99 (centre jurisdiction). */
export function isKnownStateCode(code: string): boolean {
  const n = Number(code);
  return /^\d{2}$/.test(code) && ((n >= 1 && n <= 38) || n === 97 || n === 99);
}

export function gstinCheckChar(first14: string): string | null {
  if (first14.length !== 14) return null;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]!);
    if (v < 0) return null;
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36]!;
}

export function normalizeGstin(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export type GstinProblem = "length" | "format" | "state" | "checksum";

/** null when empty (the field is optional) or valid. */
export function gstinProblem(raw: string): GstinProblem | null {
  const g = normalizeGstin(raw);
  if (!g) return null;
  if (g.length !== 15) return "length";
  if (!GSTIN_FORMAT.test(g)) return "format";
  if (!isKnownStateCode(g.slice(0, 2))) return "state";
  return gstinCheckChar(g.slice(0, 14)) === g[14] ? null : "checksum";
}

/** Two-digit state code the API wants in `state_code`. */
export function stateCodeOf(gstin: string): string | undefined {
  const g = normalizeGstin(gstin);
  return gstinProblem(g) === null && g ? g.slice(0, 2) : undefined;
}
