import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, hsts, isHttps, newNonce, originOf } from "@/lib/security-headers";

// Cookie mode (default) goes through this server's /api BFF; only explicit bearer mode calls marketing-service directly.
const CONNECT: string[] = [process.env.NEXT_PUBLIC_API_MOCK !== "1" && process.env.NEXT_PUBLIC_AUTH_MODE === "bearer" ? originOf(process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api/v1") : ""];

/**
 * Per-request Content-Security-Policy with a fresh nonce (no 'unsafe-inline' scripts), plus HSTS when served over https.
 * Next.js reads the nonce from the request's CSP header and stamps it on its own scripts. Static headers: next.config.ts.
 * `next dev` keeps no CSP (React's dev tooling needs eval).
 */
export function proxy(req: NextRequest) {
  if (process.env.NODE_ENV === "development") return NextResponse.next();
  const nonce = newNonce();
  const https = isHttps(req.nextUrl.protocol, req.headers.get("x-forwarded-proto"));
  const csp = contentSecurityPolicy({ nonce, https, connect: CONNECT });
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  const sts = hsts(https, process.env, false);
  if (sts) res.headers.set("Strict-Transport-Security", sts);
  return res;
}

export const config = {
  matcher: [
    {
      // Pages only: not the API routes (JSON), Next's static chunks and images, or public files with an extension.
      source: "/((?!api/|_next/static|_next/image|.*\\.(?:png|svg|ico|webp|jpg|jpeg|gif|woff2?|webmanifest|txt|xml|json)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
