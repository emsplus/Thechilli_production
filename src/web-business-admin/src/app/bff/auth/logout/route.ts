import type { NextRequest } from "next/server";
import { RT_COOKIE } from "@/lib/session-cookie";
import { clearSession, guard, json, upstream } from "@/server/bff";

export const dynamic = "force-dynamic";

/** Revokes the session on the API (best effort: offline or already revoked is fine) and always clears the cookies. */
export async function POST(req: NextRequest) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const rt = req.cookies.get(RT_COOKIE)?.value;
  if (rt) await upstream(req, "/auth/logout", { refresh_token: rt }, 5000);
  const res = json(204, undefined);
  clearSession(req, res);
  return res;
}
