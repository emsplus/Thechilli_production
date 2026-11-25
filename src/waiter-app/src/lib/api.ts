import { Capacitor } from "@capacitor/core";
import { isNative } from "./native/platform";
import { secureKv } from "./lock/native";
import { counterState, COUNTER_TOKEN_KEY } from "./counter/state";
import { uuid } from "./uuid";
import { tokenVault } from "./native/secureTokens";
import { bootStage, withTimeout } from "./native/boot";
import { initLock, lockState, persistSession } from "./lock/state";
import { SendError, isExtSyncOp, isSyncOp, toWireOp, type SyncOpIn, type SyncResultOut } from "./queue/types";
import { interpret, interpretExtBatchError, perOpResults, restCall } from "./queue/rest";
import type { VoiceOrderResponse } from "./voice";
import { restaurantInput } from "./restaurantCode";
import { apiErrorMessage } from "./apiErrors";
import type { Alias as VoiceAliasDto } from "./aliases";
import type { ActiveOffer, BillPreview, Category, DiningTable, Kot, KotStatus, Me, MenuItem, ModifierGroup, OutletInfo, Restaurant, ServerOrder } from "./types";

/** Baked in at build time. Dev: http://localhost:8000 (pos-service in compose). Android debug: http://10.0.2.2:8000 (see scripts/android-build.sh). */
const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api/v1";
export const API_BASE = BASE;

