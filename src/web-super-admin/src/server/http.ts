import { NextResponse } from "next/server";
import type { UpResponse } from "./mock/handler";

/** Response headers of platform-core that reach the browser: how long to wait (429) and "ask for a code" (403 step_up_required). */
const PASS_BACK = new Set(["retry-after", "x-step-up-required"]);

export function toResponse(r: UpResponse): NextResponse {
  if (r.contentType && typeof r.body === "string") {
    const csv = new NextResponse(r.body, { status: r.status, headers: { "Content-Type": r.contentType, "X-Content-Type-Options": "nosniff" } });
    csv.headers.set("Cache-Control", "no-store");
    return csv;
  }
  const res = r.body === undefined ? new NextResponse(null, { status: r.status }) : NextResponse.json(r.body, { status: r.status });
  for (const [k, v] of Object.entries(r.headers ?? {})) if (PASS_BACK.has(k.toLowerCase())) res.headers.set(k, v);
  res.headers.set("Cache-Control", "no-store");
  return res;
}
export const errorResponse = (status: number, code: string, message: string) => toResponse({ status, body: { error: { code, message } } });

/** Cross-site requests cannot set a custom header without a CORS preflight (which we never allow): cheap, solid CSRF defence. */
export const csrfOk = (req: Request) => req.headers.get("x-hq-csrf") === "1";
