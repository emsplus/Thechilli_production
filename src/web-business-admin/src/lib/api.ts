import type { Alert, BillRequest, ChatReply, VoiceAlias, VoiceOrder, ConversationDetail, ConversationSummary, Customer, HistoryBill, } from "./types";
import type { TableStatus } from "./types";
import type { HubPairing, PrintHub, PrintJob, PrinterCodepage, PrinterConfig, PrinterInput } from "./types";
import type { ManageSummary, Me, RecipeVersion, Role, StaffCreated, StaffInput, StaffMember, RoleDef, RoleInput, PermissionCatalogue, UserOutletAccess, Outlet, OutletInput, OutletPatch } from "./types";
import { syncBody, type SyncOpBody } from "./syncBody";
import type { MenuMetaInput } from "./types";
import { adoptServerKitchenMode } from "./kitchenStatusMode";
import { BFF_PATH, CSRF_HEADER, HINT_COOKIE, decodeHint, jwtClaims, readCookie, tokenTail, type SessionHint } from "./session-cookie";
import { deviceHeaders, monoNow, stepUpSecondsLeft, type CounterDevice, type CounterDeviceCreated, type PinStatus, type SignedInDevice, type StepUpGrant } from "./devices";
import type { VoidResult, CashSession, ChatAttachment, FoodCostReport, CustomerInsights, InsightName, LeakageReport, ProfitLossReport, ReportPdfKind, StaffSalesReport, Expense, ExpenseSummary, BulkCreateResult, BulkItemPayload, CategorySales, ZReportData, ZReportPage, BillPreview, CountryCode, DiscountInput, TaxConfig, TaxKind, Restaurant, AuditPage, CountResult, SystemHealth, Movement, Reconciliation, InventoryItem, Purchase, PurchaseLine, Recipe, RecipeDraft, Supplier, SupplierEmail, EmailSettings, ReorderPreview, Bill, AmendOptions, AmendPreview, AmendRequest, AmendResult, Category, DiningTable, Kot, ShareLink, MenuItem, Order, OrderType, Payment, PaymentMethod } from "./types";

