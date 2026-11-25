import type { NextRequest } from "next/server";
import { fail, grant, guard, isPair, json, passThrough, readJson, setSession, upstream } from "@/server/bff";

export const dynamic = "force-dynamic";

/**
 * Sign-in. 200 -> session cookies + { access_token, expires_in }. Every other answer of the API is passed through as is,
 * notably 409 { error: { code: "multiple_restaurants", restaurants: [{ id, name }] } } (the email belongs to several
 * restaurants and the password matched: the page asks which one and calls again with restaurant_id), 401 and 429.
 * Staff sign-in sends { restaurant_code, identifier, password, device_label? } instead of email; the API may add
 * password_change_required (one-time password), which is passed on.
 */
const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;

export async function POST(req: NextRequest) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const b = await readJson(req);
  const password = b?.password, rid = b?.restaurant_id;
  let body: Record<string, string>;
  if (b && b.restaurant_code !== undefined) {
    // Staff sign-in: restaurant code + phone / username / email (docs/STAFF_WIRING_CHECK.md in pos-service).
    const dev = b.device_label;
    if (!str(b.restaurant_code, 64) || !str(b.identifier, 320) || !str(password, 1024) || (dev !== undefined && !str(dev, 100))) {
      return fail(422, "validation_error", "Enter the restaurant code, your phone number or username, and your password");
    }
    body = { restaurant_code: b.restaurant_code as string, identifier: b.identifier as string, password: password as string, ...(dev ? { device_label: dev as string } : {}) };
  } else {
    const email = b?.email;
    if (!str(email, 320) || !str(password, 1024) || (rid !== undefined && rid !== null && (typeof rid !== "string" || rid.length > 64))) {
      return fail(422, "validation_error", "Enter your email and password");
    }
    body = { email: email as string, password: password as string, ...(rid ? { restaurant_id: rid as string } : {}) };
  }
  const r = await upstream(req, "/auth/login", body);
  if (r.status !== 200) return passThrough(r);
  if (!isPair(r.body)) return fail(502, "bad_upstream", "Unexpected answer from the Chilli Agent server");
  // A one-time password signs in but must be replaced first: the page asks for a new one.
  const mustChange = (r.body as { password_change_required?: unknown }).password_change_required === true;
  const res = json(200, { ...grant(r.body), ...(mustChange ? { password_change_required: true } : {}) });
  setSession(req, res, r.body, false);
  return res;
}
