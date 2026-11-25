"use client";
import { useEffect, useSyncExternalStore } from "react";
import { api, auth, currentOutletId, deviceId } from "./api";
import { idbStore } from "./queue/idbStore";
import { QueueEngine } from "./queue/engine";
import type { QueuedOp } from "./queue/types";
import { getOnline, subscribeOnline } from "./native/network";
import { PENDING_KEY } from "./queue/integrity";
import { uuid } from "./uuid";
import { counterState } from "./counter/state";

const EVENT = "waiter-sync-changed";

export { deviceId };

let snapshot: QueuedOp[] = [];
const notify = () => { void refresh(); };
async function refresh() {
  try {
    snapshot = await engine.list();
    try { localStorage.setItem(PENDING_KEY, String(snapshot.filter((o) => o.status !== "synced").length)); } catch { /* ignore */ }
  } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(EVENT));
}

export const engine = new QueueEngine({
  store: idbStore,
  send: (ops, outlet) => api.syncOperations(ops, outlet),
  newId: uuid,
  deviceId,
  restaurantId: () => auth.restaurantId,
  userId: () => auth.userId,
  scopeByUser: () => counterState.active,
  outletId: currentOutletId,
  onChange: notify,
});

let timer: ReturnType<typeof setTimeout> | null = null;
/** Re-arm a single timer for the earliest backoff deadline. */
async function schedule() {
  if (timer) clearTimeout(timer);
  const due = await engine.nextDueIn();
  if (due === null) return;
  timer = setTimeout(() => { void tick(); }, Math.max(500, due));
}
async function tick(force = false) {
  if (!auth.token) return;
  // Known offline: do not "attempt" at all. An attempt that fails burns the never-sent guarantee that lets a waiter cancel or edit
  // an unsent order locally (an attempted op may already be on the server).
  if (!getOnline()) return;
  await engine.flush(force);
  await schedule();
}

let started = false;
export function startSync() {
  if (started || typeof window === "undefined") return;
  started = true;
  void engine.recover().then(() => tick());
  subscribeOnline((o) => { if (o) void tick(true); });
  // A fresh sign-in (after an expired session) releases whatever the queue kept.
  let hadToken = !!auth.token;
  auth.subscribe(() => { const has = !!auth.token; if (has && !hadToken) void tick(true); hadToken = has; });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void tick(); });
  window.addEventListener(EVENT, () => void schedule());
  new BroadcastChannel("waiter-sync").onmessage = () => void refresh();
}

/** Enqueue (durably) and kick the sender. The promise resolves once the ops are in IndexedDB, NOT once the server confirmed. */
export async function submit(items: Parameters<QueueEngine["enqueue"]>[0]) {
  const ops = await engine.enqueue(items);
  void tick();
  return ops;
}
export const retryNow = async (orderRef: string, acceptPrices = false, separateOrder = false) => { await engine.retry(orderRef, acceptPrices, separateOrder); await tick(true); };
export const syncNow = () => tick(true);

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
export function useQueue(): QueuedOp[] {
  useEffect(() => { startSync(); void refresh(); }, []);
  return useSyncExternalStore(subscribe, () => snapshot, () => []);
}
export function useOnline(): boolean {
  return useSyncExternalStore((cb) => subscribeOnline(cb), getOnline, () => true);
}
