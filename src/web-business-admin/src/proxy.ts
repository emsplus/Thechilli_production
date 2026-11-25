import { NextResponse, type NextRequest } from "next/server";
import { apiOrigin, contentSecurityPolicy, hsts, newNonce, originOf } from "@/lib/security-headers";

/**
 * Per-request Content-Security-Policy with a fresh nonce (no 'unsafe-inline' scripts), plus HSTS when served over https.
 * Next.js reads the nonce from the request's CSP header and stamps it on its own scripts; the root layout reads `x-nonce`
 * for the pre-paint theme script. The other security headers are static (next.config.ts).
 * `next dev` keeps no CSP (React's dev tooling needs eval and inline styles), as before.
 */
export function proxy(req: NextRequest) {
  if (process.env.NODE_ENV === "development") return NextResponse.next();
  const nonce = newNonce();
  const https = (req.headers.get("x-forwarded-proto")?.split(",")[0].trim() || req.nextUrl.protocol.replace(/:$/, "")) === "https";
  const csp = contentSecurityPolicy({ nonce, api: apiOrigin(process.env.NEXT_PUBLIC_API_BASE_URL), https, styleHashes: process.env.CSP_STYLE_HASHES,
    connect: [originOf(process.env.NEXT_PUBLIC_ONBOARDING_API_URL)] }); // /register posts the application to platform-core directly
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  const sts = hsts(https);
  if (sts) res.headers.set("Strict-Transport-Security", sts);
  return res;
}

export const config = {
  matcher: [
    {
      // Pages only: not the BFF (JSON), Next's static chunks and images, the service worker or public files with an extension.
      // voice-models/: the offline wake detector's worker and model (static files; the worker runs Vosk's WebAssembly engine,
      // whose loader needs eval, so it must not carry the PAGE's script policy; the page itself keeps it unchanged).
      source: "/((?!bff/|_next/static|_next/image|sw\\.js|voice-models/|.*\\.(?:png|svg|ico|webp|jpg|jpeg|gif|woff2?|webmanifest|txt|json)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
