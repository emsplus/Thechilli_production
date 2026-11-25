/** Partner invitation links: `{SIGNUP_BASE_URL}/signup?token=<token_urlsafe(32)>` (marketing-service `invite_link`).
 *  Everything read from the URL or from the API is treated as untrusted text: it is shape-checked, clamped and only ever
 *  rendered through React text nodes (never as HTML, never in an attribute that can run script). */

const TOKEN = /^[A-Za-z0-9_-]{10,200}$/; // marketing-service TokenIn: 10..200 chars; secrets.token_urlsafe alphabet
const REF = /^[A-Za-z0-9]{4,32}$/; // marketing-service ReferralCreate.code pattern

export interface InviteParams { token?: string; ref?: string; badToken: boolean }

export function parseInviteParams(search: string): InviteParams {
  const q = new URLSearchParams(search);
  const rawToken = q.get("token");
  const rawRef = q.get("ref");
  const token = rawToken !== null && TOKEN.test(rawToken.trim()) ? rawToken.trim() : undefined;
  const ref = rawRef !== null && REF.test(rawRef.trim()) ? rawRef.trim().toUpperCase() : undefined;
  return { token, ref, badToken: rawToken !== null && !token };
}

/** Plain text only: strings, control characters and angle brackets removed, whitespace collapsed, clamped. */
export function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return s || undefined;
}

export interface Invitation {
  valid: boolean;
  /** ISO timestamp from the API (a valid date only). */
  expiresAt?: string;
  /** Optional extras: today's marketing-service answers only {valid, expires_at}; see docs/INVITE_LINK_GAP.md. */
  invitedBy?: string; businessName?: string; contactName?: string;
}

/** Narrow an API answer (`unknown`) to what the page may use. Anything unexpected is dropped. */
export function toInvitation(raw: unknown): Invitation {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (r.valid !== true) return { valid: false };
  const exp = typeof r.expires_at === "string" && !Number.isNaN(Date.parse(r.expires_at)) ? r.expires_at : undefined;
  return {
    valid: true, expiresAt: exp,
    invitedBy: cleanText(r.invited_by, 80), businessName: cleanText(r.business_name, 160), contactName: cleanText(r.contact_name, 120),
  };
}

export function formatExpiry(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata", timeZoneName: "short" }).format(new Date(iso));
}
