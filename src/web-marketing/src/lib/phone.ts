/** Mirrors marketing-service normalize_phone: "+<digits>", national (leading 0) numbers get the default country code. */
export const DEFAULT_COUNTRY_CODE = "44";

export function normalizePhone(raw: string | null | undefined, cc = DEFAULT_COUNTRY_CODE): string | null {
  if (raw == null || !raw.trim()) return null;
  const s = raw.trim();
  let digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) { /* already international */ }
  else if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = cc + digits.replace(/^0+/, "");
  if (digits.length < 7 || digits.length > 15) throw new Error("phone number must have 7 to 15 digits");
  return "+" + digits;
}

/** Message for a form field, or null when the value is empty or valid. */
export function phoneError(raw: string): string | null {
  try { normalizePhone(raw); return null; } catch (e) { return (e as Error).message; }
}
