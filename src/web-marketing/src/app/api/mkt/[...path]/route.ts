import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { isForwardable } from "@/server/config";
import { authedCall, clearSession, parsePair, RT, setSession } from "@/server/session";
import { json, upstream, type Up } from "@/server/upstream";

export const dynamic = "force-dynamic";
const MAX_BODY = 6 * 1024 * 1024; // documents are up to 5 MB; the backend enforces its own limits

function toResponse(u: Up): Response {
  const h = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  for (const [k, v] of Object.entries(u.headers)) h.set(k, v);
  return new Response(u.status === 204 || u.status === 304 ? null : u.body, { status: u.status, headers: h });
}

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  // Cross-site requests cannot set a custom header without a CORS preflight (which we never allow): cheap, solid CSRF defence.
  if (req.headers.get("x-csrf") !== "1") return toResponse(json(403, { error: { code: "csrf", message: "Missing request header" } }));
  const { path } = await ctx.params;
  const joined = path.join("/");
  const search = req.nextUrl.search;
  const raw = req.method === "GET" || req.method === "HEAD" || req.method === "DELETE" ? undefined : await req.arrayBuffer();
  if (raw && raw.byteLength > MAX_BODY) return toResponse(json(413, { error: { code: "too_large", message: "Request too large" } }));

  if (joined === "auth/login" && req.method === "POST") {
    const r = await upstream("POST", "/auth/login", "", { contentType: req.headers.get("content-type"), body: raw });
    const pair = r.status === 200 ? parsePair(r) : null;
    if (!pair) return toResponse(r);
    await setSession(pair);
    return toResponse(json(200, { ok: true })); // tokens stay on the server
  }
  if (joined === "auth/refresh" && req.method === "POST") {
    const { refreshSession } = await import("@/server/session");
    return toResponse(await refreshSession() ? json(200, { ok: true }) : json(401, { error: { code: "unauthorized", message: "Session expired" } }));
  }
  if (joined === "auth/logout" && req.method === "POST") {
    const rt = (await cookies()).get(RT)?.value;
    if (rt) await upstream("POST", "/auth/logout", "", { contentType: "application/json", body: new TextEncoder().encode(JSON.stringify({ refresh_token: rt })).buffer as ArrayBuffer }).catch(() => undefined);
    await clearSession();
    return toResponse({ status: 204, headers: {}, body: new ArrayBuffer(0) });
  }
  if (!isForwardable(path)) return toResponse(json(404, { error: { code: "not_found", message: "Not found" } }));
  return toResponse(await authedCall(req.method, "/" + path.map((s) => encodeURIComponent(decodeURIComponent(s))).join("/"), search, { contentType: req.headers.get("content-type"), body: raw }));
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
