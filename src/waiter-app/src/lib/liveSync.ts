"use client";
/**
 * Server = source of truth for what is happening on the floor (WAITER_TABLE_SYNC_REPORT.md in the repo docs/testing).
 *
 * One shared poller for the open orders of the outlet (GET /orders?status=open and ?status=sent_to_kitchen) and the table
 * status (GET /tables/status: whose each order is, reservations). Before this, every screen polled on its own, on mount only,
 * kept running while the app was in the background and did nothing when the phone came back, so two devices of the same
 * waiter (PWA + app) showed different floors until a screen was re-opened.
 *
 * Refreshes: on start, every LIVE_POLL_MS (10 s) while the page is visible (paused while hidden), immediately when the page
 * becomes visible / gets focus / goes online / the native app resumes, after the outbox sent something, and on demand
 * (Refresh button, pull down). The last good answer is cached per outlet for offline use. Unsent local work (bill drafts,
 * queued operations) is never touched here: screens merge it on top (tableStatus.ts, orderEntries.ts).
 */
import { useSyncExternalStore } from "react";
import { api, auth, currentOutletId } from "./api";
import type { ActiveOrder } from "./tableStatus";
import type { ServerOrder } from "./types";
import { getProfile } from "./capsStore";
import { OUTLET_EVENT } from "./outletEvent";
import { defaultSessionGateway, forgetShift } from "./session";
import { engine } from "./sync";
import { counterState } from "./counter/state";
import { monoNow } from "./clock";

export const LIVE_POLL_MS = Number(process.env.NEXT_PUBLIC_LIVE_POLL_MS ?? 10_000);
/** Fired by NativeBootstrap when the Capacitor app comes back to the foreground. */
export const RESUME_EVENT = "waiter-resume";
const QUEUE_EVENT = "waiter-sync-changed";

/** A booked reservation holding a FREE table (GET /tables/status `status: "reserved"`). */
export interface TableReservation { guest_name: string; party_size: number; starts_at: string }
/** A bill made for a table and not paid yet (GET /tables/status `bill_printed`): the server refuses a new order on that table unless it is explicitly a separate one. */
export interface UnpaidBill { order_id: string; total: string | null; invoice_number: string | null; minutes_open: number | null }
export interface LiveState {
  outlet: string | null;
  /** Full open orders (open + sent_to_kitchen) of the outlet. */
  orders: ServerOrder[];
  /** Slim copy with the waiter of each order (table status). */
  active: ActiveOrder[];
  reservations: Record<string, TableReservation>;
  /** Tables with a bill waiting for payment at the counter (no open order is involved: a billed order is not in `orders`). */
  unpaid: Record<string, UnpaidBill>;
  /** ISO time of the last successful refresh. */
  at: string | null;
  /** false after a failed refresh: what is shown is the last known state. */
  live: boolean;
  err: string | null;
  refreshing: boolean;
}

const cacheKey = (outlet: string | null) => `waiter.tablestatus.${outlet ?? "default"}`;
const ordersKey = (outlet: string | null) => `waiter.liveorders.${outlet ?? "default"}`;
const slim = (o: ServerOrder): ActiveOrder => ({ id: o.id, client_uuid: o.client_uuid, table_id: o.table_id, status: o.status });

function fromCache(outlet: string | null): LiveState {
  let at: string | null = null, active: ActiveOrder[] = [], reservations: Record<string, TableReservation> = {}, orders: ServerOrder[] = [], unpaid: Record<string, UnpaidBill> = {};
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey(outlet)) ?? "null") as { at?: string; orders?: ActiveOrder[]; reservations?: Record<string, TableReservation>; unpaid?: Record<string, UnpaidBill> } | null;
    if (c) { at = c.at ?? null; active = c.orders ?? []; reservations = c.reservations ?? {}; unpaid = c.unpaid ?? {}; }
    orders = (JSON.parse(localStorage.getItem(ordersKey(outlet)) ?? "null") as ServerOrder[] | null) ?? [];
  } catch { /* no cache */ }
  return { outlet, orders, active, reservations, unpaid, at, live: true, err: null, refreshing: false };
}

const EMPTY: LiveState = { outlet: null, orders: [], active: [], reservations: {}, unpaid: {}, at: null, live: true, err: null, refreshing: false };
let state: LiveState = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();
function set(patch: Partial<LiveState>) { state = { ...state, ...patch }; listeners.forEach((f) => f()); }
function current(): LiveState {
  if (!loaded && typeof window !== "undefined") { loaded = true; state = fromCache(currentOutletId()); }
  return state;
}

/** Pure merge of the two server answers (exported for tests). */
export function buildLive(orders: ServerOrder[], rows: Awaited<ReturnType<typeof api.tableStatus>> | null): { active: ActiveOrder[]; reservations: Record<string, TableReservation>; unpaid: Record<string, UnpaidBill> } {
  const active = orders.map(slim);
  const reservations: Record<string, TableReservation> = {};
  const unpaid: Record<string, UnpaidBill> = {};
  if (rows) {
    for (const r of rows) {
      const b = r.orders.find((o) => !!o.bill_id);
      if (b) unpaid[r.table_id] = { order_id: b.order_id, total: b.total ?? null, invoice_number: b.invoice_number ?? null, minutes_open: b.minutes_open ?? null };
    }
    for (const r of rows) if (r.status === "reserved" && r.reservation) reservations[r.table_id] = { guest_name: r.reservation.guest_name, party_size: r.reservation.party_size, starts_at: r.reservation.starts_at };
    const waiter = new Map(rows.flatMap((r) => r.orders.map((o) => [o.order_id, o.waiter_id] as const)));
    for (const o of active) o.waiter_id = waiter.get(o.id) ?? null;
  }
  return { active, reservations, unpaid };
}

