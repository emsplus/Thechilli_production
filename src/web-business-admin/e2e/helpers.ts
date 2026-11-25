import { expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { AT_COOKIE, BFF_PATH, HINT_COOKIE, RT_COOKIE, SESSION_MAX_AGE, encodeHint, jwtClaims } from "../src/lib/session-cookie";

export const API = process.env.E2E_API_BASE ?? `http://localhost:${process.env.E2E_API_PORT ?? "8120"}/api/v1`;
export const WEB = `http://localhost:${process.env.E2E_WEB_PORT ?? "3120"}`;

/** Refresh token of every pair the seed helpers registered, by access token (so `openPos(page, s.token)` can sign in fully). */
const refreshOf = new Map<string, string>();
export const rememberPair = (access: string, refresh: string) => { refreshOf.set(access, refresh); };

/**
 * Signs a browser context in exactly as the BFF does after a login: the httpOnly refresh and access cookies (path
 * /bff/auth) plus the readable `pos_session` marker. The page fetches its in-memory access token from the BFF on load.
 * Replaces the old localStorage injection; calling it again (another account) switches the session like a new sign-in.
 */
export async function signIn(target: Page | BrowserContext, access: string, refresh?: string) {
  const ctx = "context" in target ? target.context() : target;
  const c = jwtClaims(access);
  const rt = refresh || refreshOf.get(access);
  const expires = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  const base = { domain: "localhost", secure: false, sameSite: "Strict" as const, expires };
  await ctx.addCookies([
    ...(rt ? [{ ...base, name: RT_COOKIE, value: rt, path: BFF_PATH, httpOnly: true }] : []),
    { ...base, name: AT_COOKIE, value: access, path: BFF_PATH, httpOnly: true, expires: c?.exp ?? expires },
    { ...base, name: HINT_COOKIE, value: encodeHint({ sid: randomBytes(8).toString("hex"), rid: c?.rid ?? null, sub: c?.sub ?? null }), path: "/", httpOnly: false },
  ]);
}

/** The access token the BFF holds for this browser context (httpOnly pos_at cookie): the API calls a signed-in page makes. */
export async function sessionAccessToken(target: Page | BrowserContext): Promise<string | undefined> {
  const ctx = "context" in target ? target.context() : target;
  return (await ctx.cookies()).find((c) => c.name === AT_COOKIE)?.value;
}

export interface Seed { token: string; refresh: string; email: string; auth: Record<string, string>; itemId: string; catId: string; tableId: string }

export async function seed(request: APIRequestContext, price = "12.50"): Promise<Seed> {
  const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.in`;
  const reg = await request.post(`${API}/auth/register-restaurant`, { data: {
    restaurant_name: "E2E Cafe", country: "IN", owner_email: email, owner_name: "O", owner_password: "supersecret123" } });
  const pair = await reg.json();
  const token = pair.access_token as string;
  const auth = { Authorization: `Bearer ${token}` };
  // GST 5% added on top of the menu prices (the older specs' arithmetic: 2 x 12.50 + 5% = 26.25)
  const put = await request.put(`${API}/restaurant`, { headers: auth, data: { name: "E2E Cafe", trn: null, address: null, prices_include_tax: false } });
  expect(put.status(), await put.text()).toBe(200);
  const cat = await (await request.post(`${API}/menu/categories`, { headers: auth, data: { name: "Drinks" } })).json();
  const item = await (await request.post(`${API}/menu/items`, { headers: auth, data: { category_id: cat.id, name: "Latte", price } })).json();
  const table = await (await request.post(`${API}/tables`, { headers: auth, data: { label: "T1" } })).json();
  rememberPair(token, pair.refresh_token);
  return { token, refresh: pair.refresh_token as string, email, auth, itemId: item.id, catId: cat.id, tableId: table.id };
}

/** An Indian restaurant (country IN: INR, GSTIN, GST wording) with one dish "Paneer Tikka" ₹250, category "Mains" and table T1. Prefer this in new specs. */
export async function seedIn(request: APIRequestContext, price = "250.00"): Promise<Seed> {
  const email = `in-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.in`;
  const reg = await request.post(`${API}/auth/register-restaurant`, { data: {
    restaurant_name: "Chilli Test Dhaba", country: "IN", trn: "27AAPFU0939F1ZV", owner_email: email, owner_name: "Owner", owner_password: "supersecret123" } });
  expect(reg.status(), await reg.text()).toBe(201);
  const pair = await reg.json();
  const token = pair.access_token as string;
  const auth = { Authorization: `Bearer ${token}` };
  const cat = await (await request.post(`${API}/menu/categories`, { headers: auth, data: { name: "Mains" } })).json();
  const item = await (await request.post(`${API}/menu/items`, { headers: auth, data: { category_id: cat.id, name: "Paneer Tikka", price } })).json();
  const table = await (await request.post(`${API}/tables`, { headers: auth, data: { label: "T1" } })).json();
  rememberPair(token, pair.refresh_token);
  return { token, refresh: pair.refresh_token as string, email, auth, itemId: item.id, catId: cat.id, tableId: table.id };
}

/**
 * Kitchen status tracking of a seeded restaurant (pos-service docs/KOT_ONLY_KITCHEN.md). A new restaurant is KOT-only (the default);
 * specs of the Preparing / Ready / Served workflow switch it to "track" first.
 */
export async function setKitchenMode(request: APIRequestContext, auth: Record<string, string>, mode: "kot_only" | "track") {
  const rest = await (await request.get(`${API}/restaurant`, { headers: auth })).json();
  const put = await request.put(`${API}/restaurant`, { headers: auth, data: { name: rest.name, trn: rest.trn, address: rest.address, kitchen_status_mode: mode } });
  expect(put.status(), await put.text()).toBe(200);
}

export async function openPos(page: Page, token: string) {
  await signIn(page, token);
  await page.goto("/pos");
  await expect(page.getByRole("button", { name: /Latte/ }).first()).toBeVisible();
  // Wait until the service worker has installed and cached the shell.
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
}

/** A dine-in order must reach the kitchen before it can be billed (pos-service ORDER_RULES rule 1): the counter's Make bill does this itself. */
export async function sendToKitchen(request: APIRequestContext, auth: Record<string, string>, orderId: string) {
  const r = await request.post(`${API}/orders/${orderId}/kot`, { headers: auth });
  expect(r.status(), await r.text()).toBe(201);
}

export async function bills(request: APIRequestContext, s: Seed) {
  return (await (await request.get(`${API}/bills`, { headers: s.auth })).json()) as { invoice_number: string; total: string; balance_due: string; payments: unknown[] }[];
}

export interface MenuSeedItem { id: string; price: string }
export interface MenuSeed extends Seed { items: Record<string, MenuSeedItem> }

/**
 * An Indian restaurant (country IN: INR, GSTIN, prices include GST at 5%, the India default) with a curry, a salad, a drink
 * and a naan, one table "T1" and a 12.5% service charge. Prices include GST, so a bill total is the sum of the menu prices
 * (plus the service charge on eat-in).
 */
export async function seedMenu(request: APIRequestContext, opts: { serviceCharge?: string | null; businessTypes?: string[] } = {}): Promise<MenuSeed> {
  const email = `menu-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.in`;
  const reg = await request.post(`${API}/auth/register-restaurant`, { data: {
    restaurant_name: "Karahi Test", country: "IN", trn: "27AAPFU0939F1ZV", owner_email: email, owner_name: "O", owner_password: "supersecret123", ...(opts.businessTypes ? { business_types: opts.businessTypes } : {}) } });
  expect(reg.status()).toBe(201);
  const pair = await reg.json();
  const auth = { Authorization: `Bearer ${pair.access_token as string}` };
  const cat = await (await request.post(`${API}/menu/categories`, { headers: auth, data: { name: "Mains" } })).json();
  const items: Record<string, MenuSeedItem> = {};
  for (const [name, price] of [["Lamb Karahi", "8.50"], ["Cucumber Salad", "4.50"], ["Coke", "3.20"], ["Garlic Naan", "3.00"]] as const) {
    const r = await request.post(`${API}/menu/items`, { headers: auth, data: { category_id: cat.id, name, price } });
    expect(r.status()).toBe(201);
    items[name] = { id: (await r.json()).id, price };
  }
  const table = await (await request.post(`${API}/tables`, { headers: auth, data: { label: "T1" } })).json();
  const sc = opts.serviceCharge === undefined ? "12.5" : opts.serviceCharge;
  const put = await request.put(`${API}/restaurant`, { headers: auth, data: { name: "Karahi Test", trn: "27AAPFU0939F1ZV", address: null, prices_include_tax: true, ...(sc !== null ? { service_charge_percent: sc } : {}) } });
  expect(put.status()).toBe(200);
  rememberPair(pair.access_token, pair.refresh_token);
  return { token: pair.access_token, refresh: pair.refresh_token, email, auth, itemId: items["Lamb Karahi"].id, catId: cat.id, tableId: table.id, items };
}

/** Signs a session in (session cookies set before the first load) and opens a page. */
export async function openAs(page: Page, token: string, path: string, refresh = "") {
  await signIn(page, token, refresh);
  await page.goto(path);
}

/** Opens a screen that lives under Manage (Reports, Customers, Cash drawer, End of day, Reservations, ...) the way a user does on desktop: sidebar "Manage", then the entry in Manage's own navigation. */
export async function viaManage(page: Page, entry: string) {
  await page.getByRole("complementary", { name: "Primary" }).getByRole("link", { name: "Manage", exact: true }).click();
  await page.getByRole("navigation", { name: "Manage sections" }).getByRole("link", { name: entry, exact: true }).click();
}

/** Opens the POS of a seedMenu() restaurant; `sw` waits for the service worker (production build) so offline tests can start. */
export async function openMenuPos(page: Page, s: Seed, opts: { sw?: boolean } = {}) {
  await openAs(page, s.token, "/pos", s.refresh);
  await expect(page.getByRole("button", { name: /^Lamb Karahi,/ })).toBeVisible();
  if (opts.sw) await page.evaluate(async () => { await navigator.serviceWorker.ready; });
}

export async function billsFull(request: APIRequestContext, s: Seed) {
  return (await (await request.get(`${API}/bills`, { headers: s.auth })).json()) as {
    id: string; order_id: string; invoice_number: string; total: string; subtotal: string; tax_amount: string; discount_amount: string; discount_reason: string | null;
    service_charge_amount: string; service_charge_percent: string; balance_due: string; currency: string; prices_include_tax: boolean;
    tax_breakdown: { code: string; rate_percent: string; net: string; vat: string; gross: string }[] | null; payments: unknown[];
  }[];
}

/** A controllable SpeechRecognition: window.__say(interim|final, text) emits a result list to the newest instance. `needGesture` = iOS-like (start() fails without a recent tap). */
export const fakeSpeech = (page: Page, opts: { needGesture?: boolean; handsFreeDefault?: boolean } = {}) => page.addInitScript(([needGesture, handsFreeDefault]) => {
  const w = window as unknown as Record<string, unknown>;
  // Hands-free is always ON in the app (no switch); the specs keep it OFF through a test hook unless they test it.
  try { if (handsFreeDefault) localStorage.removeItem("pos.wakeOff"); else localStorage.setItem("pos.wakeOff", "1"); } catch { /* ignore */ }
  try { localStorage.setItem("pos.micDebug", "0"); localStorage.setItem("pos.voiceDirect", "0"); } catch { /* the testing-phase mic debug box and Direct mode stay off in these specs */ }
  const made: FakeSR[] = [];
  let lastTap = -1e9; // Safari only starts recognition inside a tap: remember the last one
  for (const ev of ["pointerdown", "click", "keydown"]) document.addEventListener(ev, () => { lastTap = performance.now(); }, true);
  class FakeSR {
    lang = ""; continuous = false; interimResults = false; maxAlternatives = 1;
    onresult: ((e: unknown) => void) | null = null; onend: (() => void) | null = null; onerror: ((e: unknown) => void) | null = null;
    finals: string[] = []; interim = ""; started = false;
    constructor() { made.push(this); }
    start() {
      // iOS-like: no recognition without a fresh tap / click
      if (needGesture && performance.now() - lastTap > 300) { setTimeout(() => { this.onerror?.({ error: "not-allowed" }); this.onend?.(); }, 0); return; }
      this.started = true;
      setTimeout(() => { if (this.started && !w.__srNoStart) { this.onstart?.(); this.onaudiostart?.(); } }, 0); // like Chrome: the session reports that it started
    }
    onstart: (() => void) | null = null; onaudiostart: (() => void) | null = null;
    stop() { this.started = false; setTimeout(() => this.onend?.(), 0); }
    abort() { this.started = false; this.aborted = true; }
    aborted = false;
    emit() {
      const results: unknown[] = this.finals.map((t) => Object.assign([{ transcript: t }], { isFinal: true }));
      if (this.interim) results.push(Object.assign([{ transcript: this.interim }], { isFinal: false }));
      this.onresult?.({ resultIndex: 0, results: Object.assign(results, { length: results.length }) });
    }
  }
  w.SpeechRecognition = FakeSR; w.webkitSpeechRecognition = FakeSR;
  w.__sr = made;
  w.__say = (kind: "interim" | "final", text: string) => {
    const r = made[made.length - 1];
    if (kind === "final") { r.finals.push(text); r.interim = ""; } else r.interim = text;
    r.emit();
  };
  w.__pause = () => { const r = made[made.length - 1]; r.started = false; r.onend?.(); }; // Chrome ends a session after a pause
  w.__live = () => made.filter((r) => r.started).length; // recognisers currently listening
  w.__fail = (code: string) => { const r = made[made.length - 1]; r.started = false; r.onerror?.({ error: code }); r.onend?.(); };
  // the failure the owner saw: the recogniser dies without onend / onerror (sleep, lid, device switch); the watchdog must notice
  w.__kill = () => { const r = made[made.length - 1]; r.started = false; };
  w.__srNoStart = false; // when true, new recognisers never report onstart (a start that silently does nothing)
}, [!!opts.needGesture, !!opts.handsFreeDefault] as const);
export const say = (page: Page, kind: "interim" | "final", text: string) => page.evaluate(([k, t]) => (window as unknown as { __say: (a: string, b: string) => void }).__say(k, t), [kind, text]);


/** Pays the open bill in cash with ONE tap (the original counter flow: "Cash" pays exactly the balance due). */
export async function payCash(page: Page) {
  await page.getByRole("button", { name: "Pay cash" }).click();
}

/** Opens the pay sheet (tendered cash, change, split) behind the small "Other amount / split" control, preselected on cash. */
export async function openPaySheet(page: Page) {
  await page.getByRole("button", { name: "Other amount / split" }).click();
  await expect(page.getByRole("dialog", { name: "Take payment" })).toBeVisible();
}
