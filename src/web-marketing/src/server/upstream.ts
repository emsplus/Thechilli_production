import { headers as requestHeaders } from "next/headers";
import { apiMode, forwardedFor, upstreamUrl } from "./config";

export interface Up { status: number; headers: Record<string, string>; body: ArrayBuffer }
const KEEP = ["content-type", "content-disposition", "retry-after"];

let mock: Promise<typeof fetch> | undefined;
const mockFetch = () => (mock ??= import("@/mocks/handler").then((m) => m.createMockFetch(undefined, 0)));

/** One door to the backend: marketing-service over HTTP, or the in-memory mock (state lives in the server process, so it survives reloads). */
export async function upstream(method: string, path: string, search: string, init: { bearer?: string | null; contentType?: string | null; body?: ArrayBuffer }): Promise<Up> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  if (init.contentType) headers["Content-Type"] = init.contentType;
  try { const xff = forwardedFor((await requestHeaders()).get("x-forwarded-for")); if (xff) headers["X-Forwarded-For"] = xff; } catch { /* outside a request (tests) */ }
  const hasBody = init.body !== undefined && init.body.byteLength > 0 && method !== "GET" && method !== "DELETE";
  try {
    const res = apiMode() === "mock"
      ? await (await mockFetch())(`http://mock.local/api/v1${path}${search}`, { method, headers, body: hasBody ? init.body : undefined })
      : await fetch(`${upstreamUrl()}${path}${search}`, { method, headers, body: hasBody ? init.body : undefined, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    const out: Record<string, string> = {};
    for (const k of KEEP) { const v = res.headers.get(k); if (v) out[k] = v; }
    return { status: res.status, headers: out, body: await res.arrayBuffer() };
  } catch {
    return { status: 502, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify({ error: { code: "bad_gateway", message: "The marketing service is not reachable" } })).buffer as ArrayBuffer };
  }
}

export const json = (status: number, body: unknown): Up => ({ status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer });
