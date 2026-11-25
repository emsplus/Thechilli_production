import type { NextRequest } from "next/server";
import { AT_COOKIE, RT_COOKIE, jwtClaims, tokenTail } from "@/lib/session-cookie";
import { clearSession, fail, grant, guard, isPair, json, passThrough, readJson, setSession, upstream } from "@/server/bff";

export const dynamic = "force-dynamic";

/** An access token is handed out again (no rotation) while it has at least this long to live. */
const REUSE_MIN_SECONDS = 60;

/**
 * Gives the page an access token for the session in the cookies.
 *  - The current one is reused while it has > 60 s left, unless the page says it was just rejected (`rejected` = tail of
 *    that token): a reload or a second tab does not rotate the refresh token.
 *  - Otherwise the refresh token is rotated with the API. 401 = session over (cookies cleared); 409 = another request of
 *    this browser rotated it a moment ago (the page retries and the browser then sends the newer cookie).
 *  - `legacy_refresh_token`: one-time move of a session from an older version of the app that kept it in localStorage
 *    (used only when there is no cookie yet; it is rotated at once, so the localStorage copy dies).
 */
export async function POST(req: NextRequest) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const b = (await readJson(req)) ?? {};
  const rejected = typeof b.rejected === "string" ? b.rejected : null;

  const at = req.cookies.get(AT_COOKIE)?.value;
  const exp = jwtClaims(at)?.exp;
  if (at && exp && exp - Date.now() / 1000 > REUSE_MIN_SECONDS && tokenTail(at) !== rejected) {
    return json(200, grant({ access_token: at, refresh_token: "" }));
  }

  const cookieRt = req.cookies.get(RT_COOKIE)?.value;
  const legacy = !cookieRt && typeof b.legacy_refresh_token === "string" && b.legacy_refresh_token.length < 4096 ? b.legacy_refresh_token : null;
  const rt = cookieRt ?? legacy;
  if (!rt) {
    const res = fail(401, "no_session", "Not signed in");
    clearSession(req, res);
    return res;
  }
  const r = await upstream(req, "/auth/refresh", { refresh_token: rt });
  if (r.status === 200 && isPair(r.body)) {
    const res = json(200, grant(r.body));
    setSession(req, res, r.body, !legacy);
    return res;
  }
  if (r.status === 401) {
    const res = passThrough(r);
    clearSession(req, res);
    return res;
  }
  if (r.status === 200) return fail(502, "bad_upstream", "Unexpected answer from the Chilli Agent server");
  return passThrough(r); // 409 (concurrent rotation), 429, 5xx: the session is kept
}
