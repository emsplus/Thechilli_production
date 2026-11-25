import type { NextRequest } from "next/server";
import { csrfOk, errorResponse, toResponse } from "@/server/http";
import { authedCall, clearMfaToken, getMfaToken, setSession } from "@/server/session";
import { upstream } from "@/server/upstream";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!csrfOk(req)) return errorResponse(403, "csrf", "Missing request header");
  const step = await getMfaToken();
  if (!step || step.purpose !== "enrol") return errorResponse(401, "unauthorized", "Your sign-in expired. Start again.");
  const b = (await req.json().catch(() => null)) as { code?: unknown } | null;
  if (typeof b?.code !== "string" || !b.code.trim()) return errorResponse(422, "validation_error", "Enter the 6-digit code from your authenticator");
  const r = await upstream("POST", "/auth/mfa/enrol/confirm", new URLSearchParams(), { code: b.code.trim() }, step.token);
  if (r.status !== 200) return toResponse(r);
  const done = r.body as { recovery_codes: string[]; access_token: string; refresh_token: string; expires_in: number; must_change_password: boolean };
  await setSession(done);
  await clearMfaToken();
  const me = await authedCall("GET", "/auth/me", new URLSearchParams(), undefined);
  if (me.status !== 200) return toResponse(me);
  // recovery codes are shown once, here; tokens never leave the server
  return toResponse({ status: 200, body: { ok: true, recovery_codes: done.recovery_codes, user: me.body, must_change_password: done.must_change_password } });
}
