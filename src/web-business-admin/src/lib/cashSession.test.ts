import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

// The caller's open drawer comes from GET /cash-sessions?status=open (200, possibly empty), never the /current 404.
const ME = "11111111-1111-4111-8111-111111111111";
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = `${b64({ alg: "none" })}.${b64({ sub: ME, rid: "r1" })}.sig`;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const row = (cashier_id: string, id = cashier_id) => ({ id, cashier_id, status: "open", opened_at: "2026-10-31T04:00:00Z", opening_float: "500.00" });

let calls: string[] = [];
function serve(handler: (url: string) => Response) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url.replace(/^.*\/api\/v1/, "")); return handler(url); }));
}

beforeEach(() => {
  const store = new Map<string, string>([["pos.token", token]]);
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
});
afterEach(() => vi.unstubAllGlobals());

describe("current cash drawer", () => {
  it("no drawer open: null from an empty list, and /current (404) is never asked", async () => {
    serve(() => json(200, []));
    expect(await api.cashSessionCurrent()).toBeNull();
    expect(calls).toEqual(["/cash-sessions?status=open&limit=200"]);
  });
  it("picks the caller's own drawer, never another cashier's (owners see everyone's)", async () => {
    serve(() => json(200, [row("someone-else"), row(ME, "mine")]));
    expect(await api.cashSessionCurrent()).toMatchObject({ id: "mine" });
  });
  it("other cashiers' drawers only: null", async () => {
    serve(() => json(200, [row("someone-else")]));
    expect(await api.cashSessionCurrent()).toBeNull();
  });
  it("server without the list: falls back to /current; its 'no open session' 404 is null, a bare route 404 is unsupported", async () => {
    serve((u) => (u.includes("?") ? json(405, { detail: "Method Not Allowed" }) : json(404, { detail: "No open cash session" })));
    expect(await api.cashSessionCurrent()).toBeNull();
    expect(calls).toEqual(["/cash-sessions?status=open&limit=200", "/cash-sessions/current"]);
    serve(() => json(404, { detail: "Not Found" }));
    expect(await api.cashSessionCurrent()).toBe("unsupported");
  });
  it("a real failure is an error (shown, not hidden as 'no drawer')", async () => {
    serve(() => json(500, { detail: "boom" }));
    await expect(api.cashSessionCurrent()).rejects.toMatchObject({ status: 500 });
  });
});
