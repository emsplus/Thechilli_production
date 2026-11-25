import { toResponse } from "@/server/http";
import { authedCall } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET() {
  return toResponse(await authedCall("GET", "/auth/me", new URLSearchParams(), undefined));
}
