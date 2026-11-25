import type { NextRequest } from "next/server";
import { insecureTransportProblem } from "@/server/config";
import { csrfOk, errorResponse, toResponse } from "@/server/http";
import { authedCall, clearMfaToken, setMfaToken, setSession } from "@/server/session";
import { upstreamLogin } from "@/server/upstream";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!csrfOk(req)) return errorResponse(403, "csrf", "Missing request header");
  const b = (await req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  if (!b || typeof b.email !== "string" || typeof b.password !== "string" || !b.email || !b.password) return errorResponse(422, "validation_error", "Enter your email and password");
  const insecure = insecureTransportProblem({ protocol: req.nextUrl.protocol, forwardedProto: req.headers.get("x-forwarded-proto") });
  if (insecure) return errorResponse(500, "insecure_transport", insecure);
  const r = await upstreamLogin(b.email, b.password);
  if (r.status !== 200) return toResponse(r);
  const step = r.body as { mfa_required?: boolean; mfa_enrolment_required?: boolean; mfa_token?: string };
  if (step.mfa_token && (step.mfa_required || step.mfa_enrolment_required)) {
    await setMfaToken(step.mfa_token, step.mfa_required ? "verify" : "enrol");
    return toResponse({ status: 200, body: { status: step.mfa_required ? "mfa_verify" : "mfa_enrol" } });
  }
  await clearMfaToken();
  const pair = r.body as { access_token: string; refresh_token: string; expires_in: number; must_change_password: boolean };
  await setSession(pair);
  const me = await authedCall("GET", "/auth/me", new URLSearchParams(), undefined);
  if (me.status !== 200) return toResponse(me);
  return toResponse({ status: 200, body: { status: "signed_in", user: me.body, must_change_password: pair.must_change_password } });
}
