import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeHint } from "./session-cookie";

/** The browser side of the session (src/lib/api.ts) with a fake cookie jar, localStorage and network. */

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (ttl: number, rid = "r1") => `${b64({ alg: "HS256" })}.${b64({ rid, sub: "u1", exp: Math.floor(Date.now() / 1000) + ttl })}.s${Math.random().toString(36).slice(2)}`;

let jar: Map<string, string>;
let store: Map<string, string>;
let calls: { url: string; auth: string | null; body: Record<string, unknown> | null }[];
let handler: (url: string, auth: string | null, body: Record<string, unknown> | null) => Response | Promise<Response>;

const signedIn = (sid = "s1", rid = "r1") => jar.set("pos_session", encodeHint({ sid, rid, sub: "u1" }));
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.resetModules();
  jar = new Map(); store = new Map(); calls = [];
  vi.stubGlobal("document", {
    get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join("; "); },
    set cookie(v: string) { const [kv, ...attrs] = v.split(";"); const [k, val] = kv.split("="); if (attrs.some((a) => /max-age=0/i.test(a))) jar.delete(k.trim()); else jar.set(k.trim(), val); },
  });
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  vi.stubGlobal("location", { protocol: "http:", pathname: "/pos", origin: "http://localhost:3120" });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const auth = new Headers(init.headers).get("Authorization");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, auth, body });
    return handler(url, auth, body);
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("browser session (access token in memory, refresh token in an httpOnly cookie)", () => {
  it("never writes a token to localStorage; the first call after a page load fetches one from the BFF", async () => {
    signedIn();
    const t = jwt(1800);
    handler = (url) => (url.endsWith("/bff/auth/refresh") ? ok({ access_token: t, expires_in: 1800 }) : ok({ name: "Dhaba" }));
    const { api, auth } = await import("./api");
    expect(auth.token).toBe("s1");
    expect(auth.restaurantId).toBe("r1");
    await api.restaurant();
    expect(calls.map((c) => c.url.replace(/^https?:\/\/[^/]+/, ""))).toEqual(["/bff/auth/refresh", "/api/v1/restaurant"]);
    expect(calls[1].auth).toBe(`Bearer ${t}`);
    await api.restaurant(); // the second call reuses the in-memory token
    expect(calls).toHaveLength(3);
    expect([...store.values()].join()).not.toContain(t);
  });

  it("an operation queued offline is sent after the token expired: renewed through the cookie first, then uploaded", async () => {
    signedIn();
    const old = jwt(10); // expires within the renew margin by the time the device is back online
    const next = jwt(1800);
    handler = (url) => (url.endsWith("/bff/auth/refresh") ? ok({ access_token: next }) : ok({ results: [] }));
    const { api, auth } = await import("./api");
    auth.set({ access_token: old });
    await api.syncOperations([]);
    expect(calls[0].url).toMatch(/\/bff\/auth\/refresh$/);
    expect(calls[0].body?.rejected).toBeUndefined(); // not rejected: the BFF may hand out a newer token without rotating
    expect(calls[1].auth).toBe(`Bearer ${next}`);
  });

  it("offline: the renewal fails as 'cannot reach server' and the session is kept", async () => {
    signedIn();
    handler = () => { throw new TypeError("Failed to fetch"); };
    const { api, auth, ApiError } = await import("./api");
    await expect(api.restaurant()).rejects.toMatchObject({ status: 0 });
    await expect(api.restaurant()).rejects.toBeInstanceOf(ApiError);
    expect(auth.token).toBe("s1");
  });

  it("a 401 rotates once (telling the BFF which token was rejected) and retries", async () => {
    signedIn();
    const first = jwt(1800);
    const second = jwt(1800);
    handler = (url, a) => {
      if (url.endsWith("/bff/auth/refresh")) return ok({ access_token: second });
      return a === `Bearer ${first}` ? new Response("{}", { status: 401 }) : ok({ name: "x" });
    };
    const { api, auth } = await import("./api");
    auth.set({ access_token: first });
    await api.restaurant();
    expect(calls.map((c) => c.url.replace(/^https?:\/\/[^/]+/, ""))).toEqual(["/api/v1/restaurant", "/bff/auth/refresh", "/api/v1/restaurant"]);
    expect(calls[1].body?.rejected).toBe(first.slice(-16));
    expect(calls[2].auth).toBe(`Bearer ${second}`);
  });

  it("a dead session (BFF 401) clears the marker, asks the BFF to drop its cookies and keeps nothing in memory", async () => {
    signedIn();
    handler = (url) => (url.endsWith("/bff/auth/refresh") ? new Response("{}", { status: 401 }) : url.endsWith("/bff/auth/logout") ? new Response(null, { status: 204 }) : ok({}));
    const { api, auth } = await import("./api");
    await api.restaurant().catch(() => undefined);
    expect(auth.token).toBeNull();
    expect(auth.accessToken).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/bff/auth/logout"))).toBe(true);
  });

  it("when another tab signs in as someone else, this tab stops using its old token", async () => {
    signedIn("s1", "r1");
    const a = jwt(1800, "r1");
    const b = jwt(1800, "r2");
    handler = (url) => (url.endsWith("/bff/auth/refresh") ? ok({ access_token: b }) : ok({}));
    const { api, auth } = await import("./api");
    auth.set({ access_token: a });
    expect(auth.accessToken).toBe(a);
    signedIn("s2", "r2"); // the other tab's sign-in replaced the cookies
    expect(auth.accessToken).toBeNull();
    expect(auth.restaurantId).toBe("r2");
    await api.restaurant();
    expect(calls.at(-1)?.auth).toBe(`Bearer ${b}`);
  });

  it("a session saved by an older version (localStorage) is moved into the cookie once and the old keys are deleted", async () => {
    store.set("pos.token", jwt(1800)); store.set("pos.refresh", "LEGACY-RT");
    const t = jwt(1800);
    handler = (url) => {
      if (url.endsWith("/bff/auth/refresh")) { signedIn("s9"); return ok({ access_token: t }); }
      return ok({});
    };
    const { api, auth } = await import("./api");
    expect(auth.token).toBe("legacy");
    await api.restaurant();
    expect(calls[0].body?.legacy_refresh_token).toBe("LEGACY-RT");
    expect(store.has("pos.refresh")).toBe(false);
    expect(store.has("pos.token")).toBe(false);
    expect(auth.token).toBe("s9");
  });

  it("login sends the chosen restaurant and surfaces the multiple_restaurants list", async () => {
    const list = [{ id: "r1", name: "Dhaba One" }, { id: "r2", name: "Dhaba Two" }];
    handler = (_url, _a, body) => (body?.restaurant_id ? ok({ access_token: jwt(1800, "r2") })
      : new Response(JSON.stringify({ error: { code: "multiple_restaurants", message: "Choose a restaurant", restaurants: list } }), { status: 409 }));
    const { api } = await import("./api");
    const err = await api.login("o@x.in", "pw").catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: "multiple_restaurants", message: "Choose a restaurant" });
    expect(err.details.restaurants).toEqual(list);
    await api.login("o@x.in", "pw", "r2");
    expect(calls[1]).toMatchObject({ url: "/bff/auth/login", body: { email: "o@x.in", password: "pw", restaurant_id: "r2" } });
  });
});