/** Random id made once per install (also the offline queue's device id). Not a secret. */
export function deviceId(): string {
  try {
    let d = localStorage.getItem("waiter.device");
    if (!d) { d = uuid(); localStorage.setItem("waiter.device", d); }
    return d;
  } catch { return "unknown"; }
}
/** Signed-in devices (pos-service STAFF_PIN_DEVICES_API.md section 1): sent on login and refresh so More > Security and business-admin can list / revoke this phone. */
export function deviceHeaders(): Record<string, string> {
  let platform = "web";
  try { platform = Capacitor.getPlatform(); } catch { /* web */ }
  const h: Record<string, string> = { "X-Device-Platform": platform };
  const id = deviceId();
  if (id !== "unknown") h["X-Device-Id"] = id;
  return h;
}
export interface CustomerDto { id: string; name: string | null; phone: string | null }
/** Dish photos come back as server paths ("/media/..."): resolve them against the API origin. */
export const mediaUrl = (path: string | null | undefined): string | null => {
  if (!path) return null;
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  try { return /^https?:\/\//.test(BASE) ? new URL(BASE).origin + path : path; } catch { return path; }
};
const TOKEN_KEY = "waiter.token";
const REFRESH_KEY = "waiter.refresh";
const EXPIRED_KEY = "waiter.expired";
const SHIFT_KEY = "waiter.shift";
export const ME_KEY = "waiter.me";
/** Fired on window after /auth/me was stored (business type, outlets, permissions may have changed). */
export const ME_EVENT = "waiter-me";
const TIMEOUT_MS = 15000;

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export interface TokenPair { access_token: string; refresh_token: string }

// Web: localStorage. Native (Capacitor): Keystore-backed secure storage, mirrored in memory so reads stay synchronous.
// On native, call `await auth.hydrate()` before trusting `auth.token` (AppShell and the root page do).
const mem = { t: null as string | null, r: null as string | null };
let hydrated = !isNative();
let hydrating: Promise<void> | null = null;
const listeners = new Set<() => void>();
const read = (k: string) => {
  const cs = counterState.get().session; // counter tablet: the PIN session's access token, never a refresh token
  if (cs) return k === TOKEN_KEY ? cs.access : null;
  if (isNative()) return k === TOKEN_KEY ? mem.t : mem.r;
  try { return localStorage.getItem(k); } catch { return null; }
};

export const auth = {
  get token() { return read(TOKEN_KEY); },
  get refreshToken() { return read(REFRESH_KEY); },
  get hydrated() { return hydrated; },
  subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  /** Native only: load tokens from secure storage (and migrate any legacy localStorage tokens). Idempotent. */
  hydrate(): Promise<void> {
    if (hydrated) return Promise.resolve();
    const run = async () => {
      // Counter tablet: only the device credential is stored; staff sign in with their PIN (lib/counter). No phone session.
      const ct = await secureKv.get(COUNTER_TOKEN_KEY);
      counterState.set({ ready: true, deviceToken: ct });
      if (ct) {
        await tokenVault.clear();
        hydrated = true;
        listeners.forEach((f) => f());
        return;
      }
      // MPIN set: the session is sealed in the lock vault and only appears after unlock (lib/lock/actions.ts).
      if ((await initLock()).enabled) {
        await tokenVault.clear(); // never both: a plaintext copy would make the MPIN pointless
        try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(REFRESH_KEY); } catch { /* ignore */ }
        hydrated = true;
        listeners.forEach((f) => f());
        return;
      }
      const t = await tokenVault.load();
      mem.t = t.access; mem.r = t.refresh;
      try {
        const la = localStorage.getItem(TOKEN_KEY), lr = localStorage.getItem(REFRESH_KEY);
        if (!mem.t && la && lr) { mem.t = la; mem.r = lr; await tokenVault.save(la, lr); }
        localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(REFRESH_KEY);
      } catch { /* ignore */ }
      hydrated = true;
      listeners.forEach((f) => f());
    };
    // Startup must never wait forever on the Keystore / secure-storage plugin (a phone where it hangs showed the logo for ever):
    // after 5 s, or on any error, the app continues as "no saved session" and the login screen appears.
    hydrating ??= withTimeout(run().then(() => true, () => false), 5000, false).then((ok) => {
      bootStage(ok ? "hydrated" : "hydrate-fallback");
      if (!hydrated) { hydrated = true; listeners.forEach((f) => f()); }
    });
    return hydrating;
  },
  /** JWT `rid` claim (unverified; only used to scope local data to the signed-in restaurant). */
  get restaurantId(): string | null {
    try {
      const b = auth.token!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return (JSON.parse(atob(b.padEnd(b.length + ((4 - (b.length % 4)) % 4), "="))) as { rid?: string }).rid ?? null;
    } catch { return null; }
  },
  /** JWT `sub` claim (unverified; scopes the local shift to the signed-in waiter). */
  get userId(): string | null {
    try {
      const b = auth.token!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return (JSON.parse(atob(b.padEnd(b.length + ((4 - (b.length % 4)) % 4), "="))) as { sub?: string }).sub ?? null;
    } catch { return null; }
  },
  set(p: TokenPair) {
    if (isNative()) {
      mem.t = p.access_token; mem.r = p.refresh_token;
      const s = { access: p.access_token, refresh: p.refresh_token };
      // With an MPIN the rotated pair is sealed in the vault; without one it goes to Keychain / Keystore as before.
      void persistSession(s).then((sealed) => (sealed ? undefined : tokenVault.save(s.access, s.refresh))).catch(() => { /* memory-only session */ });
    }
    else { try { localStorage.setItem(TOKEN_KEY, p.access_token); localStorage.setItem(REFRESH_KEY, p.refresh_token); } catch { /* storage unavailable */ } }
    listeners.forEach((f) => f());
  },
  /** Forgets the session only. The offline queue is untouched: it syncs after the next sign-in. */
  clear() {
    if (counterState.get().session) counterState.set({ session: null });
    if (isNative()) { mem.t = null; mem.r = null; void tokenVault.clear(); void persistSession(null).catch(() => {}); }
    else { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(REFRESH_KEY); } catch { /* ignore */ } }
    listeners.forEach((f) => f());
  },
  /** After an MPIN / biometric unlock: the session read from the vault goes to memory only (it is already sealed). */
  setUnlocked(p: { access: string; refresh: string }) {
    mem.t = p.access; mem.r = p.refresh;
    listeners.forEach((f) => f());
  },
  /** Locked by the MPIN screen (cold start or auto-lock): screens wait instead of sending the user to sign in. */
  get locked(): boolean { const l = lockState.get(); return l.enabled && l.locked; },
  /** The server rejected our refresh token (revoked/expired): sign out and let the login screen say why. */
  expire() {
    try { localStorage.setItem(EXPIRED_KEY, "1"); } catch { /* ignore */ }
    auth.clear();
  },
  /** Reads (and keeps) the "session expired" flag; `login()` clears it. */
  get expired(): boolean { try { return localStorage.getItem(EXPIRED_KEY) === "1"; } catch { return false; } },
  clearExpired() { try { localStorage.removeItem(EXPIRED_KEY); } catch { /* ignore */ } },
};

