import type { NextRequest } from "next/server";
import { csrfOk, errorResponse, toResponse } from "@/server/http";
import { authedCall, clearMfaToken, getMfaToken, setSession } from "@/server/session";
import { upstreamMfaVerify } from "@/server/upstream";

export const dynamic = "force-dynamic";

/** Second sign-in step: a TOTP code or a recovery code, plus the step-up token held in the httpOnly hq_mfa cookie. */
export async function POST(req: NextRequest) {
  if (!csrfOk(req)) return errorResponse(403, "csrf", "Missing request header");
  const step = await getMfaToken();
  if (!step || step.purpose !== "verify") return errorResponse(401, "unauthorized", "Your sign-in expired. Start again.");
  const b = (await req.json().catch(() => null)) as { code?: unknown; recovery_code?: unknown } | null;
  const code = typeof b?.code === "string" ? b.code.trim() : "", rec = typeof b?.recovery_code === "string" ? b.recovery_code.trim() : "";
  if (!code === !rec) return errorResponse(422, "validation_error", "Enter the 6-digit code or a recovery code");
  const r = await upstreamMfaVerify({ mfa_token: step.token, ...(code ? { code } : { recovery_code: rec }) });
  if (r.status !== 200) return toResponse(r);
  const pair = r.body as { access_token: string; refresh_token: string; expires_in: number; must_change_password: boolean; recovery_codes_remaining?: number };
  await setSession(pair);
  await clearMfaToken();
  const me = await authedCall("GET", "/auth/me", new URLSearchParams(), undefined);
  if (me.status !== 200) return toResponse(me);
  return toResponse({ status: 200, body: { status: "signed_in", user: me.body, must_change_password: pair.must_change_password, recovery_codes_remaining: pair.recovery_codes_remaining } });
}
