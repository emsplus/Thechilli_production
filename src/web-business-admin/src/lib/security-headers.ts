/**
 * Response security headers (pure functions: used by src/proxy.ts per request and by next.config.ts at build time).
 *
 * Pages get a per-request nonce CSP from the proxy: no 'unsafe-inline' scripts. Next.js puts the nonce on its own
 * scripts and inline styles (it reads it from the request's CSP header); the root layout puts it on the pre-paint
 * theme script.
 */

type Env = Record<string, string | undefined>;

/** Origin of the API when it lives on another origin (local dev / e2e); empty when same-origin (`/api/v1`). */
export function apiOrigin(base: string | undefined): string {
  const b = base ?? "http://localhost:8110/api/v1"; // same default as src/lib/api.ts
  try { return /^https?:\/\//.test(b) ? new URL(b).origin : ""; } catch { return ""; }
}

export interface CspOptions {
  nonce: string;
  /** Cross-origin API origin ("" = same origin). */
  api: string;
  /** Page served over https: adds upgrade-insecure-requests (on plain-http localhost it would break the API calls). */
  https: boolean;
  /** Hash sources of <style> elements libraries inject at run time (src/lib/csp-style-hashes.ts), e.g. "'sha256-...'". */
  styleHashes?: string;
  /** Further origins the page calls directly (connect-src only), e.g. platform-core onboarding (NEXT_PUBLIC_ONBOARDING_API_URL). */
  connect?: string[];
}

/** Origin of an optional absolute URL ("" when unset, relative or invalid). */
export function originOf(url: string | undefined): string {
  try { return url && /^https?:\/\//.test(url) ? new URL(url).origin : ""; } catch { return ""; }
}

export function contentSecurityPolicy({ nonce, api, https, styleHashes = "", connect = [] }: CspOptions): string {
  const extra = (s: string) => (api ? `${s} ${api}` : s);
  const more = [...new Set(connect.filter((o) => o && o !== api))];
  return [
    "default-src 'self'",
    // Only scripts carrying this response's nonce, and what they load ('strict-dynamic': Next.js chunk loading).
    // 'self' is ignored by CSP3 browsers next to 'strict-dynamic' and only kept for older ones.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // <style> elements and stylesheets: same origin, this nonce, or the exact hashes of library-injected styles (toasts).
    // Inline style="" attributes stay allowed (React and Radix position popovers, progress bars and the like with them);
    // they cannot run script.
    `style-src 'self' 'nonce-${nonce}'${styleHashes ? ` ${styleHashes}` : ""}`,
    `style-src-elem 'self' 'nonce-${nonce}'${styleHashes ? ` ${styleHashes}` : ""}`,
    "style-src-attr 'unsafe-inline'",
    // Menu photos may be served by the API origin (cross-origin in local/e2e setups); camera previews and picked
    // photos are blob:, the 3D hero draws procedural canvas textures.
    extra("img-src 'self' data: blob:"),
    "font-src 'self' data:",
    extra("connect-src 'self'") + (more.length ? ` ${more.join(" ")}` : ""),
    "media-src 'self' blob:",
    "worker-src 'self'",
    "manifest-src 'self'",
    // Receipt PDFs are printed through a hidden blob: iframe.
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/**
 * Strict-Transport-Security, only on responses that reached the browser over https (browsers ignore it on http anyway).
 * HSTS=off disables it (e.g. while a domain is still being moved to https); HSTS_MAX_AGE (seconds, default one year)
 * and HSTS_INCLUDE_SUBDOMAINS=true tune it. Never preload by default: that is a one-way decision for the domain owner.
 */
export function hsts(https: boolean, env: Env = process.env): string | null {
  if (!https || (env.HSTS ?? "auto").toLowerCase() === "off") return null;
  const age = Number.parseInt(env.HSTS_MAX_AGE ?? "", 10);
  const maxAge = Number.isFinite(age) && age >= 0 ? age : 31536000;
  return `max-age=${maxAge}${env.HSTS_INCLUDE_SUBDOMAINS === "true" ? "; includeSubDomains" : ""}`;
}

/** Static headers for every response (pages, assets, BFF), set in next.config.ts. */
export const STATIC_HEADERS: { key: string; value: string }[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Camera: scanning supplier bills; microphone: voice ordering at the counter. Nothing else, and never for frames.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), midi=(), display-capture=()" },
];

/** Fresh random nonce (base64 of 128 random bits). */
export function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b));
}
