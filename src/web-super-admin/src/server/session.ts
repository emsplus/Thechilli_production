import { cookies } from "next/headers";
import { cookieSecure } from "./config";
import { upstream, upstreamRefresh } from "./upstream";
import type { UpResponse } from "./mock/handler";

/**
 * Session = two httpOnly cookies set by this server. The browser never sees a token (no localStorage, no JS-readable cookie).
 *  hq_at: short-lived access token, hq_rt: rotating refresh token, only sent to /api/*.
 */
export const AT = "hq_at";
export const RT = "hq_rt";

interface TokenPair { access_token: string; refresh_token: string; expires_in: number; must_change_password?: boolean }

export async function setSession(t: TokenPair) {
  const jar = await cookies();
  const base = { httpOnly: true, secure: cookieSecure(), sameSite: "strict" as const };
  jar.set(AT, t.access_token, { ...base, path: "/", maxAge: Math.max(60, t.expires_in) });
  jar.set(RT, t.refresh_token, { ...base, path: "/api", maxAge: 14 * 24 * 3600 });
}
/** Step-up token between password and second factor: httpOnly, 5 minutes, only sent to the session endpoints. */
export const MFA = "hq_mfa";
export async function setMfaToken(token: string, purpose: "verify" | "enrol") {
  const jar = await cookies();
  jar.set(MFA, `${purpose}:${token}`, { httpOnly: true, secure: cookieSecure(), sameSite: "strict", path: "/api/session", maxAge: 300 });
}
export async function getMfaToken(): Promise<{ purpose: "verify" | "enrol"; token: string } | null> {
  const v = (await cookies()).get(MFA)?.value;
  const i = v ? v.indexOf(":") : -1;
  const purpose = v?.slice(0, i);
  return v && (purpose === "verify" || purpose === "enrol") ? { purpose, token: v.slice(i + 1) } : null;
}
export async function clearMfaToken() { (await cookies()).delete({ name: MFA, path: "/api/session" }); }

export async function clearSession() {
  const jar = await cookies();
  jar.delete({ name: AT, path: "/" });
  jar.delete({ name: RT, path: "/api" });
  jar.delete({ name: MFA, path: "/api/session" });
}

// Refresh tokens rotate and reuse is treated as theft, so concurrent requests must share ONE refresh call.
const inflight = new Map<string, Promise<UpResponse>>();
function refreshOnce(rt: string) {
  let p = inflight.get(rt);
  if (!p) { p = upstreamRefresh(rt).finally(() => setTimeout(() => inflight.delete(rt), 5000)); inflight.set(rt, p); }
  return p;
}

/** Calls platform-core with the session's access token, refreshing once if it expired. Updates cookies as needed. */
export async function authedCall(method: string, path: string, query: URLSearchParams, body: unknown, headers?: Record<string, string>): Promise<UpResponse> {
  const jar = await cookies();
  let at = jar.get(AT)?.value ?? null;
  const rt = jar.get(RT)?.value ?? null;
  const refresh = async (): Promise<boolean> => {
    if (!rt) return false;
    const r = await refreshOnce(rt);
    if (r.status !== 200) { await clearSession(); return false; }
    const pair = r.body as TokenPair;
    await setSession(pair);
    at = pair.access_token;
    return true;
  };
  if (!at && !(await refresh())) return { status: 401, body: { error: { code: "unauthorized", message: "Sign in to continue" } } };
  // A retry after refresh carries the same Idempotency-Key, so it cannot apply a credit change twice.
  let res = await upstream(method, path, query, body, at, headers);
  if (res.status === 401 && (await refresh())) res = await upstream(method, path, query, body, at, headers);
  return res;
}