// Lock / unlock and counter PIN sign-in / sign-out change what the auth gates decide, so they re-render with them.
lockState.subscribe(() => listeners.forEach((f) => f()));
counterState.subscribe(() => listeners.forEach((f) => f()));

/** Outlet chosen on the outlet screen (stored with the local shift marker); sent as X-Outlet-Id. */
export function currentOutletId(): string | null {
  try { return (JSON.parse(localStorage.getItem(SHIFT_KEY) ?? "null") as { outlet_id?: string } | null)?.outlet_id ?? null; } catch { return null; }
}

async function send(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const outer = init.signal; // caller cancel (voice sheet closed) aborts too
  if (outer) { if (outer.aborted) ctrl.abort(); else outer.addEventListener("abort", () => ctrl.abort(), { once: true }); }
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  catch { throw new ApiError(0, "Cannot reach server"); }
  finally { clearTimeout(timer); }
}

type Refresh = "ok" | "rejected" | "unreachable";
let refreshing: Promise<Refresh> | null = null;
/**
 * Refresh tokens rotate, so only one refresh may be in flight (shared promise within the tab).
 * "rejected" (the server answered 4xx) means the session is dead and the user must sign in again;
 * "unreachable" (network error / 5xx) keeps the session so queued orders retry later.
 */
function refreshSession(): Promise<Refresh> {
  refreshing ??= (async (): Promise<Refresh> => {
    try {
      const rt = auth.refreshToken;
      if (!rt) return "rejected";
      const res = await send(`${BASE}/auth/refresh`, { method: "POST", headers: { ...deviceHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: rt }) });
      if (res.ok) { auth.set((await res.json()) as TokenPair); return "ok"; }
      // 409 = another tab of this browser (same stored session) rotated this token a moment ago. That is NOT a dead session:
      // use the pair the other tab stored. Treating it as "rejected" signed the waiter out on every device sharing the storage.
      if (res.status === 409) { await new Promise((r) => setTimeout(r, 500)); return auth.refreshToken && auth.refreshToken !== rt ? "ok" : "unreachable"; }
      // Rejected, but another tab has stored a newer pair meanwhile: that one is still good.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return auth.refreshToken && auth.refreshToken !== rt ? "ok" : "rejected";
      return "unreachable";
    } catch { return "unreachable"; } finally { refreshing = null; }
  })();
  return refreshing;
}

