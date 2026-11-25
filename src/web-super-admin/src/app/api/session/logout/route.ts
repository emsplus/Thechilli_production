import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { csrfOk, errorResponse, toResponse } from "@/server/http";
import { clearSession, RT } from "@/server/session";
import { upstreamLogout } from "@/server/upstream";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!csrfOk(req)) return errorResponse(403, "csrf", "Missing request header");
  const rt = (await cookies()).get(RT)?.value;
  if (rt) await upstreamLogout(rt).catch(() => undefined);
  await clearSession();
  return toResponse({ status: 200, body: { ok: true } });
}
