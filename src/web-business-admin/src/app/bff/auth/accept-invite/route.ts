import type { NextRequest } from "next/server";
import { fail, grant, guard, isPair, json, passThrough, readJson, setSession, upstream } from "@/server/bff";

export const dynamic = "force-dynamic";

/**
 * Single-use invite link (staff invite or the owner's provisioning invite): sets the first password and signs in like a
 * login (session cookies + { access_token, expires_in }). 400 (invalid / used / expired link), 422 and 429 pass through.
 */
export async function POST(req: NextRequest) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const b = await readJson(req);
  const token = b?.token, password = b?.password;
  if (typeof token !== "string" || typeof password !== "string" || !token || !password || token.length > 512 || password.length > 1024) {
    return fail(422, "validation_error", "Choose a password");
  }
  const r = await upstream(req, "/auth/accept-invite", { token, password });
  if (r.status !== 200 && r.status !== 201) return passThrough(r);
  if (!isPair(r.body)) return fail(502, "bad_upstream", "Unexpected answer from the Chilli Agent server");
  const res = json(200, grant(r.body));
  setSession(req, res, r.body, false);
  return res;
}
