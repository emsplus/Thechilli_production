import { NextResponse, type NextRequest } from "next/server";
import { AT_COOKIE, BFF_PATH, CSRF_HEADER, HINT_COOKIE, RT_COOKIE, SESSION_MAX_AGE, decodeHint, encodeHint, jwtClaims } from "@/lib/session-cookie";

/**
 * Token exchange for the browser (BFF). The browser never holds the refresh token: these handlers call pos-service, keep
 * the refresh token in an httpOnly cookie and hand back only the short-lived access token, which the page keeps in memory.
 * Everything else (orders, menu, sync ...) still goes straight from the browser to the API with that bearer token.
 */

type Env = Record<string, string | undefined>;

/** pos-service base URL as seen from THIS server. POS_API_URL wins (needed in containers, where the browser's
 *  localhost:8000 is not the API); otherwise an absolute NEXT_PUBLIC_API_BASE_URL; otherwise the same-origin path
 *  (`/api/v1` behind the reverse proxy) resolved against the request's origin. */
// NEXT_PUBLIC_* is inlined at build time (the literal `process.env.NEXT_PUBLIC_API_BASE_URL` must appear here); POS_API_URL is read at run time.
const BUILT_API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
export function upstreamBase(reqOrigin: string, env: Env = { POS_API_URL: process.env.POS_API_URL, NEXT_PUBLIC_API_BASE_URL: BUILT_API_BASE }): string {
  const pick = env.POS_API_URL || env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8110/api/v1"; // same default as src/lib/api.ts
  return (/^https?:\/\//.test(pick) ? pick : new URL(pick, reqOrigin).href).replace(/\/$/, "");
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

/** Scheme the browser used: X-Forwarded-Proto from the reverse proxy, else the request URL. */
export function requestProto(req: { protocol: string; forwardedProto?: string | null }): "https" | "http" {
  const p = (req.forwardedProto?.split(",")[0].trim() || req.protocol).replace(/:$/, "").toLowerCase();
  return p === "https" ? "https" : "http";
}

/**
 * Secure cookie flag. Default: always Secure, except plain http on a loopback host (local dev / e2e / the local compose
 * stack), where a Secure cookie would be dropped. SESSION_COOKIE_SECURE=true|false overrides.
 * Returns "refuse" for plain http on a real hostname: the browser would discard a Secure cookie (sign-in loops back to
 * /login), and sending the refresh token over http is exactly what this is meant to prevent.
 */
export function cookieSecurity(req: { protocol: string; forwardedProto?: string | null; hostname: string; forwardedHost?: string | null; host?: string | null }, env: Env = process.env): boolean | "refuse" {
  if (env.SESSION_COOKIE_SECURE === "true") return true;
  if (env.SESSION_COOKIE_SECURE === "false") return false;
  if (requestProto(req) === "https") return true;
  return LOOPBACK.test(requestHostname(req, env)) ? false : "refuse";
}

/** TRUSTED_PROXY=true|1: a reverse proxy in front of this server sets X-Forwarded-Proto / X-Forwarded-Host and overwrites any
 *  value the client sent. Only then are the forwarded host (and the Host header) believed. Off by default (strict). */
export const trustedProxy = (env: Env = process.env) => /^(1|true|yes|on)$/i.test((env.TRUSTED_PROXY ?? "").trim());

/** Host the browser used, without the port. By default the request URL's hostname. Inside the standalone container that is the
 *  bind address (HOSTNAME=0.0.0.0), never `localhost`, so with TRUSTED_PROXY the proxy's X-Forwarded-Host (else the Host header)
 *  is used instead. */
export function requestHostname(req: { hostname: string; forwardedHost?: string | null; host?: string | null }, env: Env = process.env): string {
  if (!trustedProxy(env)) return req.hostname;
  const raw = (req.forwardedHost?.split(",")[0].trim() || req.host?.trim() || "").toLowerCase();
  const m = raw.match(/^(\[[0-9a-f:.]+\]|[^:/\s]+)(?::\d+)?$/);  // host or [v6], optional :port
  return m ? m[1] : req.hostname;
}

const reqFacts = (req: NextRequest) => ({
  protocol: req.nextUrl.protocol, forwardedProto: req.headers.get("x-forwarded-proto"), hostname: req.nextUrl.hostname,
  forwardedHost: req.headers.get("x-forwarded-host"), host: req.headers.get("host"),
});

/**
 * CSRF: the custom header (cross-site requests cannot send it without a preflight we never answer) plus, when the browser
 * sends an Origin, it must be this site. SameSite=Strict cookies are the third layer.
 */
export function csrfOk(req: Request): boolean {
  if (req.headers.get(CSRF_HEADER) !== "1") return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim() || req.headers.get("host");
    return new URL(origin).host === host;
  } catch { return false; }
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  const res = body === undefined ? new NextResponse(null, { status }) : NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
};
export const fail = (status: number, code: string, message: string) => json(status, { error: { code, message } });

/** Guards shared by every BFF handler; null = go ahead. */
export function guard(req: NextRequest): NextResponse | null {
  if (!csrfOk(req)) return fail(403, "csrf", "Missing or cross-site request header");
  if (cookieSecurity(reqFacts(req)) === "refuse") {
    return fail(500, "insecure_transport", "Sign-in is blocked: this page is served over plain http on a public hostname, so the session cookie cannot be protected. Serve it over https (forward X-Forwarded-Proto: https from the proxy), behind a trusted proxy set TRUSTED_PROXY=true so its X-Forwarded-Host is used, or, only on a trusted private network, set SESSION_COOKIE_SECURE=false.");
  }
  return null;
}

export interface UpResult { status: number; body: unknown; retryAfter?: string | null; attemptsLeft?: string | null }

/**
 * Device headers of the browser (pos-service docs/STAFF_PIN_DEVICES_API.md 1) passed on to the API, so a sign-in through
 * this server is recorded as the browser's device, not as this server. Only short printable values; anything else is dropped.
 */
const DEVICE_HEADERS = ["x-device-id", "x-device-name", "x-device-model", "x-device-platform"] as const;
export function deviceHeadersFrom(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of DEVICE_HEADERS) {
    const v = h.get(k)?.trim();
    if (v && v.length <= 100 && /^[\x20-\x7E]+$/.test(v)) out[k] = v;
  }
  return out;
}