async function authed(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<Response> {
  const attempt = () => {
    const h = new Headers(init.headers);
    if (!(init.body instanceof FormData)) h.set("Content-Type", "application/json"); // multipart: the browser sets the boundary
    if (auth.token) h.set("Authorization", `Bearer ${auth.token}`);
    const outlet = h.get("X-Outlet-Id") ?? currentOutletId();
    if (outlet) h.set("X-Outlet-Id", outlet);
    return send(`${BASE}${path}`, { ...init, headers: h }, timeoutMs);
  };
  const res = await attempt();
  if (res.status === 401 && counterState.get().session) {
    // PIN session idle / ended / tablet revoked: no refresh token exists; the counter screen shows the roster again.
    const why = res.headers.get("X-Session-Locked");
    counterState.set({ session: null, ended: why === "idle" ? "idle" : "ended" });
    return res;
  }
  if (res.status !== 401 || path.startsWith("/auth/")) return res;
  const r = await refreshSession();
  if (r === "rejected") auth.expire();
  if (r !== "ok") return res;
  return attempt();
}

/** Reads a failed response into an ApiError with plain text (lib/apiErrors.ts). */
async function failure(res: Response): Promise<ApiError> {
  let body: unknown;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return new ApiError(res.status, apiErrorMessage(res.status, body, res.statusText));
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
  const res = await authed(path, init, timeoutMs);
  if (!res.ok) throw await failure(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}
/** GET that answers `null` when the server does not have the route (older pos-service). */
async function optional<T>(path: string): Promise<T | null> {
  const res = await authed(path);
  if (res.status === 404 || res.status === 405 || res.status === 501) return null;
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}
const post = <T,>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

/**
 * Body of POST /sync/operations. `client_sent_at` is the raw device time at the moment THIS batch is sent (ISO-8601 UTC): the server compares
 * it with its own clock to correct a device clock that is wrong (H1 of docs/testing/INDEPENDENT_REVIEW_REPORT.md). Each op keeps its own
 * `client_created_at`. A server that does not know the field ignores it.
 */
export function batchBody(operations: unknown[], now: number = Date.now()): string {
  return JSON.stringify({ operations, client_sent_at: new Date(now).toISOString() });
}

export const api = {
  /** `restaurant` is whatever was typed in the Restaurant code field: the 6-character code goes out as `restaurant_code`
   *  (the identifier may then be a phone, username or email), a pasted restaurant UUID as `restaurant_id`. */
  login: async (email: string, password: string, restaurant?: string) => {
    const res = await send(`${BASE}/auth/login`, { method: "POST", headers: { ...deviceHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ email, password, ...restaurantInput(restaurant), device_label: "Waiter app" }) });
    if (!res.ok) {
      let msg = "Sign-in failed";
      let code: string | undefined;
      try { const b = await res.json(); if (typeof b.detail === "string") msg = b.detail; if (typeof b.code === "string") code = b.code; } catch { /* ignore */ }
      // The server asks for a restaurant_id here; the screen has a Restaurant code field, so say that instead.
      if (code === "restaurant_choice_required") msg = "This email works for several restaurants. Enter the Restaurant code your manager gave you.";
      throw new ApiError(res.status, msg);
    }
    auth.clearExpired();
    return (await res.json()) as TokenPair;
  },
  logout: () => { const rt = auth.refreshToken; return rt ? post<void>("/auth/logout", { refresh_token: rt }).catch(() => {}) : Promise.resolve(); },
  /** `outletId` overrides the stored outlet, to verify access before it is stored. */
  me: async (outletId?: string) => {
    const m = await request<Me>("/auth/me", outletId ? { headers: { "X-Outlet-Id": outletId } } : {});
    // Offline: which outlets / permissions / business type (capabilities) this waiter has. `rid` ties the copy to the restaurant it came from.
    try { localStorage.setItem(ME_KEY, JSON.stringify({ ...m, entitlements: undefined, rid: auth.restaurantId })); window.dispatchEvent(new Event(ME_EVENT)); } catch { /* ignore */ }
    return m;
  },
  restaurant: () => request<Restaurant>("/restaurant"),
  outlets: () => request<OutletInfo[]>("/outlets?include_inactive=false"),
  categories: () => request<Category[]>("/menu/categories"),
  items: () => request<MenuItem[]>("/menu/items"),
  tables: () => request<DiningTable[]>("/tables"),
  orders: (status?: string) => request<ServerOrder[]>(`/orders${status ? `?status=${status}` : ""}`),
  order: (id: string) => request<ServerOrder>(`/orders/${id}`),
  kots: (status?: KotStatus) => request<Kot[]>(`/kot${status ? `?status=${status}` : ""}`),
  setKotStatus: (id: string, status: KotStatus) => request<Kot>(`/kot/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
  /** Learnt Hindi/Hinglish phrases -> dishes (GET /menu/voice-aliases); search aid only. */
  voiceAliases: () => request<VoiceAliasDto[]>("/menu/voice-aliases"),
  /** POST /ai/voice-order (multipart). Read-only on the server; 60 s budget because an upload can be several MB. */
  voiceOrder: (form: FormData, signal?: AbortSignal) => request<VoiceOrderResponse>("/ai/voice-order", { method: "POST", body: form, signal }, 60_000),
  /**
   * Write path of the offline queue. Orders/KOTs: POST /sync/operations (idempotent on op_id). Shift, bill request and cancel are
   * single REST calls (queue/rest.ts) carrying the same op_id. `outletId` is the op's own outlet (X-Outlet-Id), not the selected one.
   * An op missing from the returned results was not decided (transient failure) and stays queued.
   */
  syncOperations: async (operations: SyncOpIn[], outletId: string | null = null): Promise<SyncResultOut[]> => {
    const headers: Record<string, string> = outletId ? { "X-Outlet-Id": outletId } : {};
    const results: SyncResultOut[] = [];
    let i = 0;
    try {
      while (i < operations.length) {
        if (isSyncOp(operations[i].op)) {
          let j = i;
          while (j < operations.length && isSyncOp(operations[j].op)) j++;
          const res = await authed("/sync/operations", { method: "POST", headers, body: batchBody(operations.slice(i, j)) });
          i = j;
          if (res.ok) { results.push(...((await res.json()) as { results: SyncResultOut[] }).results); continue; }
          // 409 may come from a single op (M3): keep the verdicts the answer names; with none, leave the ops out of the results (the
          // engine keeps them queued and retries with backoff) instead of failing the whole group for good.
          if (res.status === 409) { let b: unknown = null; try { b = await res.json(); } catch { /* no body */ } const per = perOpResults(b); if (per) results.push(...per); continue; }
          throw await failure(res);
        }
        if (isExtSyncOp(operations[i].op)) {
          let j = i;
          while (j < operations.length && isExtSyncOp(operations[j].op)) j++;
          const chunk = operations.slice(i, j);
          i = j;
          const res = await authed("/sync/operations", { method: "POST", headers, body: batchBody(chunk.map((o) => ({ ...o, op: toWireOp(o.op) }))) }).catch(() => null);
          if (res && res.ok) { results.push(...((await res.json()) as { results: SyncResultOut[] }).results); continue; }
          let errBody: unknown = null;
          if (res) { try { errBody = await res.json(); } catch { /* no body */ } }
          const handled = interpretExtBatchError(chunk, res ? res.status : 0, errBody);
          if (handled === "auth") throw new SendError(401, "Session expired");
          if (handled !== "retry") results.push(...handled);
          continue;
        }
        const o = operations[i++];
        const call = restCall(o.op);
        if (!call) { results.push({ op_id: o.op_id, status: "failed", detail: "This order has not been confirmed by the server yet.", conflicts: null, data: null }); continue; }
        const res = await authed(call.path, { method: call.method, headers: { ...headers, "Idempotency-Key": o.op_id }, body: JSON.stringify(call.body) }).catch(() => null);
        let body: unknown = null;
        if (res) { try { body = await res.json(); } catch { /* empty or non-JSON */ } }
        const out = interpret(o.op, o.op_id, res ? res.status : 0, body);
        if (out.kind === "auth") throw new SendError(401, "Session expired");
        if (out.kind === "result") results.push(out.result);
        // "retry": leave it out of the results; the engine keeps it queued with backoff
      }
      return results;
    } catch (e) {
      if (e instanceof ApiError) throw new SendError(e.status, e.message);
      throw e;
    }
  },
  /** GET /shifts/current: the caller's open shift at the outlet, `null` = none open, `undefined` = unknown (offline, no route, no permission). */
  currentShift: async (): Promise<{ id: string } | null | undefined> => {
    const res = await authed("/shifts/current").catch(() => null);
    if (!res || !res.ok) return undefined;
    try { return (await res.json()) as { id: string } | null; } catch { return undefined; }
  },
  /** GET /tables/my: tables assigned to the caller's open shift (TableStatusOut[]), or null when the server has no such API. */
  assignedTables: async (): Promise<string[] | null> => {
    const res = await authed("/tables/my").catch(() => null);
    if (!res) throw new ApiError(0, "Cannot reach server");
    if (res.status === 404 || res.status === 405 || res.status === 501) return null;
    if (!res.ok) throw await failure(res);
    const b = (await res.json()) as unknown;
    const list = Array.isArray(b) ? b : [];
    return list.map((x) => (typeof x === "string" ? x : (x as { table_id?: string; id?: string }).table_id ?? (x as { id: string }).id));
  },
  /** GET /tables/status: per-table occupancy with the waiter of each open order, or null on a server without it. */
  tableStatus: async (): Promise<{ table_id: string; status: string; orders: { order_id: string; waiter_id: string; bill_requested_at: string | null; status?: string; total?: string | null; bill_id?: string | null; invoice_number?: string | null; minutes_open?: number | null }[]; reservation?: { id: string; guest_name: string; party_size: number; starts_at: string } | null }[] | null> => {
    const res = await authed("/tables/status").catch(() => null);
    if (!res) throw new ApiError(0, "Cannot reach server");
    if (res.status === 404 || res.status === 405 || res.status === 501 || res.status === 403) return null;
    if (!res.ok) throw await failure(res);
    return (await res.json()) as never;
  },
  /** POST /orders/{id}/request-bill: flags an order for the cashier. Online only; throws ApiError (409 order_billed when the bill already exists). */
  requestBill: (id: string) => post<ServerOrder>(`/orders/${id}/request-bill`, {}),
  /** POST /orders/{id}/remind-payment: "Remind the counter" for a BILLED, unpaid order. Online only (nothing is queued). 200 {already_sent} (idempotent per order per minute);
   * 409 in plain words (not billed / already paid / cancelled); 404/405 on an older server without it. */
  remindPayment: (id: string) => post<{ order_id: string; already_sent: boolean; sent_at: string; balance_due: string; invoice_number: string }>(`/orders/${id}/remind-payment`, {}),
  /** DELETE /orders/{id}/lines/{line_id}: remove a line the kitchen does not have yet (needs orders.cancel_unsent). */
  removeOrderLine: (id: string, lineId: string) => request<ServerOrder>(`/orders/${id}/lines/${lineId}`, { method: "DELETE" }),
  /** POST /orders/{id}/transfer. Online only. Throws ApiError(404|405|501) when the server cannot do it. */
  transferOrder: (id: string, tableId: string) => post<ServerOrder>(`/orders/${id}/transfer`, { table_id: tableId }),
  /** POST /orders/{id}/merge: merges this order INTO `intoOrderId`. */
  /** Customer search (any signed-in staff); create needs crm:write, so a waiter may get 403 (the sheet says so). */
  customers: (q: string, signal?: AbortSignal) => request<CustomerDto[]>(`/customers?q=${encodeURIComponent(q)}`, { signal }),
  createCustomer: (name: string, phone: string) => post<CustomerDto>("/customers", { name: name.trim() || null, phone: phone.trim() || null }),
  /** GET /attendance/me: `null` when this server has no attendance API. */
  attendanceMe: async (): Promise<{ open: { client_uuid: string | null; clock_in_at: string } | null } | null> => optional("/attendance/me"),
  /** GET /menu/modifier-groups (cached with the menu). `[]` on a server without modifiers. */
  modifierGroups: async (): Promise<ModifierGroup[]> => (await optional<ModifierGroup[]>("/menu/modifier-groups")) ?? [],
  /** GET /offers/active: offers running now at this outlet (hint only; the bill applies them). `[]` when unsupported. */
  activeOffers: async (): Promise<ActiveOffer[]> => (await optional<ActiveOffer[]>("/offers/active")) ?? [],
  /** POST /orders/{id}/bill-preview (needs bills.finalize): the exact totals the bill would have now, offers included. */
  billPreview: (id: string) => post<BillPreview>(`/orders/${id}/bill-preview`, { apply_offers: true }),
  mergeOrders: (id: string, intoOrderId: string) => post<ServerOrder>(`/orders/${id}/merge`, { into_order_id: intoOrderId }),
};
