export type ApiMode = "mock" | "live";
type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigError"; }
}

const isProd = (env: Env) => env.NODE_ENV === "production";

/**
 * `HQ_API_MODE=live` (or just `PLATFORM_CORE_URL`) proxies to platform-core; `HQ_API_MODE=mock` runs the in-memory demo backend.
 * In production the demo backend is refused: unset configuration fails closed (throws) instead of silently serving fake data
 * behind a login whose password is public. `HQ_ALLOW_MOCK_IN_PRODUCTION=true` is the explicit escape hatch for demo deployments.
 */
export function apiMode(env: Env = process.env): ApiMode {
  const m = env.HQ_API_MODE;
  if (m !== undefined && m !== "" && m !== "live" && m !== "mock") throw new ConfigError(`HQ_API_MODE must be "live" or "mock", got "${m}".`);
  const mode: ApiMode = m === "live" ? "live" : m === "mock" ? "mock" : env.PLATFORM_CORE_URL ? "live" : "mock";
  if (mode === "mock" && isProd(env) && env.HQ_ALLOW_MOCK_IN_PRODUCTION !== "true") {
    throw new ConfigError(
      m === "mock"
        ? "HQ_API_MODE=mock is not allowed when NODE_ENV=production (set HQ_ALLOW_MOCK_IN_PRODUCTION=true only for a throwaway demo)."
        : "Neither HQ_API_MODE nor PLATFORM_CORE_URL is set: refusing to start production on the in-memory demo backend. Set HQ_API_MODE=live and PLATFORM_CORE_URL.",
    );
  }
  return mode;
}

/** Demo accounts/password may be published only when mock mode was chosen explicitly, never by default. */
export function demoCredentialsVisible(env: Env = process.env): boolean {
  return env.HQ_API_MODE === "mock" && apiMode(env) === "mock";
}

/** Called once at server start (src/instrumentation.ts): a misconfigured production deploy never begins serving. */
export function assertConfig(env: Env = process.env): void {
  apiMode(env);
  if (apiMode(env) === "live" && isProd(env) && !env.PLATFORM_CORE_URL) throw new ConfigError("HQ_API_MODE=live requires PLATFORM_CORE_URL in production.");
}

export const coreUrl = () => (process.env.PLATFORM_CORE_URL ?? "http://localhost:8400/api/v1").replace(/\/$/, "");

/** Secure cookies: default on in production, off otherwise. Override with HQ_COOKIE_SECURE=true|false (see README). */
export function cookieSecure(env: Env = process.env): boolean {
  return env.HQ_COOKIE_SECURE ? env.HQ_COOKIE_SECURE !== "false" : isProd(env);
}

/**
 * A Secure cookie set over plain http is silently dropped by the browser, which looks like "login redirects back to /login".
 * Returns an operator-facing message when that would happen, else null.
 */
export function insecureTransportProblem(req: { protocol: string; forwardedProto?: string | null }, env: Env = process.env): string | null {
  if (!cookieSecure(env)) return null;
  const proto = (req.forwardedProto?.split(",")[0].trim() || req.protocol).replace(/:$/, "");
  if (proto === "https") return null;
  return "Sign-in is blocked: this deployment sets Secure session cookies, but it is being served over plain http, so the browser would discard the session. Serve it over https (and forward X-Forwarded-Proto: https from your proxy), or, only on a trusted private network, set HQ_COOKIE_SECURE=false.";
}

/** Pass the browser's X-Forwarded-For on to platform-core (see clientHeaders in upstream.ts). Only behind an appending proxy. */
export const forwardClientIp = (env: Env = process.env) => env.HQ_FORWARD_CLIENT_IP === "true";
