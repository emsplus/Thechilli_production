import type { NextRequest } from "next/server";
import { fail, grant, guard, isPair, json, passThrough, readJson, setSession, upstream } from "@/server/bff";

export const dynamic = "force-dynamic";

const FIELDS = ["restaurant_name", "country", "trn", "owner_email", "owner_name", "owner_password"] as const;

/**
 * New restaurant. When the API answers with a token pair (201) the owner is signed in like a login. Any other answer is
 * passed through: a server that verifies email first answers 202 without tokens, and the page shows the same neutral
 * "check your email" text whether or not the address already had an account.
 */
export async function POST(req: NextRequest) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const b = await readJson(req);
  if (!b) return fail(422, "validation_error", "Invalid request");
  const body: Record<string, string | string[]> = {};
  for (const k of FIELDS) {
    const v = b[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || v.length > 1024) return fail(422, "validation_error", `Invalid ${k}`);
    body[k] = v;
  }
  // What the business runs (docs/BUSINESS_TYPES.md): a short list of type ids; the API validates the values.
  const types = b.business_types;
  if (types !== undefined && types !== null) {
    if (!Array.isArray(types) || types.length > 3 || !types.every((t) => typeof t === "string" && t.length <= 32)) return fail(422, "validation_error", "Invalid business_types");
    body.business_types = types as string[];
  }
  const r = await upstream(req, "/auth/register-restaurant", body);
  if (!isPair(r.body) || r.status >= 300) {
    // Never forward a token pair the page should not hold; strip it from any non-sign-in answer.
    if (isPair(r.body)) return json(r.status, {});
    return passThrough(r);
  }
  const res = json(r.status, grant(r.body));
  setSession(req, res, r.body, false);
  return res;
}
