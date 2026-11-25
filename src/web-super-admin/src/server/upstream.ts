import { headers as requestHeaders } from "next/headers";
import { apiMode, coreUrl, forwardClientIp } from "./config";
import { mockHandle, mockLogin, mockRefresh, type UpResponse } from "./mock/handler";

/**
 * Who is really calling. Without this every session, audit row and sign-in throttle in platform-core sees this server
 * ("node", 127.0.0.1): the session list cannot tell devices apart, the audit log has no client address, and one person's
 * failed sign-ins slow down everyone's (the per-IP brake keys on the BFF).
 * User-Agent is display-only and always passed on. The address is passed on only with HQ_FORWARD_CLIENT_IP=true: Next keeps
 * a browser-sent X-Forwarded-For as is (it only fills one in when absent), so without a proxy in front that appends the real
 * peer, forwarding it would let anyone choose the address platform-core throttles on. Behind such a proxy, set the flag and
 * list the proxy and this server in platform-core's TRUSTED_PROXIES (it walks the chain right to left, skipping trusted hops).
 * Outside a request (tests) nothing is added.
 */
export async function clientHeaders(): Promise<Record<string, string>> {
  try {
    const h = await requestHeaders();
    const out: Record<string, string> = {};
    const ua = h.get("user-agent"); if (ua) out["User-Agent"] = ua.slice(0, 300);
    const xff = h.get("x-forwarded-for");
    if (forwardClientIp() && xff && /^[0-9a-fA-F.:, ]{2,500}$/.test(xff)) out["X-Forwarded-For"] = xff;
    return out;
  } catch { return {}; }
}

/** One door to the backend, live (platform-core over HTTP) or mock (in-memory). Server-side only. */
async function live(method: string, path: string, query: URLSearchParams, body: unknown, bearer: string | null, extra?: Record<string, string>): Promise<UpResponse> {
  const qs = query.toString();
  const headers: Record<string, string> = { ...(await clientHeaders()), ...extra, Accept: "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(`${coreUrl()}${path}${qs ? `?${qs}` : ""}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    const ct = res.headers.get("Content-Type") ?? "";
    if (ct.startsWith("text/csv")) return { status: res.status, body: text, contentType: ct };
    let parsed: unknown = undefined;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = { error: { code: "bad_gateway", message: "Unexpected response from platform-core" } }; }
    const back: Record<string, string> = {};
    const ra = res.headers.get("Retry-After"); if (ra) back["Retry-After"] = ra;
    const su = res.headers.get("X-Step-Up-Required"); if (su) back["X-Step-Up-Required"] = su;
    return { status: res.status, body: parsed, headers: Object.keys(back).length ? back : undefined };
  } catch {
    return { status: 502, body: { error: { code: "bad_gateway", message: "Platform core is not reachable" } } };
  }
}

/** `headers`: only what allowlist.forwardHeaders() lets through (Idempotency-Key, X-Step-Up-Token). */
export async function upstream(method: string, path: string, query: URLSearchParams, body: unknown, bearer: string | null, headers?: Record<string, string>): Promise<UpResponse> {
  return apiMode() === "mock" ? mockHandle(method, path, query, body, bearer, headers) : live(method, path, query, body, bearer, headers);
}
export async function upstreamLogin(email: string, password: string): Promise<UpResponse> {
  return apiMode() === "mock" ? mockLogin(email, password) : live("POST", "/auth/login", new URLSearchParams(), { email, password }, null);
}
export async function upstreamRefresh(refreshToken: string): Promise<UpResponse> {
  return apiMode() === "mock" ? mockRefresh(refreshToken) : live("POST", "/auth/refresh", new URLSearchParams(), { refresh_token: refreshToken }, null);
}
/** Second sign-in step; the step-up token travels in the body, never in a browser-visible place. */
export async function upstreamMfaVerify(body: Record<string, unknown>): Promise<UpResponse> {
  return upstream("POST", "/auth/mfa/verify", new URLSearchParams(), body, null);
}
export async function upstreamLogout(refreshToken: string): Promise<void> {
  if (apiMode() === "live") await live("POST", "/auth/logout", new URLSearchParams(), { refresh_token: refreshToken }, null);
}
