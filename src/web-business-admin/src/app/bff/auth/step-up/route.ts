import type { NextRequest } from "next/server";
import { AT_COOKIE } from "@/lib/session-cookie";
import { fail, guard, json, passThrough, readJson, upstream } from "@/server/bff";

export const dynamic = "force-dynamic";

/**
 * Step-up (pos-service docs/STAFF_PIN_DEVICES_API.md 5): the signed-in user re-enters their PIN (or password) before a
 * sensitive action. Goes through this server rather than straight to the API so the page can read the answers' headers on
 * any deployment (X-Pin-Attempts-Left on a wrong PIN, Retry-After when locked: the API does not expose them to a
 * cross-origin page), and so a wrong PIN's 401 is never mistaken for an expired session.
 * Body { pin: "4826" } or { password: "..." }. Auth: the page's Bearer access token (else the access-token cookie).
 * 200 { step_up_token, expires_in, expires_at, method }: the page keeps it in memory only and sends it as X-Step-Up-Token.
 */
export async function POST(req: NextRequest) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const b = await readJson(req);
  const pin = b?.pin, password = b?.password;
  const okPin = typeof pin === "string" && /^\d{4,6}$/.test(pin);
  const okPw = typeof password === "string" && password.length > 0 && password.length <= 1024;
  if (!b || okPin === okPw || (pin !== undefined && !okPin) || (password !== undefined && !okPw)) {
    return fail(422, "validation_error", "Enter your 4 to 6 digit PIN, or your password");
  }
  const header = req.headers.get("authorization");
  const bearer = header && /^Bearer [A-Za-z0-9._~+/=-]{10,4096}$/.test(header) ? header : null;
  const cookie = req.cookies.get(AT_COOKIE)?.value;
  const auth = bearer ?? (cookie ? `Bearer ${cookie}` : null);
  if (!auth) return fail(401, "no_session", "Not signed in");
  const r = await upstream(req, "/auth/step-up", okPin ? { pin } : { password }, 15000, { Authorization: auth });
  if (r.status === 200 && (!r.body || typeof (r.body as { step_up_token?: unknown }).step_up_token !== "string")) {
    return fail(502, "bad_upstream", "Unexpected answer from the Chilli Agent server");
  }
  return r.status === 200 ? json(200, r.body) : passThrough(r);
}
