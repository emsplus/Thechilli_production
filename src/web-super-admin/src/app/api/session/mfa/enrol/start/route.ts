import type { NextRequest } from "next/server";
import { csrfOk, errorResponse, toResponse } from "@/server/http";
import { getMfaToken } from "@/server/session";
import { upstream } from "@/server/upstream";

export const dynamic = "force-dynamic";

/** Enrolment for a role that must have MFA but has no session yet: authorised by the step-up token only. */
export async function POST(req: NextRequest) {
  if (!csrfOk(req)) return errorResponse(403, "csrf", "Missing request header");
  const step = await getMfaToken();
  if (!step || step.purpose !== "enrol") return errorResponse(401, "unauthorized", "Your sign-in expired. Start again.");
  return toResponse(await upstream("POST", "/auth/mfa/enrol/start", new URLSearchParams(), undefined, step.token));
}
