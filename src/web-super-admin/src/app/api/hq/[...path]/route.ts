import type { NextRequest } from "next/server";
import { filterQuery, forwardHeaders, isAllowed } from "@/server/allowlist";
import { csrfOk, errorResponse, toResponse } from "@/server/http";
import { authedCall } from "@/server/session";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (!csrfOk(req)) return errorResponse(403, "csrf", "Missing request header");
  const { path } = await ctx.params;
  if (path.some((s) => { const d = decodeURIComponent(s); return d === "." || d === ".." || d.includes("/"); })) return errorResponse(404, "not_found", "Not found");
  const upPath = "/" + path.map((s) => encodeURIComponent(decodeURIComponent(s))).join("/");
  if (!isAllowed(req.method, upPath)) return errorResponse(404, "not_found", "Not found");
  let body: unknown;
  if (req.method !== "GET" && req.method !== "DELETE") {
    const text = await req.text();
    if (text.length > 100_000) return errorResponse(413, "too_large", "Request too large");
    try { body = text ? JSON.parse(text) : undefined; } catch { return errorResponse(400, "bad_request", "Invalid JSON"); }
  }
  return toResponse(await authedCall(req.method, upPath, filterQuery(req.nextUrl.searchParams), body, forwardHeaders(req.headers)));
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