export interface ReorderEmailBody { items: { item_id: string; quantity: string; unit: string }[]; note?: string | null }

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8110/api/v1";
/** Full URL of an API-relative media path (`/api/v1/media/...`): origin of the API base + path; same-origin bases keep the path as is. */
export const mediaUrl = (path: string | null | undefined): string | null => {
  if (!path) return null;
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  try { return /^https?:\/\//.test(BASE) ? new URL(BASE).origin + path : path; } catch { return path; }
};
const TIMEOUT_MS = 15000;

export class ApiError extends Error {
  /**
   * `code`: machine code from the server's error body (`error.code`, `detail.code` or `code`), when it sends one:
   * "outlet_limit_reached", "tenant_suspended", "multiple_restaurants" ... `details`: that error object itself (e.g. the
   * `restaurants` list of a multiple_restaurants answer). `data`: the error object's fields merged with the body's
   * (`error` / `detail` / `error.details`), e.g. `existing_order_id`, `can_replace`.
   */
  constructor(public status: number, message: string, public code?: string, public details?: Record<string, unknown>, public data?: Record<string, unknown>) { super(message); }
}

/** What sign-in, registration and refresh give the page: the short-lived access token only (the refresh token stays in an httpOnly cookie). */
export interface SessionGrant { access_token: string; token_type?: string; expires_in?: number }

// ---- Session -------------------------------------------------------------------------------------------------------
// The access token lives in this module only (memory): never in localStorage, sessionStorage or a readable cookie.
// The 30-day refresh token is an httpOnly cookie that only the BFF (src/app/bff/auth/*) can read. The readable
// `pos_session` cookie is a non-secret marker (session id, restaurant, user) so the app knows offline, synchronously,
// that the device is signed in and whose local data is whose. See src/lib/session-cookie.ts.
// `sid` ties it to the session it was granted for: when another tab signs out and in as someone else, the marker cookie
// changes and this token is no longer used (offline sales of one restaurant must never go out under another's token).
let access: { token: string; exp: number; sid: string | null } | null = null;
/** Seconds before expiry at which the token is renewed before use instead of being sent and rejected. */
const RENEW_EARLY_S = 30;
const LEGACY_TOKEN = "pos.token";
const LEGACY_REFRESH = "pos.refresh";
const EPOCH_KEY = "pos.authEpoch";

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const dropLegacy = () => { try { localStorage.removeItem(LEGACY_TOKEN); localStorage.removeItem(LEGACY_REFRESH); } catch { /* ignore */ } };
/** Fires a `storage` event in the other tabs (they re-check the sign-in state). */
const ping = () => { try { localStorage.setItem(EPOCH_KEY, String(Date.now())); } catch { /* ignore */ } };
const hint = (): SessionHint | null => (typeof document === "undefined" ? null : decodeHint(readCookie(document.cookie, HINT_COOKIE)));
const nowS = () => Date.now() / 1000;
/** The in-memory token, when it still has more than RENEW_EARLY_S to live. */
/**
 * Seconds the SERVER's clock is ahead of this device's (negative: behind), learnt from the `Date` header of the same-origin token exchange.
 * A device whose clock is off by more than the token's life (15 min) used to see every access token as expired on arrival and refreshed
 * (rotated the refresh token) before EVERY request: 19 refreshes in 75 s at +45 min (QA chaos run 2026-11-02). Only differences above
 * 20 s are applied; a few seconds are network latency.
 */
let clockSkewS = 0;
export function learnClockSkew(dateHeader: string | null, nowSeconds: number = nowS()): void {
  const t = dateHeader ? Date.parse(dateHeader) : NaN;
  if (!Number.isFinite(t)) return;
  const d = t / 1000 - nowSeconds;
  clockSkewS = Math.abs(d) > 20 ? d : 0;
}
export const tokenSecondsLeft = (exp: number, nowSeconds: number = nowS(), skewS: number = clockSkewS): number => exp - (nowSeconds + skewS);
const freshToken = (): string | null => (access && access.sid === (hint()?.sid ?? null) && tokenSecondsLeft(access.exp) > RENEW_EARLY_S ? access.token : null);

export const auth = {
  /**
   * Signed-in marker of this device: an opaque per-sign-in session id, or null when signed out. NOT a credential (the
   * name is historical: every screen's "signed in?" check reads it). Use `accessToken` for the Authorization header.
   */
  get token(): string | null { return hint()?.sid ?? (read(LEGACY_REFRESH) ? "legacy" : null); },
  /** The in-memory access token, or null (signed out, not fetched yet since this page loaded, or offline). */
  get accessToken(): string | null { return access && access.sid === (hint()?.sid ?? null) ? access.token : null; },
  /** Restaurant of the signed-in session (from the session cookie / JWT `rid`, unverified: only used to scope local data). */
  get restaurantId(): string | null { return hint()?.rid ?? jwtClaims(read(LEGACY_TOKEN))?.rid ?? null; },
  /** User of the signed-in session (unverified: only used to pick the caller's own row from a list). */
  get userId(): string | null { return hint()?.sub ?? jwtClaims(read(LEGACY_TOKEN))?.sub ?? null; },
  /** Keeps a freshly granted access token (memory only). The BFF has already set the cookies. */
  set(g: SessionGrant) {
    const exp = jwtClaims(g.access_token)?.exp ?? nowS() + clockSkewS + (g.expires_in ?? 1800); // no exp claim: a duration from now; + skew because tokenSecondsLeft subtracts it again
    access = { token: g.access_token, exp, sid: hint()?.sid ?? null };
    dropLegacy(); ping();
  },
  /**
   * Forgets the session on this page: the in-memory token and the readable marker. The httpOnly cookies are cleared by
   * the BFF (`api.logout`). The IndexedDB offline queue is deliberately untouched: it syncs after the next sign-in.
   */
  clear() {
    access = null;
    stepUpGrant = null;
    if (typeof document !== "undefined") {
      const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${HINT_COOKIE}=; Max-Age=0; Path=/; SameSite=Strict${secure}`;
    }
    dropLegacy(); ping();
  },
};

/** Endpoints whose 401 means "wrong credentials/token", never "access token expired". */
const NO_REFRESH = ["/auth/login", "/auth/register-restaurant", "/auth/refresh", "/auth/logout", "/auth/accept-invite"];

/** One network attempt with a timeout. Network failure / timeout => ApiError(0): offline, never a reason to refresh or sign out. */
async function send(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const ext = init.signal; // a caller-supplied signal (e.g. a stale bill-preview) cancels this attempt too
  if (ext) { if (ext.aborted) ctrl.abort(); else ext.addEventListener("abort", () => ctrl.abort(), { once: true }); }
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  catch (e) { if (ext?.aborted) throw new DOMException("Aborted", "AbortError"); throw new ApiError(0, e instanceof DOMException && e.name === "AbortError" ? "Request timed out" : "Cannot reach server"); }
  finally { clearTimeout(timer); }
}

/** POST to this app's own token exchange (same origin: the cookies ride along; the custom header is the CSRF check). */
async function bff(path: string, body?: unknown, extra: RequestInit = {}): Promise<Response> {
  const res = await send(`${BFF_PATH}${path}`, {
    method: "POST", credentials: "same-origin", cache: "no-store", ...extra,
    // The device headers let the API record this browser as one signed-in device (docs/STAFF_PIN_DEVICES_API.md 1).
    headers: { "Content-Type": "application/json", [CSRF_HEADER]: "1", ...deviceHeaders(), ...(extra.headers as Record<string, string> | undefined) },
    body: JSON.stringify(body ?? {}),
  }, TIMEOUT_MS);
  learnClockSkew(res.headers.get("date"));
  return res;
}

let refreshing: Promise<boolean> | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Gets an access token for this page from the session cookie; resolves false when the session is really over, throws
 * ApiError(0) when offline (the session is kept). `rejected` = the token the API just refused (forces a rotation).
 * Single-flight within a tab (shared promise) and across tabs (Web Locks): refresh tokens rotate and a replayed one
 * revokes the whole session, so only one rotation may be in flight per device.
 */
export function refreshSession(rejected: string | null): Promise<boolean> {
  refreshing ??= (async () => {
    try { return typeof navigator !== "undefined" && navigator.locks ? await navigator.locks.request("pos-auth-refresh", () => doRefresh(rejected)) : await doRefresh(rejected); }
    finally { refreshing = null; }
  })();
  return refreshing;
}

async function doRefresh(rejected: string | null): Promise<boolean> {
  const have = freshToken();
  if (have && have !== rejected) return true; // another caller refreshed while we waited
  const legacy = hint() ? null : read(LEGACY_REFRESH); // a session saved by an older version of the app: moved into the cookie once
  for (let i = 0; i < 8; i++) {
    const res = await bff("/refresh", { rejected: rejected ? tokenTail(rejected) : undefined, legacy_refresh_token: legacy ?? undefined });
    if (res.ok) { auth.set(await res.json() as SessionGrant); return true; }
    // A concurrent rotation (another tab without Web Locks) won a moment ago; the browser now holds its newer cookie.
    if (res.status === 409) { await sleep(250); continue; }
    if (res.status === 401) { dropLegacy(); return false; }
    throw new ApiError(res.status, "Could not renew the session"); // 5xx, 429 etc.: transient, keep the session
  }
  return false;
}

/**
 * Tells the open screen the session is over. A screen with unsaved work (the counter) answers with its own calm
 * "Session expired, sign in again" prompt (it calls preventDefault); true = it did. Nothing else happens here.
 */
export function announceSessionExpired(): boolean {
  return typeof window !== "undefined" && !window.dispatchEvent(new Event("pos:session-expired", { cancelable: true }));
}

function sessionExpired() {
  auth.clear();
  void bff("/logout", undefined, { keepalive: true }).catch(() => { /* offline: the cookies die with the session anyway */ });
  if (announceSessionExpired()) return;
  if (typeof window !== "undefined" && !location.pathname.startsWith("/login")) window.location.assign(new URL("/login", window.location.origin).href); // full reload on purpose: drops all in-memory state
}

/**
 * The access token to send now. After a page load (or once it is about to expire) it is fetched from the session cookie
 * first. That is also how an operation queued offline is sent once the device is back online: the token it was queued
 * under may have expired, so the sync asks the BFF for a new one (rotating the refresh token) before uploading.
 * null = signed out (the request goes without a token and the API answers 401).
 */
async function currentToken(): Promise<string | null> {
  const have = freshToken();
  if (have) return have;
  if (!auth.token) return null;
  if (!(await refreshSession(null))) { sessionExpired(); return null; }
  return auth.accessToken;
}

/**
 * Authenticated fetch used by every API call (JSON, blobs, uploads). On a 401 it refreshes once (single-flight)
 * and retries the request once; only if that fails is the session cleared and the app sent to /login.
 */
async function authedFetch(path: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const attempt = (token: string | null) => {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return send(`${BASE}${path}`, { ...init, headers }, timeoutMs);
  };
  const sent = await currentToken();
  const res = await attempt(sent);
  if (res.status === 401 && !NO_REFRESH.includes(path) && !auth.token) announceSessionExpired(); // the session is already gone (cookies cleared, other tab signed out): a screen with work shows its sign-in prompt
  if (res.status !== 401 || NO_REFRESH.includes(path) || !auth.token) return res;
  if (!(await refreshSession(sent))) { sessionExpired(); return res; }
  const again = await attempt(auth.accessToken);
  if (again.status === 401) sessionExpired();
  return again;
}

async function errorFrom(res: Response, fallback?: string): Promise<ApiError> {
  let msg = fallback ?? res.statusText;
  let code: string | undefined;
  let details: Record<string, unknown> | undefined;
  let data: Record<string, unknown> | undefined;
  // Step-up (docs/STAFF_PIN_DEVICES_API.md 5): 403 + X-Step-Up-Required: 1 -> "re-enter your PIN". Readable same-origin or
  // when the API exposes the header; devices.ts isStepUpRequired also accepts the message.
  const stepUp = res.headers.get("x-step-up-required") === "1";
  try {
    const body = await res.json();
    const c = body?.error?.code ?? body?.detail?.code ?? body?.code;
    if (typeof c === "string") code = c;
    if (stepUp) code = "step_up_required";
    const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
    details = obj(body?.error) ?? obj(body?.detail);
    data = { ...obj(body), ...obj(body?.detail), ...obj(body?.error), ...obj(body?.error?.details) };
    if (obj(body?.detail) && typeof body.detail.message === "string" && !fallback) { msg = body.detail.message; return new ApiError(res.status, msg, code, details, data); }
    if (obj(body?.error) && typeof body.error.message === "string" && body.detail === undefined && !fallback) { msg = body.error.message; return new ApiError(res.status, msg, code, details, data); }
    if (typeof body?.error?.message === "string" && body.detail === undefined) msg = body.error.message;
    if (Array.isArray(body.detail) && body.detail.every((d: unknown) => d && typeof d === "object" && ("message" in d || "msg" in d))) {
      // Row-level validation errors ({row, field, message}) or FastAPI's own ({loc, msg}).
      msg = body.detail.slice(0, 5).map((d: { row?: number; message?: string; msg?: string }) => (d.row ? `Row ${d.row}: ` : "") + (d.message ?? d.msg)).join("; ") + (body.detail.length > 5 ? ` (+${body.detail.length - 5} more)` : "");
    } else if (body.detail !== undefined) msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    else if (!fallback && typeof body?.error?.message !== "string") msg = JSON.stringify(body);
  } catch { /* non-JSON error */ }
  return new ApiError(res.status, msg, stepUp ? "step_up_required" : code, details, data);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authedFetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string>) } });
  if (!res.ok) throw await errorFrom(res);
  try { return (res.status === 204 ? undefined : await res.json()) as T; }
  catch { throw new ApiError(0, "Cannot reach server"); } // body cut off mid-stream
}

async function bffJson<T>(path: string, body: unknown): Promise<T> {
  const res = await bff(path, body);
  if (!res.ok) {
    const e = await errorFrom(res);
    const ra = Number(res.headers.get("Retry-After"));
    throw Object.assign(e, { retryAfter: Number.isFinite(ra) && ra > 0 ? ra : undefined });
  }
  try { return (res.status === 204 ? undefined : await res.json()) as T; }
  catch { return undefined as T; }
}

/** Escape hatch for feature modules that own their own endpoints (reportsApi.ts): same auth, refresh and error mapping as `api`. */
export { authedFetch, errorFrom, request as apiRequest };

// ---- Step-up (docs/STAFF_PIN_DEVICES_API.md 5) ------------------------------------------------------------------------
// The 5-minute step-up token lives in this module only (memory), bound to the user it was issued for. It is sent as
// X-Step-Up-Token on the sensitive requests (void, bill / bill-preview with a discount) while it lasts.
let stepUpGrant: { token: string; expires_in: number; received: number; sub: string | null } | null = null; // received: monotonic ms (monoNow), never the wall clock
export const stepUp = {
  /** Header to add to a sensitive request, or {} when there is no live grant for the signed-in user. */
  header(): Record<string, string> {
    if (!stepUpGrant || stepUpGrant.sub !== auth.userId || stepUpSecondsLeft(stepUpGrant) < 5) return {};
    return { "X-Step-Up-Token": stepUpGrant.token };
  },
  active: () => Object.keys(stepUp.header()).length > 0,
  clear() { stepUpGrant = null; },
};
export class StepUpError extends ApiError {
  constructor(status: number, message: string, public attemptsLeft: number | null, public retryAfter: number | null) { super(status, message); }
}
/** Re-enter the PIN (or password) through the BFF (src/app/bff/auth/step-up): keeps the grant in memory. Throws StepUpError. */
async function requestStepUp(cred: { pin: string } | { password: string }): Promise<StepUpGrant> {
  const call = async (token: string | null) => bff("/step-up", cred, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  const sent = await currentToken();
  let res = await call(sent);
  const wrongCredential = (r: Response, detail: string) => r.headers.has("x-pin-attempts-left") || /^wrong (pin|password)/i.test(detail);
  if (res.status === 401) {
    const detail = await res.clone().json().then((b) => String(b?.detail ?? ""), () => "");
    // A wrong PIN is a 401 too: only an expired access token (no "Wrong PIN") is worth one refresh and retry.
    if (!wrongCredential(res, detail) && auth.token && (await refreshSession(sent))) res = await call(auth.accessToken);
  }
  if (!res.ok) {
    const e = await errorFrom(res);
    const n = (h: string) => { const v = res.headers.get(h); const x = v === null ? NaN : Number(v); return Number.isFinite(x) ? x : null; };
    throw new StepUpError(e.status, e.message, n("x-pin-attempts-left"), n("retry-after"));
  }
  const g = await res.json() as StepUpGrant;
  stepUpGrant = { token: g.step_up_token, expires_in: g.expires_in, received: monoNow(), sub: auth.userId };
  return g;
}
const withStepUp = (init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...stepUp.header() } });
const withDevice = (init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string> | undefined), "X-Device-Id": deviceHeaders()["X-Device-Id"] } });

const post = <T,>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

const qs = (q: Record<string, string | undefined>) => { const e = Object.entries(q).filter(([, v]) => v); return e.length ? "?" + e.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&") : ""; };
export interface ExpenseInput { supplier_id?: string | null; supplier_name: string; invoice_number?: string | null; expense_date: string; category: string; net: string; vat: string; note?: string | null; invoice_id?: string | null }

const insight = <T,>(name: InsightName, from: string, to: string) => request<T>(`/reports/${name}?from=${from}&to=${to}`);

export const api = {
  /**
   * Sign-in through the BFF (sets the session cookies). 409 `multiple_restaurants` (ApiError.code) carries
   * `details.restaurants: [{ id, name }]`: ask which one and call again with `restaurant_id`.
   */
  login: (email: string, password: string, restaurant_id?: string) => bffJson<SessionGrant>("/login", { email, password, restaurant_id }),
  /** Staff sign-in through the BFF: restaurant code + phone / username / email + password. `password_change_required`: a one-time password. */
  loginWithCode: (restaurant_code: string, identifier: string, password: string) =>
    bffJson<SessionGrant & { password_change_required?: boolean }>("/login", { restaurant_code, identifier, password, device_label: "Counter (code sign-in)" }),
  /** Single-use invite link (staff invite or the owner's provisioning invite) through the BFF: sets the first password and signs in. */
  acceptInvite: (token: string, password: string) => bffJson<SessionGrant>("/accept-invite", { token, password }),
  registerRestaurant: (b: { restaurant_name: string; country?: CountryCode; trn?: string; owner_email: string; owner_name: string; owner_password: string; business_types?: string[] }) =>
    // 201: signed in (a grant). 202 SignupPending: enter the emailed code (SignupCodeStep). Any other 202: null ("check your email").
    bffJson<SessionGrant | SignupPending | null>("/register", b).then((g) => (g && typeof (g as SessionGrant).access_token === "string" ? g as SessionGrant : g && isSignupPending(g) ? g : null)),
  /** Finishes a pending sign-up with the emailed 6-digit code through the BFF (sets the session cookies). Every bad code is the same 400. */
  verifyEmail: (email: string, otp: string) => bffJson<SessionGrant>("/verify-email", { email, otp }),
  /** A new sign-up code (same answer whether or not one is pending); 429 + Retry-After inside the resend gap. No tokens: straight to the API. */
  resendVerifyEmail: (email: string) => anonPost<{ detail: string; resend_after_seconds?: number }>("/auth/verify-email/resend", { email }),
  /** Revokes this device's session on the API and clears the session cookies (keepalive: survives the redirect to /login). */
  logout: async () => { const r = await bff("/logout", undefined, { keepalive: true }); if (!r.ok) throw await errorFrom(r); },
  restaurant: () => request<Restaurant>("/restaurant").then((r) => { adoptServerKitchenMode(r); return r; }),
  categories: () => request<Category[]>("/menu/categories"),
  items: (categoryId?: string) => request<MenuItem[]>(`/menu/items${categoryId ? `?category_id=${categoryId}` : ""}`),
  createCategory: (name: string) => post<Category>("/menu/categories", { name }),
  createItem: (b: { category_id: string; name: string; price: string; tax_kind?: TaxKind; gst_rate_code?: string; variants: { name: string; price_delta: string }[] } & MenuMetaInput) => post<MenuItem>("/menu/items", b),
  createTable: (label: string, seats: number, area: OrderType) => post<DiningTable>("/tables", { label, seats, area }),
  tables: () => request<DiningTable[]>("/tables"),
  /** `allow_second_order`: the cashier chose "Start a separate order" on a table that has one (else 409 table_has_open_order). */
  createOrder: (b: { client_uuid: string; order_type: OrderType; table_id: string | null; customer_id?: string | null; allow_second_order?: boolean; lines: { item_id: string; variant_id?: string | null; quantity: number; modifiers?: string[]; note?: string }[] }) => post<Order>("/orders", b),
  sendKot: (orderId: string) => post<Kot>(`/orders/${orderId}/kot`),
  /** Live state of every table (free / occupied / bill_requested / reserved) with its open orders. */
  tableStatus: () => request<TableStatus[]>("/tables/status"),
  /** The cashier's queue (bills.finalize): open orders whose waiter asked for the bill, oldest first. */
  billRequests: () => request<BillRequest[]>("/bill-requests"),
  /** The counter clears a waiter's "remind the counter" alert without taking payment (pos-service docs/WAITER_API.md 4b; 404/405 on older servers). */
  dismissPaymentReminder: (orderId: string) => post<{ order_id: string; dismissed: boolean }>(`/orders/${orderId}/dismiss-payment-reminder`),
  /** Move an unbilled dine-in order to another free table (409 when that table has an open order). */
  transferOrder: (orderId: string, tableId: string) => post<Order>(`/orders/${orderId}/transfer`, { table_id: tableId }),
  /** Remove a line the kitchen has not been sent yet (409 once sent, or when it is the only line). */
  removeOrderLine: (orderId: string, lineId: string) => request<Order>(`/orders/${orderId}/lines/${lineId}`, { method: "DELETE" }),
  /** Sold out today / back in stock (resets at midnight; pos-service docs/ORDER_RULES.md 6; 404/405 on servers without it). */
  setSoldOut: (id: string, sold_out: boolean) => request<MenuItem>(`/menu/items/${id}/sold-out`, { method: "PATCH", body: JSON.stringify({ sold_out }) }),
  /** Print every kitchen slip of the order that needs it again (docs/ORDER_RULES.md 4). */
  retryOrderPrint: (orderId: string) => post<{ order_id: string; needs_reprint: boolean; kots: Kot[] }>(`/orders/${orderId}/print/retry`),
  /** Add items to an order that is already placed / in the kitchen (409 once billed or cancelled); idempotent on batch_uuid. */
  addOrderLines: (orderId: string, b: { batch_uuid: string; lines: { item_id: string; variant_id?: string | null; quantity: number; expected_unit_price?: string; modifiers?: string[]; note?: string }[] }) =>
    post<Order>(`/orders/${orderId}/lines`, b),
  orders: (status?: string) => request<Order[]>(`/orders${status ? `?status=${status}` : ""}`),
  /** Attach / change / clear (null) the customer of an order until it is billed (409 once billed or cancelled). */
  setOrderCustomer: (orderId: string, customerId: string | null) => request<Order>(`/orders/${orderId}/customer`, { method: "PUT", body: JSON.stringify({ customer_id: customerId }) }),
  cancelOrder: (orderId: string, reason: string) => post<Order>(`/orders/${orderId}/cancel`, { reason }),
  kots: (status?: string) => request<Kot[]>(`/kot${status ? `?status=${status}` : ""}`),
  /** KOT-only kitchen: the one step (POST /kot/{id}/done). Idempotent. */
  doneKot: (id: string) => request<Kot>(`/kot/${id}/done`, { method: "POST" }),
  updateKot: (id: string, status: "pending" | "preparing" | "ready" | "served" | "cancelled") => request<Kot>(`/kot/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
  bills: (includeSuperseded = false) => request<Bill[]>(`/bills${includeSuperseded ? "?include_superseded=true" : ""}`),
  // ---- Correct a finalized bill (owner / manager): credit note + replacement invoice, original untouched
  amendOptions: (billId: string) => request<AmendOptions>(`/bills/${billId}/amend-options`),
  amendPreview: (billId: string, b: AmendRequest, signal?: AbortSignal) => request<AmendPreview>(`/bills/${billId}/amend-preview`, { method: "POST", signal, body: JSON.stringify(b) }),
  amend: (billId: string, b: AmendRequest & { reason: string; idempotency_key: string; refund_method?: "cash" | "card" | "other" }) => post<AmendResult>(`/bills/${billId}/amend`, b),
  updateItem: (id: string, b: { category_id: string; name: string; price: string; tax_kind?: TaxKind; gst_rate_code?: string; variants: { id?: string; name: string; price_delta: string }[] } & MenuMetaInput) =>
    request<MenuItem>(`/menu/items/${id}`, { method: "PUT", body: JSON.stringify(b) }),
  /** Food mark / description only (pos-service PATCH /menu/items/{id}): omitted = unchanged, null = cleared. */
  patchItemMeta: (id: string, b: MenuMetaInput) => request<MenuItem>(`/menu/items/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  /** `replace_existing`: correct an unpaid bill that has a different discount (after 409 bill_already_exists with can_replace). */
  finalize: (orderId: string, b?: { discount?: DiscountInput | null; service_charge?: boolean; apply_offers?: boolean; replace_existing?: boolean }) => request<Bill>(`/orders/${orderId}/bill`, withStepUp({ method: "POST", body: b ? JSON.stringify({ discount: b.discount ?? undefined, service_charge: b.service_charge, ...(b.apply_offers === false ? { apply_offers: false } : {}), ...(b.replace_existing ? { replace_existing: true } : {}) }) : undefined })),
  /** An OPEN bill (made, nothing paid yet) with a discount added / changed / removed (`null`): the exact new bill, nothing saved. */
  billDiscountPreview: (billId: string, discount: DiscountInput | null, signal?: AbortSignal) =>
    request<BillPreview>(`/bills/${billId}/discount-preview`, withStepUp({ method: "POST", signal, body: JSON.stringify({ discount }) })),
  /** Adds / changes / removes (`null`) the discount of an OPEN bill. The issued invoice gets a credit note and a replacement invoice; returns the bill that stands now. 409 bill_has_payment once money was taken. */
  applyBillDiscount: (billId: string, discount: DiscountInput | null) =>
    request<Bill>(`/bills/${billId}/discount`, withStepUp({ method: "POST", body: JSON.stringify({ discount }) })),
  /** Exactly what `finalize` would produce right now; nothing is saved. `signal` cancels stale requests. */
  async billPreview(orderId: string, b: { discount?: DiscountInput | null; service_charge?: boolean; apply_offers?: boolean }, signal?: AbortSignal): Promise<BillPreview> {
    return request<BillPreview>(`/orders/${orderId}/bill-preview`, withStepUp({ method: "POST", signal, body: JSON.stringify({ discount: b.discount ?? undefined, service_charge: b.service_charge, ...(b.apply_offers === false ? { apply_offers: false } : {}) }) }));
  },
  taxConfig: () => request<TaxConfig>("/billing/tax-config"),
  pay: (billId: string, b: { idempotency_key: string; method: PaymentMethod; amount: string }) => post<Payment>(`/bills/${billId}/payments`, b),
  bill: (id: string) => request<Bill>(`/bills/${id}`),
  taxRate: () => request<{ name: string; rate_percent: string; currency: string }>("/billing/tax-rate"),
  syncOperations: (operations: SyncOpBody[]) =>
    post<{ results: { op_id: string; status: "synced" | "conflict" | "failed"; detail: string | null; conflicts: { item: string; expected: string; current: string }[] | null; data: Record<string, unknown> | null }[] }>("/sync/operations", syncBody(operations)),
  report: <T,>(name: "daily-sales" | "item-sales" | "order-summary" | "purchases" | "profitability", from: string, to: string) =>
    request<T>(`/reports/${name}?from_date=${from}&to_date=${to}`),
  customers: (q?: string) => request<Customer[]>(`/customers${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  /** Name and phone are each optional, at least one is required. Duplicate phone -> ApiError 409. */
  createCustomer: (b: { name?: string | null; phone?: string | null; email?: string | null; notes?: string | null }) => post<Customer>("/customers", b),
  /** Only the fields sent change; the customer must keep a name or a phone (422). Duplicate phone -> 409. */
  updateCustomer: (id: string, b: { name?: string | null; phone?: string | null; email?: string | null; notes?: string | null }) => request<Customer>(`/customers/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  recordConsent: (id: string, b: { channel: string; granted: boolean; source: string }) => post<Customer>(`/customers/${id}/consent`, b),
  customerHistory: (id: string) => request<HistoryBill[]>(`/customers/${id}/history`),
  alerts: () => request<Alert[]>("/alerts"),
  chat: (message: string, conversation_id?: string) => post<ChatReply>("/ai/chat", { message, conversation_id }),
  /** Spoken (recording) or typed order -> menu lines + customer for the till's confirm sheet. Nothing is saved. */
  /** `language`: what staff chose to speak (en | hi | pa | auto), a hint for the AI. */
  async voiceOrder(input: { audio: Blob } | { text: string }, language?: string): Promise<VoiceOrder> {
    const fd = new FormData();
    if (language) fd.append("language", language);
    if ("audio" in input) {
      const ext = input.audio.type.includes("mp4") ? "m4a" : input.audio.type.includes("ogg") ? "ogg" : input.audio.type.includes("wav") ? "wav" : "webm";
      fd.append("file", input.audio, `order.${ext}`);
    } else fd.append("text", input.text);
    const res = await authedFetch("/ai/voice-order", { method: "POST", body: fd }, 90000);
    if (!res.ok) throw await errorFrom(res, "Could not understand the order");
    return res.json();
  },
  /** Phrases the till learnt from staff corrections (shared by every device of the restaurant). */
  voiceAliases: () => request<VoiceAlias[]>("/menu/voice-aliases"),
  learnVoiceAlias: (b: { phrase: string; menu_item_id: string; variant_id: string | null }) => request<VoiceAlias>("/menu/voice-aliases", { method: "PUT", body: JSON.stringify(b) }),
  deleteVoiceAlias: (id: string) => request<void>(`/menu/voice-aliases/${id}`, { method: "DELETE" }),
  conversations: () => request<ConversationSummary[]>("/ai/conversations"),
  conversation: (id: string) => request<ConversationDetail>(`/ai/conversations/${id}`),
  heartbeat: (device_key: string, pending_ops: number) => request<void>("/sync/heartbeat", { method: "POST", body: JSON.stringify({ device_key, pending_ops }) }),
  inventoryItems: () => request<InventoryItem[]>("/inventory/items"),
  createInventoryItem: (b: { name: string; base_unit: string; reorder_level: string; supplier_id?: string | null; reorder_quantity?: string | null; reorder_unit?: string }) => post<InventoryItem>("/inventory/items", b),
  bulkCreateItems: (b: { items: BulkItemPayload[]; idempotency_key: string; strict?: boolean }) => post<BulkCreateResult>("/inventory/items/bulk", b),
  adjust: (b: { idempotency_key: string; item_id: string; kind: "adjustment" | "wastage"; quantity: string; unit: string; reason: string }) => post<{ status: string }>("/inventory/adjustments", b),
  suppliers: () => request<Supplier[]>("/suppliers"),
  createSupplier: (name: string, trn?: string | null) => post<Supplier>("/suppliers", { name, ...(trn ? { trn } : {}) }),
  expenses: (q: { from?: string; to?: string } = {}) => request<Expense[]>(`/expenses${qs(q)}`),
  expenseSummary: (q: { from?: string; to?: string } = {}) => request<ExpenseSummary>(`/expenses/summary${qs(q)}`),
  createExpense: (b: ExpenseInput) => post<Expense>("/expenses", b),
  updateExpense: (id: string, b: Partial<ExpenseInput>) => request<Expense>(`/expenses/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  purchases: () => request<Purchase[]>("/purchases"),
  purchase: (id: string) => request<Purchase>(`/purchases/${id}`),
  async uploadPurchase(file: File, supplierId?: string): Promise<Purchase> {
    const fd = new FormData();
    fd.append("file", file);
    if (supplierId) fd.append("supplier_id", supplierId);
    const res = await authedFetch("/purchases", { method: "POST", body: fd }, 120000); // FormData is re-sendable on retry
    if (!res.ok) throw await errorFrom(res, "Upload failed");
    return res.json();
  },
  savePurchase: (id: string, b: { supplier_id: string | null; invoice_number: string | null; invoice_date: string | null; document_type?: string; lines: (Omit<PurchaseLine, "id" | "line_total" | "confidence"> & { line_total?: string })[] }) =>
    request<Purchase>(`/purchases/${id}`, { method: "PUT", body: JSON.stringify(b) }),
  /** Selects (or creates, once) the supplier the scanned bill names. Safe to repeat. */
  resolveSupplier: (id: string) => post<Purchase>(`/purchases/${id}/resolve-supplier`),
  confirmPurchase: (id: string) => post<Purchase>(`/purchases/${id}/confirm`),
  retryExtraction: (id: string) => post<Purchase>(`/purchases/${id}/retry-extraction`),
  recipes: () => request<Recipe[]>("/recipes"),
  saveRecipe: (b: { menu_item_id: string; ingredients: { item_id: string; quantity: string; unit: string }[] }) => post<Recipe>("/recipes", b),
  inventoryLedger: (itemId: string, limit = 500) => request<Movement[]>(`/inventory/ledger?item_id=${itemId}&limit=${limit}`),
  stockCount: (b: { idempotency_key: string; lines: { item_id: string; counted: string; unit: string }[] }) => post<CountResult[]>("/inventory/counts", b),
  auditLogs: (f: { action?: string; entity?: string; from_date?: string; to_date?: string; limit?: number; cursor?: string | null }) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    return request<AuditPage>(`/audit-logs?${q}`);
  },
  health: () => request<SystemHealth>("/system/health"),
  reconciliation: () => request<Reconciliation>("/system/reconciliation"),
  // ---- Manage panel (back-office CRUD)
  /** Voids a whole bill (pos-service phase2/void: POST /bills/{id}/void, permission bills.void). Money is handed back by hand; the response may carry `refund_due`. */
  voidBill: (billId: string, b: { reason: string; idempotency_key: string }) => request<VoidResult>(`/bills/${billId}/void`, withStepUp({ method: "POST", body: JSON.stringify(b) })),
  manageSummary: () => request<ManageSummary>("/manage/summary"),
  /**
   * Cash drawer sessions (pos-service phase2/void, docs/CASH_SESSIONS.md, permission cashier.shift).
   * current: the caller's open session, null when none (the server answers 404 with its own message), "unsupported" when the route does not exist
   * (a bare "Not Found", or 405/501) so the UI hides the feature.
   */
  cashSessionCurrent: async (): Promise<CashSession | null | "unsupported"> => {
    // "No drawer open" is the normal state: ask the list (200, possibly empty) instead of /current, whose 404 the browser
    // logs as a console error on every Today / Cash load (UI_REVIEW BA-21). The list is scoped to this request's outlet;
    // owners / managers see everyone's open drawers there, so the caller's own one is picked by the token's user id.
    const me = auth.userId;
    if (me) {
      try {
        const open = await request<CashSession[]>("/cash-sessions?status=open&limit=200");
        return open.find((s) => s.cashier_id === me && s.status === "open") ?? null;
      } catch (e) {
        if (!(e instanceof ApiError && [404, 405, 422, 501].includes(e.status))) throw e; // older server: fall back to /current
      }
    }
    try { return await request<CashSession>("/cash-sessions/current"); }
    catch (e) {
      if (e instanceof ApiError && (e.status === 405 || e.status === 501 || (e.status === 404 && /^not found\.?$/i.test(e.message.trim())))) return "unsupported";
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  /** The latest shifts (any status), newest first by `opened_at` on the caller's side: the opening floats feed the "unusual opening amount" check. */
  cashSessionsRecent: () => request<CashSession[]>("/cash-sessions?limit=20"),
  openCashSession: (b: { opening_float: string; idempotency_key: string }) => post<CashSession>("/cash-sessions", b),
  closeCashSession: (id: string, b: { counted_cash: string; variance_reason?: string }) => post<CashSession>(`/cash-sessions/${id}/close`, b),
  me: () => request<Me>("/auth/me").then((m) => { adoptServerKitchenMode(m?.order_rules); return m; }), // the kitchen mode follows the server on every load
  // ---- Signed-in devices, counter devices, PINs, step-up (pos-service docs/STAFF_PIN_DEVICES_API.md)
  /** Own devices; `all` (everyone) or `userId` (someone else) need devices.manage. X-Device-Id marks `current`. */
  devices: (q: { all?: boolean; userId?: string } = {}) => request<SignedInDevice[]>(`/auth/devices${qs({ all: q.all ? "true" : undefined, user_id: q.userId })}`, withDevice()),
  revokeDevice: (id: string) => request<void>(`/auth/devices/${id}`, { method: "DELETE" }),
  /** Every refresh token of the caller; `keepCurrent` keeps this browser (by X-Device-Id). */
  signOutEverywhere: (keepCurrent: boolean) => request<{ devices_signed_out: number }>("/auth/devices/sign-out-all", withDevice({ method: "POST", body: JSON.stringify({ keep_current: keepCurrent }) })),
  /** devices.manage: a staff member's lost phone. */
  signOutUser: (userId: string) => post<{ devices_signed_out: number }>(`/auth/users/${userId}/sign-out-all`),
  counterDevices: () => request<CounterDevice[]>("/devices/counter"),
  /** The answer's `device_token` is shown once: never stored by the app. */
  createCounterDevice: (b: { name: string; outlet_id?: string | null }) => post<CounterDeviceCreated>("/devices/counter", { name: b.name, ...(b.outlet_id ? { outlet_id: b.outlet_id } : {}) }),
  revokeCounterDevice: (id: string) => request<void>(`/devices/counter/${id}`, { method: "DELETE" }),
  myPin: () => request<PinStatus>("/auth/me/pin"),
  setMyPin: (pin: string, current_password: string) => request<void>("/auth/me/pin", { method: "PUT", body: JSON.stringify({ pin, current_password }) }),
  clearMyPin: () => request<void>("/auth/me/pin", { method: "DELETE" }),
  setUserPin: (userId: string, pin: string) => request<void>(`/auth/users/${userId}/pin`, { method: "PUT", body: JSON.stringify({ pin }) }),
  clearUserPin: (userId: string) => request<void>(`/auth/users/${userId}/pin`, { method: "DELETE" }),
  unlockUserPin: (userId: string) => post<void>(`/auth/users/${userId}/pin/unlock`),
  stepUp: requestStepUp,
  /** What the restaurant may use and what its owner switched on (pos-service feature access). */
  features: () => request<import("./types").FeatureAccess[]>("/restaurant/features"),
  /** Owner only: switch granted features on / off. 403 feature_not_entitled when super admin has not granted it; 409 at_least_one_order_type. */
  setFeatures: (features: Record<string, boolean>) => request<import("./types").FeatureAccess[]>("/restaurant/features", { method: "PUT", body: JSON.stringify({ features }) }),
  updateRestaurant: (b: { name: string; trn: string | null; address: string | null; phone?: string | null; z_report_next_number?: number; vat_registered?: boolean; prices_include_tax?: boolean; service_charge_percent?: string; max_cashier_discount_percent?: string; bill_amend_days?: number; kitchen_target_minutes?: number; kitchen_status_mode?: "kot_only" | "track"; kitchen_display_minutes?: number }) => request<Restaurant>("/restaurant", { method: "PUT", body: JSON.stringify(b) }),
  /** India GST engine switch (pos-service phase2/gst, owner only). 404/405/501 on servers without it. */
  gstSettings: () => request<{ tax_mode: "off" | "gst_engine"; config?: Record<string, unknown> | null; admin_warning?: string | null }>("/restaurant/gst"),
  saveGstSettings: (b: { tax_mode: "off" | "gst_engine"; config?: Record<string, unknown> }) => request<{ tax_mode: "off" | "gst_engine"; config?: Record<string, unknown> | null; admin_warning?: string | null }>("/restaurant/gst", { method: "PUT", body: JSON.stringify(b) }),
  staff: () => request<StaffMember[]>("/auth/users"),
  createStaff: (b: StaffInput) => post<StaffCreated>("/auth/users", b),
  updateStaff: (id: string, b: { full_name?: string; role?: Role; email?: string | null; phone?: string | null; username?: string | null }) => request<Me>(`/auth/users/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  /** Owner: a new one-time password for a staff member (shown once; their sessions end). */
  temporaryPassword: (id: string) => post<{ temporary_password: string; restaurant_code: string; login_identifier: string }>(`/auth/users/${id}/temporary-password`),
  /** Owner: (re)send the 'choose your password' email; the link is returned once too. */
  inviteStaff: (id: string) => post<{ sent: boolean; url: string; expires_at: string }>(`/auth/users/${id}/invite`),
  userOutlets: (id: string) => request<UserOutletAccess>(`/users/${id}/outlets`),
  setUserOutlets: (id: string, outlet_ids: string[]) => request<UserOutletAccess>(`/users/${id}/outlets`, { method: "PUT", body: JSON.stringify({ outlet_ids }) }),
  setStaffActive: (id: string, active: boolean) => post<Me>(`/auth/users/${id}/${active ? "reactivate" : "deactivate"}`),
  resetUserPassword: (id: string, new_password: string) => post<void>(`/auth/users/${id}/reset-password`, { new_password }),
  changePassword: (current_password: string, new_password: string) => post<void>("/auth/change-password", { current_password, new_password }),
  /** Always answers 200 (no account enumeration). 404/405/501 = the server has no email reset (phase2/comms not deployed). */
  forgotPassword: (email: string, restaurant_id?: string, locale?: string) => post<void>("/auth/forgot-password", { email, ...(restaurant_id ? { restaurant_id } : {}), ...(locale ? { locale } : {}) }),
  resetPassword: (b: { restaurant_id: string; token: string; new_password: string; locale?: string }) => post<void>("/auth/reset-password", b),
  // ---- Custom roles (pos-service phase2/roles, docs/ROLES_API.md). Callers still tolerate 404/405/501 (older servers).
  roles: () => request<RoleDef[]>("/roles"),
  permissionCatalogue: () => request<PermissionCatalogue>("/permissions"),
  cloneRole: (id: string, names: string[]) => post<RoleDef[]>(`/roles/${id}/clone`, { names }),
  userOutletAccess: (userId: string) => request<UserOutletAccess>(`/users/${userId}/outlets`),
  setUserOutletAccess: (userId: string, outlet_ids: string[]) => request<UserOutletAccess>(`/users/${userId}/outlets`, { method: "PUT", body: JSON.stringify({ outlet_ids }) }),
  createRole: (b: RoleInput) => post<RoleDef>("/roles", b),
  getRole: (id: string) => request<RoleDef>(`/roles/${id}`),
  updateRole: (id: string, b: Partial<RoleInput>) => request<RoleDef>(`/roles/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  deleteRole: (id: string) => request<void>(`/roles/${id}`, { method: "DELETE" }),
  /** `custom_role_id: null` goes back to the user's system role. */
  /** Exactly one of `role` (built-in) or `role_id` (any id from GET /roles). */
  setUserRole: (userId: string, b: { role: Role } | { role_id: string }) => request<unknown>(`/users/${userId}/role`, { method: "PUT", body: JSON.stringify(b) }),
  // ---- Outlets (pos-service docs/OUTLETS.md): list for any signed-in user, writes for owner / manager.
  outlets: () => request<Outlet[]>("/outlets"),
  createOutlet: (b: OutletInput) => post<Outlet>("/outlets", b),
  updateOutlet: (id: string, b: OutletPatch) => request<Outlet>(`/outlets/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  allCategories: () => request<Category[]>("/menu/categories?include_inactive=true"),
  patchCategory: (id: string, b: { name?: string; sort_order?: number; is_active?: boolean }) => request<Category>(`/menu/categories/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  reorderCategories: (ids: string[]) => request<Category[]>("/menu/categories/order", { method: "PUT", body: JSON.stringify({ ids }) }),
  allItems: () => request<MenuItem[]>("/menu/items?include_inactive=true"),
  setItemActive: (id: string, is_active: boolean) => request<MenuItem>(`/menu/items/${id}/active`, { method: "PATCH", body: JSON.stringify({ is_active }) }),
  /** A bill photographed page by page: all pages become ONE purchase (the server stores them as one PDF). */
  async uploadPurchasePages(pages: { blob: Blob; name: string }[], supplierId?: string): Promise<Purchase> {
    const fd = new FormData();
    pages.forEach((p, i) => fd.append("pages", p.blob, p.name || `page-${i + 1}.jpg`));
    if (supplierId) fd.append("supplier_id", supplierId);
    const res = await authedFetch("/purchases/pages", { method: "POST", body: fd }, 120000);
    if (!res.ok) throw await errorFrom(res, "Upload failed");
    return res.json();
  },
  async uploadItemImage(id: string, file: Blob, filename = "photo.jpg"): Promise<MenuItem> {
    const fd = new FormData();
    fd.append("file", file, filename);
    const res = await authedFetch(`/menu/items/${id}/image`, { method: "POST", body: fd }, 60000);
    if (!res.ok) throw await errorFrom(res, "Upload failed");
    return res.json();
  },
  deleteItemImage: (id: string) => request<void>(`/menu/items/${id}/image`, { method: "DELETE" }),
  allTables: () => request<DiningTable[]>("/tables?include_inactive=true"),
  patchTable: (id: string, b: { label?: string; seats?: number; area?: OrderType; is_active?: boolean }) => request<DiningTable>(`/tables/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  allSuppliers: () => request<Supplier[]>("/suppliers?include_inactive=true"),
  addSupplier: (b: { name: string; trn?: string | null; phone?: string | null; email?: string | null; contact_name?: string | null; auto_reorder?: boolean }) => post<Supplier>("/suppliers", b),
  patchSupplier: (id: string, b: { name?: string; trn?: string | null; phone?: string | null; email?: string | null; contact_name?: string | null; auto_reorder?: boolean; is_active?: boolean }) => request<Supplier>(`/suppliers/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  // ---- supplier re-order emails
  emailSettings: () => request<EmailSettings>("/email/settings"),
  saveEmailSettings: (b: { auto_reorder_emails?: boolean; reorder_email_window_hours?: number }) => request<EmailSettings>("/email/settings", { method: "PUT", body: JSON.stringify(b) }),
  previewReorder: (supplierId: string, b: ReorderEmailBody) => post<ReorderPreview>(`/suppliers/${supplierId}/emails/preview`, b),
  sendReorder: (supplierId: string, b: ReorderEmailBody) => post<SupplierEmail>(`/suppliers/${supplierId}/emails`, b),
  supplierEmails: (supplierId?: string, limit = 50) => request<SupplierEmail[]>(`/supplier-emails?limit=${limit}${supplierId ? `&supplier_id=${supplierId}` : ""}`),
  resendSupplierEmail: (id: string) => post<SupplierEmail>(`/supplier-emails/${id}/resend`),
  /** Suggests (never saves) recipes for up to 10 dishes from the restaurant's own stock list. */
  aiRecipeDrafts: (menuItemIds: string[]) => post<{ drafts: RecipeDraft[]; stock_items: number }>("/recipes/ai-draft", { menu_item_ids: menuItemIds }),
  allInventoryItems: () => request<InventoryItem[]>("/inventory/items?include_inactive=true"),
  patchInventoryItem: (id: string, b: { name?: string; base_unit?: string; reorder_level?: string; is_active?: boolean; supplier_id?: string | null; reorder_quantity?: string | null; reorder_unit?: string }) => request<InventoryItem>(`/inventory/items/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  recipeHistory: (menuItemId: string) => request<RecipeVersion[]>(`/recipes/${menuItemId}/history`),
  // ---- Restaurant printing (never cached offline: a print job only makes sense while the server can queue it)
  printers: () => request<PrinterConfig[]>("/print/printers"),
  availablePrinters: () => request<{ id: string; name: string; role: string; auto_bill: boolean; auto_kot: boolean }[]>("/print/printers/available"),
  createPrinter: (b: PrinterInput) => post<PrinterConfig>("/print/printers", b),
  updatePrinter: (id: string, b: Partial<PrinterInput>) => request<PrinterConfig>(`/print/printers/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  deletePrinter: (id: string) => request<void>(`/print/printers/${id}`, { method: "DELETE" }),
  /** One diagnostic page; `codepage` overrides the printer's own for this page only. */
  testPrinter: (id: string, codepage?: PrinterCodepage) => post<{ jobs: PrintJob[] }>(`/print/printers/${id}/test`, codepage ? { codepage } : undefined),
  printHubs: () => request<PrintHub[]>("/print/hubs"),
  newHubPairing: () => post<HubPairing>("/print/hubs/pairing"),
  revokeHub: (id: string) => request<void>(`/print/hubs/${id}`, { method: "DELETE" }),
  printJobs: (q: { ref_id?: string; limit?: number } = {}) => request<PrintJob[]>(`/print/jobs${qs({ ref_id: q.ref_id, limit: q.limit?.toString() })}`),
  /** Prints a finalized bill on a thermal printer (default: the counter printer). */
  printBill: (billId: string, printerId?: string) => post<{ jobs: PrintJob[] }>(`/bills/${billId}/print`, printerId ? { printer_id: printerId } : undefined),
  printKot: (kotId: string, printerId?: string) => post<{ jobs: PrintJob[] }>(`/kot/${kotId}/print`, printerId ? { printer_id: printerId } : undefined),
  async receiptBlobUrl(billId: string): Promise<string> {
    const res = await authedFetch(`/bills/${billId}/receipt.pdf`);
    if (!res.ok) throw await errorFrom(res, "Could not load receipt");
    return URL.createObjectURL(await res.blob());
  },
  /** The 80 mm thermal receipt as a Blob (for print / download / OS share sheet). */
  async receiptBlob(billId: string): Promise<Blob> {
    const res = await authedFetch(`/bills/${billId}/receipt.pdf`);
    if (!res.ok) throw await errorFrom(res, "Could not load receipt");
    return res.blob();
  },
  /** Expiring public link to the receipt PDF (WhatsApp-ready). */
  shareLink: (billId: string) => post<ShareLink>(`/bills/${billId}/share-link`),
  // ---- End of day (owner / manager)
  xReport: () => request<ZReportData>("/reports/x-report"),
  closeDay: (idempotency_key: string) => post<ZReportData>("/reports/z-report", { idempotency_key }),
  zReports: (cursor?: string | null, limit = 30) => request<ZReportPage>(`/reports/z-reports?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  zReport: (id: string) => request<ZReportData>(`/reports/z-reports/${id}`),
  // Insight reports for the Reports page (owner / manager); never cached offline. `from` / `to` are restaurant-local dates.
  leakage: (from: string, to: string) => insight<LeakageReport>("leakage", from, to),
  staffSales: (from: string, to: string) => insight<StaffSalesReport>("staff-sales", from, to),
  foodCost: (from: string, to: string) => insight<FoodCostReport>("food-cost", from, to),
  profitAndLoss: (from: string, to: string) => insight<ProfitLossReport>("profit-and-loss", from, to),
  customerInsights: (from: string, to: string) => insight<CustomerInsights>("customers", from, to),
  /** An A4 report PDF as a Blob (needs the Bearer header, so never a plain link). */
  async reportPdfBlob(kind: ReportPdfKind, from: string, to: string): Promise<Blob> {
    const res = await authedFetch(`/reports/pdf?kind=${kind}&from=${from}&to=${to}`, {}, 60_000);
    if (!res.ok) throw await errorFrom(res, "Could not create the PDF");
    return res.blob();
  },
  /** A PDF the assistant prepared: `att.url` is `/api/v1/reports/pdf?...`; only report PDF paths are fetched. */
  async attachmentBlob(att: Pick<ChatAttachment, "url">): Promise<Blob> {
    const path = att.url.replace(/^\/api\/v1(?=\/)/, "");
    if (!path.startsWith("/reports/pdf?")) throw new ApiError(0, "Unsupported attachment");
    const res = await authedFetch(path, {}, 60_000);
    if (!res.ok) throw await errorFrom(res, "Could not create the PDF");
    return res.blob();
  },
  salesByCategory: (from: string, to: string) => request<CategorySales>(`/reports/sales-by-category?from_date=${from}&to_date=${to}`),
  async xSlipBlob(): Promise<Blob> {
    const res = await authedFetch("/reports/x-report/slip.pdf");
    if (!res.ok) throw await errorFrom(res, "Could not load the X report slip");
    return res.blob();
  },
  async zSlipBlob(id: string): Promise<Blob> {
    const res = await authedFetch(`/reports/z-reports/${id}/slip.pdf`);
    if (!res.ok) throw await errorFrom(res, "Could not load the Z report slip");
    return res.blob();
  },
  async kotSlipBlob(kotId: string): Promise<Blob> {
    const res = await authedFetch(`/kot/${kotId}/slip.pdf`);
    if (!res.ok) throw await errorFrom(res, "Could not load the KOT slip");
    return res.blob();
  },
  async kotSlipBlobUrl(kotId: string): Promise<string> { return URL.createObjectURL(await this.kotSlipBlob(kotId)); },
};

// ---- Sign-up email code (pos-service docs/EMAIL.md, SIGNUP_EMAIL_VERIFICATION=true) ----

/** 202 from POST /auth/register-restaurant: nothing is created until POST /auth/verify-email gets the emailed code. */
export interface SignupPending { status: "verification_required"; email: string; detail?: string; expires_in_seconds?: number; resend_after_seconds?: number }
export const isSignupPending = (r: SessionGrant | SignupPending): r is SignupPending =>
  (r as SignupPending).status === "verification_required" && !("access_token" in r);

/** Anonymous POST (no Authorization: a stale session from another restaurant must not ride along); a 429 carries `retryAfter` seconds. */
async function anonPost<T>(path: string, body: unknown): Promise<T> {
  const res = await send(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, TIMEOUT_MS);
  if (!res.ok) {
    const e = await errorFrom(res);
    const ra = Number(res.headers.get("Retry-After"));
    throw Object.assign(e, { retryAfter: Number.isFinite(ra) && ra > 0 ? ra : undefined });
  }
  try { return (await res.json()) as T; } catch { throw new ApiError(0, "Cannot reach server"); }
}
