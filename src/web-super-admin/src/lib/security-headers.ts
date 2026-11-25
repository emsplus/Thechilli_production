/**
 * Response security headers (pure functions: used by src/proxy.ts per request and by next.config.ts at build time).
 * Same policy family as web-business-admin: per-request nonce CSP without 'unsafe-inline' scripts, HSTS on https only.
 * Next.js stamps the nonce on its own scripts and inline styles (it reads it from the request's CSP header); the root
 * layout awaits connection() so every page is rendered per request (a prerendered page could not carry the nonce).
 */

type Env = Record<string, string | undefined>;

/** Origin of an absolute URL, "" for relative or invalid ones. */
export function originOf(url: string | undefined): string {
  try { return url && /^https?:\/\//.test(url) ? new URL(url).origin : ""; } catch { return ""; }
}

export interface CspOptions {
  nonce: string;
  /** Page served over https: adds upgrade-insecure-requests (on plain-http localhost it would break cross-origin calls). */
  https: boolean;
  /** Extra origins the browser calls directly (fetch). */
  connect?: string[];
}

export function contentSecurityPolicy({ nonce, https, connect = [] }: CspOptions): string {
  const extra = connect.filter(Boolean);
  return [
    "default-src 'self'",
    // Only scripts carrying this response's nonce, and what they load ('strict-dynamic': Next.js chunk loading).
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // <style> elements: same origin or this nonce. Inline style="" attributes stay allowed (they cannot run script).
    `style-src 'self' 'nonce-${nonce}'`,
    `style-src-elem 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    ["connect-src 'self'", ...extra].join(" "),
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/**
 * Strict-Transport-Security, only on responses that reached the browser over https (browsers ignore it on http anyway).
 * HSTS=off disables it; HSTS_MAX_AGE (seconds, default one year) and HSTS_INCLUDE_SUBDOMAINS=true|false tune it.
 */
export function hsts(https: boolean, env: Env = process.env, includeSubDomainsByDefault = false): string | null {
  if (!https || (env.HSTS ?? "auto").toLowerCase() === "off") return null;
  const age = Number.parseInt(env.HSTS_MAX_AGE ?? "", 10);
  const maxAge = Number.isFinite(age) && age >= 0 ? age : 31536000;
  const sub = env.HSTS_INCLUDE_SUBDOMAINS ? env.HSTS_INCLUDE_SUBDOMAINS === "true" : includeSubDomainsByDefault;
  return `max-age=${maxAge}${sub ? "; includeSubDomains" : ""}`;
}

/** Scheme the browser used: X-Forwarded-Proto from the reverse proxy, else the request URL. */
export const isHttps = (protocol: string, forwardedProto: string | null) =>
  (forwardedProto?.split(",")[0]?.trim() || protocol.replace(/:$/, "")).toLowerCase() === "https";

/** Fresh random nonce (base64 of 128 random bits). */
export function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));
}

/** Static headers for every response, set in next.config.ts. No camera, microphone or other device access in this app. */
export const BASE_HEADERS: { key: string; value: string }[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), midi=(), display-capture=()" },
];
