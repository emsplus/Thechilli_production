import { cookies } from "next/headers";
import { cookieSecure } from "./config";
import { json, upstream, type Up } from "./upstream";

/**
 * Session = two httpOnly cookies set by this server; the browser never sees a token (no localStorage, nothing readable by JS).
 *  mk_at: access token (short lived), mk_rt: rotating refresh token, only sent to /api/mkt.
 */
export const AT = "mk_at";
export const RT = "mk_rt";
interface Pair { access_token: string; refresh_token: string }

export async function setSession(t: Pair, accessMinutes = 30) {
  const jar = await cookies();
  const base = { httpOnly: true, secure: cookieSecure(), sameSite: "strict" as const };
  jar.set(AT, t.access_token, { ...base, path: "/api/mkt", maxAge: accessMinutes * 60 });
  jar.set(RT, t.refresh_token, { ...base, path: "/api/mkt", maxAge: 30 * 24 * 3600 });
}
export async function clearSession() {
  const jar = await cookies();
  jar.delete({ name: AT, path: "/api/mkt" });
  jar.delete({ name: RT, path: "/api/mkt" });
}

// Refresh tokens rotate (reuse is treated as theft), so concurrent requests must share ONE refresh call.
const inflight = new Map<string, Promise<Up>>();
function refreshOnce(rt: string): Promise<Up> {
  let p = inflight.get(rt);
  if (!p) {
    p = upstream("POST", "/auth/refresh", "", { contentType: "application/json", body: new TextEncoder().encode(JSON.stringify({ refresh_token: rt })).buffer as ArrayBuffer })
      .finally(() => setTimeout(() => inflight.delete(rt), 5000));
    inflight.set(rt, p);
  }
  return p;
}
const parse = (u: Up): Pair | null => { try { return JSON.parse(new TextDecoder().decode(u.body)) as Pair; } catch { return null; } };

export async function refreshSession(): Promise<boolean> {
  const rt = (await cookies()).get(RT)?.value;
  if (!rt) return false;
  const r = await refreshOnce(rt);
  const pair = r.status === 200 ? parse(r) : null;
  if (!pair) { await clearSession(); return false; }
  await setSession(pair);
  return true;
}

/** Calls the backend with the session's access token; on 401 refreshes once and retries. */
export async function authedCall(method: string, path: string, search: string, init: { contentType?: string | null; body?: ArrayBuffer }): Promise<Up> {
  const jar = await cookies();
  let at = jar.get(AT)?.value ?? null;
  const rt = jar.get(RT)?.value ?? null;
  const refresh = async () => {
    if (!rt) return false;
    const r = await refreshOnce(rt);
    const pair = r.status === 200 ? parse(r) : null;
    if (!pair) { await clearSession(); return false; }
    await setSession(pair);
    at = pair.access_token;
    return true;
  };
  if (!at && !(await refresh())) return json(401, { error: { code: "unauthorized", message: "Sign in to continue" } });
  let res = await upstream(method, path, search, { ...init, bearer: at });
  if (res.status === 401 && (await refresh())) res = await upstream(method, path, search, { ...init, bearer: at });
  return res;
}

export { parse as parsePair };