let inflight: Promise<LiveState> | null = null;
/**
 * Fetches the open orders and table status now (single flight). Resolves with the new state; on failure the state keeps
 * the last known data with `live: false`. `throwOnError` makes a failure reject instead (the cart's send-time check).
 */
export function refreshLive(opts: { throwOnError?: boolean } = {}): Promise<LiveState> {
  current();
  const run = inflight ??= (async () => {
    const outlet = currentOutletId();
    set({ refreshing: true });
    // Stamp the moment BEFORE the first request: the snapshot is at least this new. Stamping the end let an order confirmed between the
    // snapshot and the end read as "gone from a list read after it was confirmed", so it vanished until the next poll (L3).
    const readAt = new Date().toISOString();
    try {
      const orders = (await Promise.all([api.orders("open"), api.orders("sent_to_kitchen")])).flat();
      // A business without tables (cloud / hotel kitchen) gets 409 from /tables/status: do not ask.
      const rows = getProfile().caps.tables ? await api.tableStatus().catch(() => null) : null;
      if (outlet !== currentOutletId()) return state; // the outlet changed meanwhile: this answer is for the old one
      const { active, reservations, unpaid } = buildLive(orders, rows);
      const at = readAt;
      try {
        localStorage.setItem(cacheKey(outlet), JSON.stringify({ at, orders: active, reservations, unpaid }));
        localStorage.setItem(ordersKey(outlet), JSON.stringify(orders));
      } catch { /* storage full / unavailable */ }
      set({ outlet, orders, active, reservations, unpaid, at, live: true, err: null, refreshing: false });
      return state;
    } catch (e) {
      set({ live: false, err: e instanceof Error ? e.message : "Cannot reach server", refreshing: false });
      throw e;
    } finally { inflight = null; }
  })();
  return opts.throwOnError ? run : run.catch(() => state);
}

// ------------------------------------------------------------------------------------------------ shift
let lastShiftCheck = -Infinity; // monotonic (lib/clock.ts): a wall clock set back must not freeze the throttle
/**
 * One server shift per waiter and outlet, shared by all their devices (open is idempotent). When it was closed on another
 * device (or by a manager), this device forgets its local marker and shows "Outlet and shift" again, instead of carrying on
 * in a shift the server has ended. Never acts while this device still has a shift step to send, nor on an error answer.
 */
export async function checkShift(force = false): Promise<void> {
  if (!force && monoNow() - lastShiftCheck < 60_000) return;
  lastShiftCheck = monoNow();
  if (counterState.active || !auth.token) return;
  const local = defaultSessionGateway.currentShift();
  if (!local || Date.now() - Date.parse(local.started_at) < 60_000) return;
  try {
    const ops = await engine.list();
    if (ops.some((o) => o.order_ref.startsWith("shift:") && o.status !== "synced")) return;
    const s = await api.currentShift();
    if (s === null && defaultSessionGateway.currentShift()?.id === local.id) forgetShift();
  } catch { /* offline: keep the local shift */ }
}

// ------------------------------------------------------------------------------------------------ scheduler
let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastKick = -Infinity; // monotonic, see lastShiftCheck
const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

function arm() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void tick(); }, LIVE_POLL_MS);
}
async function tick() {
  // Hidden (background tab, phone locked, app in the background): no traffic; the visibility event refreshes on return.
  if (visible() && auth.token && listeners.size) { lastKick = monoNow(); await refreshLive(); void checkShift(); }
  arm();
}
/** Refresh soon, at most once per `minGap` ms (events can come in bursts). */
function kick(minGap = 1500) {
  if (!auth.token || !visible()) return;
  if (monoNow() - lastKick < minGap) return;
  lastKick = monoNow();
  void refreshLive().finally(arm);
  void checkShift();
}
let queueTimer: ReturnType<typeof setTimeout> | null = null;

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  document.addEventListener("visibilitychange", () => { if (visible()) kick(0); });
  window.addEventListener("focus", () => kick());
  window.addEventListener("online", () => kick(0));
  window.addEventListener(RESUME_EVENT, () => kick(0));
  window.addEventListener(OUTLET_EVENT, () => {
    const o = currentOutletId();
    if (o === state.outlet) return;
    state = fromCache(o); listeners.forEach((f) => f());
    kick(0);
  });
  // The outbox sent something (or a new op was queued): the server list changes, look again shortly after.
  window.addEventListener(QUEUE_EVENT, () => {
    if (queueTimer) clearTimeout(queueTimer);
    queueTimer = setTimeout(() => kick(3000), 700);
  });
  kick(0);
  arm();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  start();
  return () => { listeners.delete(cb); };
}
export function useLive(): LiveState {
  return useSyncExternalStore(subscribe, current, () => EMPTY);
}
/** For code outside React (tests, the cart's offline fallback). */
export const liveState = (): LiveState => current();

/** "Updated just now" text for the live stamp (pure, exported for tests). */
export function updatedText(at: string | null, live: boolean, now = Date.now()): string {
  if (!at) return live ? "Updating..." : "Offline: not updated yet";
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  const when = s < 15 ? "just now" : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `at ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return live ? `Updated ${when}` : `Offline · last updated ${when}`;
}
