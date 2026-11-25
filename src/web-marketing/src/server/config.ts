export type ApiMode = "mock" | "live";
/** Server-side switch for the cookie BFF: mock when NEXT_PUBLIC_API_MOCK=1 (same flag as the browser-only mock). */
/** Mock data, demo logins and no real backend must never serve a production deployment (security review 2026-11-02; web-super-admin has
 *  the same guard): NODE_ENV=production with NEXT_PUBLIC_API_MOCK=1 throws, unless MKT_ALLOW_MOCK_IN_PRODUCTION=true (e2e runs a production build). */
export const apiMode = (env: Record<string, string | undefined> = process.env): ApiMode => {
  if (env.NEXT_PUBLIC_API_MOCK !== "1") return "live";
  if (env.NODE_ENV === "production" && env.MKT_ALLOW_MOCK_IN_PRODUCTION !== "true") {
    throw new Error("NEXT_PUBLIC_API_MOCK=1 is not allowed in a production build (set MKT_ALLOW_MOCK_IN_PRODUCTION=true only for tests)");
  }
  return "mock";
};
export const upstreamUrl = () => (process.env.MARKETING_API_URL ?? "http://localhost:8000/api/v1").replace(/\/$/, "");
export const cookieSecure = () => (process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE !== "false" : process.env.NODE_ENV === "production");

/** The BFF forwards only these marketing-service areas. Public sign-up endpoints, docs and health never go through it. */
const PREFIXES = ["leads", "activities", "demos", "onboarding", "invitations", "referral-codes", "campaigns", "commission-rules", "commission-entries", "audit-log", "users"];
const AUTH_OK = new Set(["auth/me", "auth/change-password"]);
export function isForwardable(path: string[]): boolean {
  if (path.some((s) => { const d = decodeURIComponent(s); return d === "." || d === ".." || d.includes("/") || d.includes("\\"); })) return false;
  const joined = path.join("/");
  return AUTH_OK.has(joined) || PREFIXES.includes(path[0] ?? "");
}

/** Opt-in (MKT_FORWARD_CLIENT_IP=true): pass the visitor's address on to marketing-service, so its sign-in / invitation throttles key on the
 *  visitor and not on this server (without it ONE shared bucket: 20 failed sign-ins by anyone block every partner). Only safe behind a
 *  router that OVERWRITES X-Forwarded-For with a single client address (the Caddy router does) and with marketing-service trusting this
 *  server (FORWARDED_ALLOW_IPS). Anything that is not a plain address list is dropped. */
export function forwardedFor(xff: string | null, env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.MKT_FORWARD_CLIENT_IP !== "true" || !xff || !/^[0-9a-fA-F.:, ]{2,500}$/.test(xff)) return undefined;
  return xff.trim();
}
