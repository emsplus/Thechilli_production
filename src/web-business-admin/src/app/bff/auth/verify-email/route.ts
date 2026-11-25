import type { NextRequest } from "next/server";
import { fail, grant, guard, isPair, json, passThrough, readJson, setSession, upstream } from "@/server/bff";

export const dynamic = "force-dynamic";

/**
 * Finishes a pending sign-up (202 from /register) with the emailed 6-digit code: the API creates the restaurant and answers
 * with a token pair, which becomes the session cookies like a login. 400 (bad / expired code), 422 and 429 (with
 * Retry-After) pass through unchanged.
 */
export async function POST(req: NextRequest) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const b = await readJson(req);
  const email = b?.email, otp = b?.otp;
  if (typeof email !== "string" || typeof otp !== "string" || !email || !otp || email.length > 320 || otp.length > 32) {
    return fail(422, "validation_error", "Enter the 6-digit code from the email");
  }
  const r = await upstream(req, "/auth/verify-email", { email, otp });
  if (r.status < 200 || r.status >= 300) return passThrough(r);
  if (!isPair(r.body)) return fail(502, "bad_upstream", "Unexpected answer from the Chilli Agent server");
  const res = json(200, grant(r.body));
  setSession(req, res, r.body, false);
  return res;
}
