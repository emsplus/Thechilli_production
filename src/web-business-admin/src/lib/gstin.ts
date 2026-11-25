import { GST_STATES } from "./gstStates";

/** GSTIN checks for the sign-up form (the server is the authority; this only catches typos early). */

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
// 2 digit state code (01-38, 97 other territory, 99 centre), 10 character PAN, entity number, 'Z', check character.
const SHAPE = /^(0[1-9]|[12]\d|3[0-8]|9[79])[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EXTRA_CODES: Record<string, string> = { "97": "Other Territory", "99": "Centre Jurisdiction" };

export const normaliseGstin = (v: string) => v.replace(/[\s-]/g, "").toUpperCase();

/** The standard GSTIN check character (mod 36 over the first 14 characters, weights 1, 2, 1, 2, ...). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(first14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36]!;
}

/** Error text for a GSTIN, or null when it is empty (optional) or valid. */
export function gstinError(value: string): string | null {
  const v = normaliseGstin(value);
  if (!v) return null;
  if (v.length !== 15) return `A GSTIN has 15 characters (this has ${v.length}), like 27AAPFU0939F1ZV. Or leave it empty.`;
  if (!SHAPE.test(v)) return "That is not a GSTIN: 2-digit state code, 10-character PAN, entity number, Z, check character.";
  if (gstinCheckChar(v.slice(0, 14)) !== v[14]) return "The last character (check digit) does not match. Check the GSTIN for a typo.";
  return null;
}

/** State or UT named by the first two digits, or null if they are not a GST state code. */
export function gstinState(value: string): string | null {
  const code = normaliseGstin(value).slice(0, 2);
  return GST_STATES[code] ?? EXTRA_CODES[code] ?? null;
}