/** One call to pos-service. Network failure / timeout -> 502 (the client treats it as a server problem, not a dead session). */
export async function upstream(req: NextRequest, path: string, body: unknown, timeoutMs = 15000, extra: Record<string, string> = {}): Promise<UpResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json", ...deviceHeadersFrom(req.headers), ...extra };
  // The API labels sessions by device and throttles by client IP: pass the browser's along. pos-service only trusts
  // X-Forwarded-For from addresses listed in FORWARDED_ALLOW_IPS (set it to this server's address in production).
  const ua = req.headers.get("user-agent");
  if (ua) headers["User-Agent"] = ua;
  const lang = req.headers.get("accept-language");
  if (lang) headers["Accept-Language"] = lang;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) headers["X-Forwarded-For"] = xff;
  try {
    const res = await fetch(`${upstreamBase(req.nextUrl.origin)}${path}`, { method: "POST", headers, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let parsed: unknown = undefined;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = { detail: text.slice(0, 500) }; }
    return { status: res.status, body: parsed, retryAfter: res.headers.get("retry-after"), attemptsLeft: res.headers.get("x-pin-attempts-left") };
  } catch {
    return { status: 502, body: { error: { code: "upstream_unreachable", message: "The Chilli Agent server cannot be reached right now." } } };
  }
}

/** Upstream answer passed through unchanged (status, JSON body, Retry-After, X-Pin-Attempts-Left), minus any token it might contain. */
export function passThrough(r: UpResult) {
  return json(r.status, r.body, { ...(r.retryAfter ? { "Retry-After": r.retryAfter } : {}), ...(r.attemptsLeft ? { "X-Pin-Attempts-Left": r.attemptsLeft } : {}) });
}

export interface TokenPair { access_token: string; refresh_token: string; expires_in?: number }
export const isPair = (b: unknown): b is TokenPair =>
  !!b && typeof b === "object" && typeof (b as TokenPair).access_token === "string" && typeof (b as TokenPair).refresh_token === "string";

const newSid = () => crypto.randomUUID().replace(/-/g, "");

/** What the page receives instead of the pair: the access token and when it expires (seconds). */
export function grant(pair: TokenPair) {
  const exp = jwtClaims(pair.access_token)?.exp;
  const expiresIn = exp ? Math.max(0, Math.round(exp - Date.now() / 1000)) : (pair.expires_in ?? 1800);
  return { access_token: pair.access_token, token_type: "bearer", expires_in: expiresIn };
}

/** Stores a new pair in the cookies. `sid` survives refreshes (one session id per sign-in); a new sign-in gets a new one. */
export function setSession(req: NextRequest, res: NextResponse, pair: TokenPair, keepSid: boolean) {
  const secure = cookieSecurity(reqFacts(req)) === true;
  const base = { httpOnly: true, secure, sameSite: "strict" as const, path: BFF_PATH };
  const c = jwtClaims(pair.access_token);
  const atAge = c?.exp ? Math.max(1, Math.round(c.exp - Date.now() / 1000)) : Math.max(60, pair.expires_in ?? 1800);
  res.cookies.set(RT_COOKIE, pair.refresh_token, { ...base, maxAge: SESSION_MAX_AGE });
  res.cookies.set(AT_COOKIE, pair.access_token, { ...base, maxAge: atAge });
  const prev = keepSid ? decodeHint(req.cookies.get(HINT_COOKIE)?.value) : null;
  const hint = encodeHint({ sid: prev?.sid ?? newSid(), rid: c?.rid ?? null, sub: c?.sub ?? null });
  res.cookies.set(HINT_COOKIE, hint, { httpOnly: false, secure, sameSite: "strict", path: "/", maxAge: SESSION_MAX_AGE });
}

export function clearSession(req: NextRequest, res: NextResponse) {
  const secure = cookieSecurity(reqFacts(req)) === true;
  for (const [name, path, httpOnly] of [[RT_COOKIE, BFF_PATH, true], [AT_COOKIE, BFF_PATH, true], [HINT_COOKIE, "/", false]] as const) {
    res.cookies.set(name, "", { httpOnly, secure, sameSite: "strict", path, maxAge: 0 });
  }
}

/** Reads a small JSON body; anything else (wrong type, too large, not JSON) is null. */
export async function readJson(req: NextRequest, max = 4096): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (text.length > max) return null;
    const b = text ? JSON.parse(text) : {};
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch { return null; }
}
