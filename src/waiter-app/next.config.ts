import type { NextConfig } from "next";
import path from "node:path";

/**
 * Response headers of the waiter web build (the PWA served by `next start`; the NATIVE=1 static export cannot send headers).
 * Security review 2026-11-02: the web build sent none, while it keeps the session tokens in localStorage.
 *
 * The CSP is deliberately NOT nonce-based (that needs a per-request proxy, as in web-business-admin): Next.js and the root
 * layout use inline scripts, so script-src keeps 'unsafe-inline'. What it still does: blocks every external script origin,
 * pins connect-src to the API origin (a script that runs cannot send the tokens elsewhere), and forbids framing, plugins,
 * <base> and foreign form posts. Moving to a nonce CSP is the follow-up that makes script-src strict.
 */
// NOTE: kept in this file on purpose. infra web.Dockerfile ships only next.config.* (not ./src) in the pruned runtime image, so
// next.config.ts must not import from ./src or `next start` fails at boot.
export interface HeaderOptions { apiBase?: string; production: boolean }

export function originOf(url: string | undefined): string {
  try { return url && /^https?:\/\//.test(url) ? new URL(url).origin : ""; } catch { return ""; }
}

export function contentSecurityPolicy({ apiBase, production }: HeaderOptions): string {
  const api = originOf(apiBase);
  const withApi = (s: string) => (api ? `${s} ${api}` : s);
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${production ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    withApi("img-src 'self' data: blob:"),
    "font-src 'self' data:",
    withApi("connect-src 'self'"),
    "media-src 'self' blob:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-src 'self' blob:", // receipt PDFs print through a blob: iframe
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(production ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function securityHeaders(o: HeaderOptions): { key: string; value: string }[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(o) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ];
}

// NATIVE=1 builds a static export for the Capacitor Android shell (no server, no headers()).
const native = process.env.NATIVE === "1";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // @chilli/tokens is linked from ../design-system: let Turbopack read the parent folder.
  turbopack: { root: path.resolve(process.cwd(), "..") },
  ...(native
    ? { output: "export", trailingSlash: true, images: { unoptimized: true } }
    : {
        async headers() {
          return [
            { source: "/:path*", headers: securityHeaders({ apiBase: process.env.NEXT_PUBLIC_API_BASE_URL, production: process.env.NODE_ENV === "production" }) },
            { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }, { key: "Service-Worker-Allowed", value: "/" }] },
          ];
        },
      }),
};
export default config;
