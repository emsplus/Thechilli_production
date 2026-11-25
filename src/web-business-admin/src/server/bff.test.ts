import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as login } from "@/app/bff/auth/login/route";
import { POST as refresh } from "@/app/bff/auth/refresh/route";
import { POST as logout } from "@/app/bff/auth/logout/route";
import { POST as register } from "@/app/bff/auth/register/route";
import { POST as stepUp } from "@/app/bff/auth/step-up/route";
import { cookieSecurity, csrfOk, deviceHeadersFrom, requestHostname, trustedProxy, upstreamBase } from "./bff";
import { decodeHint, encodeHint } from "@/lib/session-cookie";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "HS256" })}.${b64(claims)}.sig${Math.random().toString(36).slice(2)}`;
const at = (ttl = 1800, rid = "r1", sub = "u1") => jwt({ rid, sub, exp: Math.floor(Date.now() / 1000) + ttl });

function req(path: string, body: unknown, opts: { csrf?: boolean; cookies?: Record<string, string>; origin?: string; url?: string; headers?: Record<string, string> } = {}) {
  const h = new Headers({ "content-type": "application/json", host: "localhost:3120", ...(opts.headers ?? {}) });
  if (opts.csrf !== false) h.set("x-pos-csrf", "1");
  if (opts.origin) h.set("origin", opts.origin);
  if (opts.cookies) h.set("cookie", Object.entries(opts.cookies).map(([k, v]) => `${k}=${v}`).join("; "));
  return new NextRequest(`${opts.url ?? "http://localhost:3120"}${path}`, { method: "POST", headers: h, body: JSON.stringify(body) });
}

const upstreamCalls: { url: string; body: unknown; headers: Headers }[] = [];
function mockUpstream(...answers: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
  upstreamCalls.length = 0;
  const queue = [...answers];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    upstreamCalls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init.headers) });
    const a = queue.shift() ?? { status: 500, body: {} };
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json", ...(a.headers ?? {}) } });
  }));
}

const setCookies = (res: Response) => res.headers.getSetCookie();
const cookie = (res: Response, name: string) => setCookies(res).find((c) => c.startsWith(`${name}=`));

beforeEach(() => { vi.stubEnv("POS_API_URL", "http://api.test/api/v1"); vi.stubEnv("SESSION_COOKIE_SECURE", ""); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("BFF login", () => {
  it("keeps the refresh token in an httpOnly SameSite=Strict cookie and returns only the access token", async () => {
    const access = at();
    mockUpstream({ status: 200, body: { access_token: access, refresh_token: "RT-1", token_type: "bearer" } });
    const res = await login(req("/bff/auth/login", { email: "a@x.in", password: "supersecret123" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBe(access);
    expect(JSON.stringify(body)).not.toContain("RT-1");
    const rt = cookie(res, "pos_rt")!;
    expect(rt).toMatch(/HttpOnly/i);
    expect(rt).toMatch(/SameSite=strict/i);
    expect(rt).toMatch(/Path=\/bff\/auth/);
    expect(rt).not.toMatch(/Secure/i); // plain http on localhost only
    const hint = cookie(res, "pos_session")!;
    expect(hint).not.toMatch(/HttpOnly/i);
    expect(decodeHint(decodeURIComponent(hint.split(";")[0].split("=")[1]))).toMatchObject({ rid: "r1", sub: "u1" });
    expect(upstreamCalls[0].url).toBe("http://api.test/api/v1/auth/login");
    expect(upstreamCalls[0].body).toEqual({ email: "a@x.in", password: "supersecret123" });
  });

  it("forwards restaurant_id and passes a multiple_restaurants 409 through untouched, without cookies", async () => {
    const list = { error: { code: "multiple_restaurants", message: "Choose", restaurants: [{ id: "r1", name: "A" }, { id: "r2", name: "B" }] } };
    mockUpstream({ status: 409, body: list });
    const res = await login(req("/bff/auth/login", { email: "a@x.in", password: "pw-123456789", restaurant_id: "r2" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(list);
    expect(setCookies(res)).toEqual([]);
    expect(upstreamCalls[0].body).toMatchObject({ restaurant_id: "r2" });
  });

  it("refuses requests without the CSRF header or from another origin", async () => {
    mockUpstream();
    expect((await login(req("/bff/auth/login", { email: "a@x.in", password: "x" }, { csrf: false }))).status).toBe(403);
    expect((await login(req("/bff/auth/login", { email: "a@x.in", password: "x" }, { origin: "https://evil.example" }))).status).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("sets Secure cookies over https and refuses plain http on a public hostname", async () => {
    mockUpstream({ status: 200, body: { access_token: at(), refresh_token: "RT" } });
    const res = await login(req("/bff/auth/login", { email: "a@x.in", password: "x" }, { url: "http://pos.example.in", headers: { host: "pos.example.in", "x-forwarded-proto": "https" } }));
    expect(cookie(res, "pos_rt")).toMatch(/Secure/i);
    const plain = await login(req("/bff/auth/login", { email: "a@x.in", password: "x" }, { url: "http://pos.example.in", headers: { host: "pos.example.in" } }));
    expect(plain.status).toBe(500);
    expect((await plain.json()).error.code).toBe("insecure_transport");
  });
});

describe("BFF login behind a proxy (TRUSTED_PROXY)", () => {
  // What the final smoke test hit: `next start` / standalone binds HOSTNAME=0.0.0.0, so the request URL says 0.0.0.0 whatever
  // the browser typed; sign-in answered 500 insecure_transport on plain http even for localhost.
  const viaContainer = (headers: Record<string, string>) =>
    req("/bff/auth/login", { email: "a@x.in", password: "x" }, { url: "http://0.0.0.0:3000", headers });

  it("is refused by default (strict) and signs in once TRUSTED_PROXY is set", async () => {
    mockUpstream({ status: 200, body: { access_token: at(), refresh_token: "RT" } });
    const strict = await login(viaContainer({ host: "localhost:3010" }));
    expect(strict.status).toBe(500);
    expect((await strict.json()).error.code).toBe("insecure_transport");
    vi.stubEnv("TRUSTED_PROXY", "true");
    const ok = await login(viaContainer({ host: "localhost:3010" }));
    expect(ok.status).toBe(200);
    expect(cookie(ok, "pos_rt")).not.toMatch(/Secure/i); // plain http on loopback
  });

  it("with TRUSTED_PROXY, a public host over plain http is still refused, and https from the proxy gets Secure cookies", async () => {
    vi.stubEnv("TRUSTED_PROXY", "true");
    mockUpstream({ status: 200, body: { access_token: at(), refresh_token: "RT" } });
    const plain = await login(viaContainer({ host: "web:3000", "x-forwarded-host": "pos.example.in" }));
    expect(plain.status).toBe(500);
    const tls = await login(viaContainer({ host: "web:3000", "x-forwarded-host": "pos.example.in", "x-forwarded-proto": "https" }));
    expect(tls.status).toBe(200);
    expect(cookie(tls, "pos_rt")).toMatch(/Secure/i);
  });
});

describe("BFF refresh", () => {
  it("reuses a still-valid access token without rotating the refresh token", async () => {
    const access = at(600);
    mockUpstream();
    const res = await refresh(req("/bff/auth/refresh", {}, { cookies: { pos_rt: "RT", pos_at: access } }));
    expect(res.status).toBe(200);
    expect((await res.json()).access_token).toBe(access);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("rotates when the page reports the token as rejected, keeping the session id", async () => {
    const old = at(600);
    const next = at(1800);
    const sid = "abc123";
    mockUpstream({ status: 200, body: { access_token: next, refresh_token: "RT-2" } });
    const res = await refresh(req("/bff/auth/refresh", { rejected: old.slice(-16) }, { cookies: { pos_rt: "RT-1", pos_at: old, pos_session: encodeHint({ sid, rid: "r1", sub: "u1" }) } }));
    expect((await res.json()).access_token).toBe(next);
    expect(upstreamCalls[0].body).toEqual({ refresh_token: "RT-1" });
    expect(cookie(res, "pos_rt")).toContain("RT-2");
    expect(decodeHint(decodeURIComponent(cookie(res, "pos_session")!.split(";")[0].split("=")[1]))?.sid).toBe(sid);
  });

  it("401 from the API ends the session and clears every cookie; 409 keeps them", async () => {
    mockUpstream({ status: 401, body: { detail: "Invalid refresh token" } }, { status: 409, body: { detail: "rotated" } });
    const dead = await refresh(req("/bff/auth/refresh", {}, { cookies: { pos_rt: "RT" } }));
    expect(dead.status).toBe(401);
    for (const n of ["pos_rt", "pos_at", "pos_session"]) expect(cookie(dead, n)).toMatch(/Max-Age=0/);
    const busy = await refresh(req("/bff/auth/refresh", {}, { cookies: { pos_rt: "RT" } }));
    expect(busy.status).toBe(409);
    expect(setCookies(busy)).toEqual([]);
  });

  it("moves a legacy localStorage refresh token into the cookie only when there is no cookie", async () => {
    mockUpstream({ status: 200, body: { access_token: at(), refresh_token: "RT-NEW" } });
    const res = await refresh(req("/bff/auth/refresh", { legacy_refresh_token: "OLD" }));
    expect(res.status).toBe(200);
    expect(upstreamCalls[0].body).toEqual({ refresh_token: "OLD" });
    expect(cookie(res, "pos_rt")).toContain("RT-NEW");
    mockUpstream({ status: 200, body: { access_token: at(), refresh_token: "RT-3" } });
    await refresh(req("/bff/auth/refresh", { legacy_refresh_token: "OLD", rejected: "x" }, { cookies: { pos_rt: "COOKIE" } }));
    expect(upstreamCalls[0].body).toEqual({ refresh_token: "COOKIE" });
  });

  it("no session at all is a 401 without calling the API", async () => {
    mockUpstream();
    expect((await refresh(req("/bff/auth/refresh", {}))).status).toBe(401);
    expect(upstreamCalls).toHaveLength(0);
  });
});

describe("BFF logout and register", () => {
  it("logout revokes on the API and clears the cookies", async () => {
    mockUpstream({ status: 204 });
    const res = await logout(req("/bff/auth/logout", {}, { cookies: { pos_rt: "RT-9" } }));
    expect(res.status).toBe(204);
    expect(upstreamCalls[0]).toMatchObject({ url: "http://api.test/api/v1/auth/logout", body: { refresh_token: "RT-9" } });
    for (const n of ["pos_rt", "pos_at", "pos_session"]) expect(cookie(res, n)).toMatch(/Max-Age=0/);
  });

  it("register signs the owner in on 201 and passes a token-less 202 through", async () => {
    mockUpstream({ status: 201, body: { access_token: at(), refresh_token: "RT" } }, { status: 202, body: { detail: "check your email" } });
    const ok = await register(req("/bff/auth/register", { restaurant_name: "R", owner_email: "o@x.in", owner_name: "O", owner_password: "supersecret123", evil: "x" }));
    expect(ok.status).toBe(201);
    expect(cookie(ok, "pos_rt")).toBeTruthy();
    expect(upstreamCalls[0].body).not.toHaveProperty("evil");
    const pending = await register(req("/bff/auth/register", { restaurant_name: "R", owner_email: "o@x.in", owner_name: "O", owner_password: "supersecret123" }));
    expect(pending.status).toBe(202);
    expect(setCookies(pending)).toEqual([]);
  });
});

describe("configuration", () => {
  it("resolves the API base for the server side", () => {
    expect(upstreamBase("http://web:3000", { POS_API_URL: "http://pos-service:8000/api/v1/" })).toBe("http://pos-service:8000/api/v1");
    expect(upstreamBase("http://web:3000", { NEXT_PUBLIC_API_BASE_URL: "http://localhost:8120/api/v1" })).toBe("http://localhost:8120/api/v1");
    expect(upstreamBase("https://pos.example.in", { NEXT_PUBLIC_API_BASE_URL: "/api/v1" })).toBe("https://pos.example.in/api/v1");
  });
  it("Secure except on plain-http loopback, with an override", () => {
    expect(cookieSecurity({ protocol: "http:", hostname: "localhost" }, {})).toBe(false);
    expect(cookieSecurity({ protocol: "http:", hostname: "127.0.0.1" }, {})).toBe(false);
    expect(cookieSecurity({ protocol: "http:", hostname: "pos.lan" }, {})).toBe("refuse");
    expect(cookieSecurity({ protocol: "http:", forwardedProto: "https", hostname: "pos.example.in" }, {})).toBe(true);
    expect(cookieSecurity({ protocol: "http:", hostname: "pos.lan" }, { SESSION_COOKIE_SECURE: "false" })).toBe(false);
  });
  it("TRUSTED_PROXY: the standalone container sees hostname 0.0.0.0; the proxy's forwarded host / Host header decide (strict by default)", () => {
    const inContainer = { protocol: "http:", hostname: "0.0.0.0" };
    // default: the request URL hostname only, forwarded headers do not turn a public host into loopback
    expect(cookieSecurity({ ...inContainer, host: "localhost:3010" }, {})).toBe("refuse");
    expect(cookieSecurity({ ...inContainer, forwardedHost: "localhost:3010" }, { TRUSTED_PROXY: "false" })).toBe("refuse");
    // trusted proxy, plain http to a loopback host: not Secure (local compose); X-Forwarded-Host wins over Host
    expect(cookieSecurity({ ...inContainer, host: "127.0.0.1:7310" }, { TRUSTED_PROXY: "true" })).toBe(false);
    expect(cookieSecurity({ ...inContainer, forwardedHost: "localhost:3010, pos.internal", host: "web:3000" }, { TRUSTED_PROXY: "1" })).toBe(false);
    expect(cookieSecurity({ ...inContainer, forwardedHost: "pos.example.in", host: "localhost:3000" }, { TRUSTED_PROXY: "true" })).toBe("refuse");
    // behind TLS: the proxy sets X-Forwarded-Proto: https, cookies are Secure whatever the host
    expect(cookieSecurity({ ...inContainer, forwardedProto: "https", forwardedHost: "pos.example.in" }, { TRUSTED_PROXY: "true" })).toBe(true);
    // SESSION_COOKIE_SECURE still overrides everything
    expect(cookieSecurity({ ...inContainer, forwardedHost: "localhost" }, { TRUSTED_PROXY: "true", SESSION_COOKIE_SECURE: "true" })).toBe(true);
    expect(trustedProxy({ TRUSTED_PROXY: "TRUE" })).toBe(true);
    expect(trustedProxy({})).toBe(false);
    expect(requestHostname({ hostname: "0.0.0.0", forwardedHost: "[::1]:3010" }, { TRUSTED_PROXY: "true" })).toBe("[::1]");
    expect(requestHostname({ hostname: "0.0.0.0", forwardedHost: "bad host!" }, { TRUSTED_PROXY: "true" })).toBe("0.0.0.0");
  });
  it("CSRF needs the header and a same-site Origin when one is sent", () => {
    const r = (h: Record<string, string>) => new Request("http://localhost:3120/bff/auth/login", { method: "POST", headers: { host: "localhost:3120", ...h } });
    expect(csrfOk(r({ "x-pos-csrf": "1" }))).toBe(true);
    expect(csrfOk(r({ "x-pos-csrf": "1", origin: "http://localhost:3120" }))).toBe(true);
    expect(csrfOk(r({ "x-pos-csrf": "1", origin: "http://localhost:3999" }))).toBe(false);
    expect(csrfOk(r({}))).toBe(false);
  });
});

describe("BFF device headers and step-up (docs/STAFF_PIN_DEVICES_API.md)", () => {
  it("passes the browser's device headers on sign-in, dropping odd values", async () => {
    mockUpstream({ status: 200, body: { access_token: at(), refresh_token: "rt1" } });
    await login(req("/bff/auth/login", { email: "a@b.c", password: "pw" }, { headers: { "x-device-id": "abc123def", "x-device-name": "Chrome on Mac", "x-device-platform": "web", "x-device-model": "x".repeat(101) } }));
    const h = upstreamCalls[0].headers;
    expect(h.get("x-device-id")).toBe("abc123def");
    expect(h.get("x-device-name")).toBe("Chrome on Mac");
    expect(h.get("x-device-platform")).toBe("web");
    expect(h.get("x-device-model")).toBeNull();
    expect(deviceHeadersFrom(new Headers({ "x-device-name": "bad\u0001name" }))).toEqual({});
  });
  it("step-up forwards the page's bearer and the PIN, and returns the grant", async () => {
    mockUpstream({ status: 200, body: { step_up_token: "su.tok", expires_in: 300, method: "pin" } });
    const res = await stepUp(req("/bff/auth/step-up", { pin: "4826" }, { headers: { authorization: "Bearer aaaa.bbbb.cccc" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ step_up_token: "su.tok" });
    expect(upstreamCalls[0].url).toBe("http://api.test/api/v1/auth/step-up");
    expect(upstreamCalls[0].headers.get("authorization")).toBe("Bearer aaaa.bbbb.cccc");
    expect(upstreamCalls[0].body).toEqual({ pin: "4826" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("step-up exposes X-Pin-Attempts-Left on a wrong PIN and Retry-After when locked", async () => {
    mockUpstream({ status: 401, body: { detail: "Wrong PIN" }, headers: { "X-Pin-Attempts-Left": "3" } }, { status: 429, body: { detail: "locked" }, headers: { "Retry-After": "900" } });
    const wrong = await stepUp(req("/bff/auth/step-up", { pin: "4826" }, { headers: { authorization: "Bearer aaaa.bbbb.cccc" } }));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("x-pin-attempts-left")).toBe("3");
    const locked = await stepUp(req("/bff/auth/step-up", { pin: "4826" }, { headers: { authorization: "Bearer aaaa.bbbb.cccc" } }));
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("900");
  });
  it("step-up refuses a malformed body, a missing session and cross-site calls without calling the API", async () => {
    mockUpstream();
    for (const body of [{}, { pin: "12" }, { pin: "4826", password: "x" }, { pin: 4826 }]) {
      expect((await stepUp(req("/bff/auth/step-up", body, { headers: { authorization: "Bearer aaaa.bbbb.cccc" } }))).status).toBe(422);
    }
    expect((await stepUp(req("/bff/auth/step-up", { pin: "4826" }))).status).toBe(401);
    expect((await stepUp(req("/bff/auth/step-up", { pin: "4826" }, { csrf: false, headers: { authorization: "Bearer aaaa.bbbb.cccc" } }))).status).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
  });
  it("step-up falls back to the access-token cookie", async () => {
    mockUpstream({ status: 200, body: { step_up_token: "su", expires_in: 300, method: "password" } });
    const tok = at();
    await stepUp(req("/bff/auth/step-up", { password: "pw" }, { cookies: { pos_at: tok } }));
    expect(upstreamCalls[0].headers.get("authorization")).toBe(`Bearer ${tok}`);
  });
});
