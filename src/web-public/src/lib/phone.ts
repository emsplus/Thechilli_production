/** Indian mobile normalisation: always "+91" + 10 digits starting 6-9. Accepts 98765 43210, 098765..., 91..., +91-..., 0091... */
export const INDIA_CC = "91";

export function normalizeIndianPhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let d = raw.replace(/[\s\-().]/g, "");
  if (!d) return null;
  if (!/^\+?\d+$/.test(d)) return null;
  d = d.replace(/^\+/, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 12 && d.startsWith(INDIA_CC)) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? `+${INDIA_CC}${d}` : null;
}

/** Pretty form for confirmation screens: +91 98765 43210 */
export function formatIndianPhone(e164: string): string {
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}
