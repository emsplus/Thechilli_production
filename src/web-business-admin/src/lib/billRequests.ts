"use client";

import { useEffect, useSyncExternalStore } from "react";
import { api, ApiError, auth } from "./api";
import type { BillRequest } from "./types";

/**
 * The waiter's "Request bill" (waiter app: POST /orders/{id}/request-bill or the offline `request_bill` sync op) reaches the
 * cashier here. GET /bill-requests (bills.finalize: owner, manager, cashier; the request's outlet; tenant by RLS) is the queue:
 * an entry leaves it by itself once the bill is made or the order is cancelled. Read / unread is per signed-in user and per
 * device (localStorage), keyed by order AND request time so a second request for the same order is new again.
 * One poll for the whole app (bell, Orders, counter): every POLL_MS while the tab is visible, never while it is hidden.
 * Two kinds share the queue: "bill_request" (an open order, no sound: the badge, the list and a toast) and "payment_reminder"
 * (the order is BILLED and unpaid and the waiter pressed "Remind the counter": same badge / list / toast PLUS a chime unless the
 * device turned the bell sound off; "Take payment" opens the pay sheet, paying clears it on the server and here).
 */
export const BILL_POLL_MS = 10_000;

export const requestKey = (r: Pick<BillRequest, "order_id" | "requested_at">) => `${r.order_id}@${r.requested_at}`;
export const unreadOf = (list: BillRequest[], seen: ReadonlySet<string>) => list.filter((r) => !seen.has(requestKey(r)));
/** Requests that were not in the previous answer (for the "new bill request" toast); none on the first load. */
export const arrivedSince = (prev: BillRequest[] | null, next: BillRequest[]) => {
  if (prev === null) return [];
  const had = new Set(prev.map(requestKey));
  return next.filter((r) => !had.has(requestKey(r)));
};
/** Read marks of requests no longer in the queue are dropped, so storage never grows. */
export const pruneSeen = (seen: ReadonlySet<string>, list: BillRequest[]) => new Set(list.map(requestKey).filter((k) => seen.has(k)));
/** "Table T4" / "Token 12" / "Order": what the cashier recognises the request by. */
export const requestLabel = (r: Pick<BillRequest, "table_label" | "token_number">) =>
  r.table_label ? `Table ${r.table_label}` : r.token_number ? `Token ${r.token_number}` : "Order";

export const isReminder = (r: Pick<BillRequest, "kind">) => r.kind === "payment_reminder";
/** The plain-words line of a reminder: "Table T2 is waiting to pay: bill INV/2026-27/000123, ₹760.00 (asked by Ramesh)". */
export const reminderText = (r: BillRequest, money: (v: string) => string) =>
  `${requestLabel(r)} is waiting to pay: bill ${r.invoice_number ?? "not numbered"}, ${money(r.balance_due ?? "0")}` + (r.requested_by_name ?? r.waiter_name ? ` (asked by ${r.requested_by_name ?? r.waiter_name})` : "");
/** The queue split in two: waiters' bill requests (open orders) and payment reminders (billed, unpaid). */
export const splitQueue = (list: BillRequest[]) => ({ requests: list.filter((r) => !isReminder(r)), reminders: list.filter(isReminder) });

export interface BillRequestsState { list: BillRequest[] | null; seen: ReadonlySet<string>; enabled: boolean; error: boolean }
const listeners = new Set<() => void>();
let state: BillRequestsState = { list: null, seen: new Set(), enabled: false, error: false };
let arrivedHandler: ((r: BillRequest[]) => void) | null = null;
const seenKey = () => `chilli.billRequests.seen.${auth.userId ?? "anon"}`;
let seenFor: string | null = null;

function emit(next: Partial<BillRequestsState>) { state = { ...state, ...next }; listeners.forEach((l) => l()); }
function loadSeen(): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(seenKey()) ?? "[]") as string[]); } catch { return new Set(); } }
function saveSeen(s: ReadonlySet<string>) { try { localStorage.setItem(seenKey(), JSON.stringify([...s])); } catch { /* private mode: this tab only */ } }

/** One request; a 403 (no bills.finalize) switches the feature off for this session; offline keeps the last list. */
export async function refreshBillRequests(): Promise<void> {
  if (!auth.token) return;
  try {
    const list = await api.billRequests();
    if (seenFor !== seenKey()) { seenFor = seenKey(); state = { ...state, list: null }; } // another user signed in on this tab
    const prev = state.list;
    const seen = pruneSeen(state.list === null ? loadSeen() : state.seen, list);
    for (const r of list) if (pendingRead.has(r.order_id)) seen.add(requestKey(r)); // opened before the list had loaded
    pendingRead.clear();
    saveSeen(seen);
    emit({ list, seen, enabled: true, error: false });
    const arrived = arrivedSince(prev, list).filter((r) => !seen.has(requestKey(r)));
    if (arrived.length) arrivedHandler?.(arrived);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404 || e.status === 401)) emit({ enabled: false, list: [] });
    else emit({ error: true });
  }
}

/** Marks requests read (opened from the bell, the Orders card or the counter). Unknown ids are ignored. */
const pendingRead = new Set<string>();
export function markBillRequestsRead(orderIds: string[] | "all") {
  if (state.list === null && orderIds !== "all") orderIds.forEach((id) => pendingRead.add(id));
  const list = state.list ?? [];
  const add = list.filter((r) => orderIds === "all" || orderIds.includes(r.order_id)).map(requestKey);
  if (!add.length) return;
  const seen = new Set([...state.seen, ...add]);
  saveSeen(seen);
  emit({ seen });
}

let pollers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const onVisible = () => { if (!document.hidden) void refreshBillRequests(); };
function start() {
  if (pollers++ > 0) return;
  void refreshBillRequests();
  timer = setInterval(() => { if (!document.hidden) void refreshBillRequests(); }, BILL_POLL_MS);
  document.addEventListener("visibilitychange", onVisible);
}
function stop() {
  if (--pollers > 0) return;
  if (timer) clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onVisible);
}

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
const snapshot = () => state;
const SERVER: BillRequestsState = { list: null, seen: new Set(), enabled: false, error: false };

/**
 * The bill-request queue, kept fresh while any caller is mounted and `enabled` (the user can bill: bills.finalize).
 * `onArrived` (one per app, the bell) hears requests that appeared since the last poll.
 */
export function useBillRequests(enabled: boolean, onArrived?: (r: BillRequest[]) => void) {
  const s = useSyncExternalStore(subscribe, snapshot, () => SERVER);
  useEffect(() => {
    if (!enabled) return;
    start();
    return stop;
  }, [enabled]);
  useEffect(() => {
    if (!onArrived) return;
    arrivedHandler = onArrived;
    return () => { if (arrivedHandler === onArrived) arrivedHandler = null; };
  }, [onArrived]);
  const list = enabled && s.enabled ? s.list ?? [] : [];
  const { requests, reminders } = splitQueue(list);
  // byOrder: plain bill requests only (the Orders card "Bill asked"); a billed order's reminder is not "asked for the bill"
  return { list, requests, reminders, unread: unreadOf(list, s.seen), seen: s.seen, loaded: s.list !== null, byOrder: new Map(requests.map((r) => [r.order_id, r])) };
}

/** Test hook: forget everything (a new user signs in on this tab, or between unit tests). */
export function resetBillRequests() { state = { ...SERVER, seen: new Set() }; seenFor = null; pendingRead.clear(); listeners.forEach((l) => l()); }
