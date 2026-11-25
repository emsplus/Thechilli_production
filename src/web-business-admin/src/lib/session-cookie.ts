/**
 * Browser session layout (shared by the client, the BFF route handlers in src/app/bff and the e2e helpers).
 *
 *  pos_rt       httpOnly  path=/bff/auth  rotating 30-day refresh token. JavaScript can never read it.
 *  pos_at       httpOnly  path=/bff/auth  copy of the current short-lived access token, so a page load reuses it instead of
 *                                         rotating the refresh token every time.
 *  pos_session  readable  path=/          NOT a credential: "v1.<session id>.<restaurant id>.<user id>". It only tells the app,
 *                                         synchronously and offline, that this device has a session and whose local data
 *                                         (offline queue, menu snapshot) belongs to it.
 *
 * All three are SameSite=Strict, and Secure except on plain-http localhost (src/server/bff.ts). The access token itself
 * lives only in memory (src/lib/api.ts).
 */
export const RT_COOKIE = "pos_rt";
export const AT_COOKIE = "pos_at";
export const HINT_COOKIE = "pos_session";
export const BFF_PATH = "/bff/auth";
/** Custom header every BFF call must carry: a cross-site form or `fetch` cannot add it without a CORS preflight, which is never granted. */
export const CSRF_HEADER = "x-pos-csrf";
/** Refresh tokens live 30 days on the API (pos-service REFRESH_TOKEN_DAYS); the cookies follow. */
export const SESSION_MAX_AGE = 30 * 24 * 3600;

export interface SessionHint { sid: string; rid: string | null; sub: string | null }

const SAFE = /^[A-Za-z0-9_-]*$/;

export function encodeHint(h: SessionHint): string {
  const parts = [h.sid, h.rid ?? "", h.sub ?? ""];
  if (!h.sid || parts.some((p) => !SAFE.test(p))) throw new Error("session hint: unexpected characters");
  return ["v1", ...parts].join(".");
}

export function decodeHint(v: string | null | undefined): SessionHint | null {
  if (!v) return null;
  const p = v.split(".");
  if (p.length !== 4 || p[0] !== "v1" || !p[1] || !p.every((x) => SAFE.test(x))) return null;
  return { sid: p[1], rid: p[2] || null, sub: p[3] || null };
}

/** Value of one cookie from a `document.cookie` / `Cookie:` header string. */
export function readCookie(cookies: string | null | undefined, name: string): string | null {
  if (!cookies) return null;
  for (const part of cookies.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const raw = part.slice(i + 1).trim();
      try { return decodeURIComponent(raw); } catch { return raw; }
    }
  }
  return null;
}

/** JWT payload, read WITHOUT verification: only for routing hints (restaurant, user, expiry), never for a security decision. */
export function jwtClaims(token: string | null | undefined): { rid?: string; sub?: string; exp?: number } | null {
  if (!token) return null;
  try {
    const b = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b.padEnd(b.length + ((4 - (b.length % 4)) % 4), "=")));
  } catch { return null; }
}

/** Short, non-secret fingerprint of an access token (its signature tail), used to say "this one was rejected". */
export const tokenTail = (t: string) => t.slice(-16);
