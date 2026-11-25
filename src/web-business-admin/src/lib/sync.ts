import { api, ApiError, auth } from "./api";
import { deleteOp, listDrafts, listOps, putOp, unplacedDraftCount, wipeLocalData, type OpPayload, type QueuedOp } from "./offlineDb";
import { uuid } from "./uuid";
import { offlineRefs, prunableOps } from "./syncPrune";
import { isOpRejection } from "./syncBody";

const EVENT = "pos-sync-changed";
const CHANNEL = typeof window !== "undefined" && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("pos-sync") : null;
let counter = 0;
let flushing = false;
export let lastReachable = true;

export function deviceId(): string {
  try {
    let d = localStorage.getItem("pos.device");
    if (!d) { d = uuid(); localStorage.setItem("pos.device", d); }
    return d;
  } catch { return "unknown"; }
}

function notify() {
  window.dispatchEvent(new Event(EVENT));
  CHANNEL?.postMessage("changed");
}
if (CHANNEL) CHANNEL.onmessage = () => window.dispatchEvent(new Event(EVENT));

export function onSyncChange(cb: () => void) {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

export async function enqueue(ops: { op: OpPayload; order_ref: string; label: string }[]): Promise<QueuedOp[]> {
  const made: QueuedOp[] = ops.map((o) => ({
    op_id: uuid(), seq: Date.now() * 1000 + (counter++ % 1000), created_at: new Date().toISOString(),
    order_ref: o.order_ref, restaurant_id: auth.restaurantId ?? undefined, label: o.label, op: o.op, status: "pending", attempts: 0,
  }));
  const stored: QueuedOp[] = [];
  try { for (const m of made) { await putOp(m); stored.push(m); } }
  catch (e) { // storage full / blocked: all or nothing, so a sale is never half in the queue (e.g. a bill without its payment)
    for (const m of stored) await deleteOp(m.op_id).catch(() => {});
    throw e;
  }
  notify();
  void flush();
  return made;
}

/** Ops created before restaurant tagging existed have no restaurant_id and are treated as the current session's. */
export function belongsToSession(o: QueuedOp): boolean {
  return !o.restaurant_id || o.restaurant_id === auth.restaurantId;
}

/** Foreground sync. Safe to call anywhere/anytime: single-flight here, idempotent on the server. */
export async function flush(): Promise<void> {
  if (flushing || !auth.token) return;
  flushing = true;
  try {
    const run = async () => {
      const all = await listOps();
      // Never send another restaurant's sales under this session (e.g. a different account signed in on this device).
      const todo = all.filter((o) => (o.status === "pending" || o.status === "syncing") && belongsToSession(o)).slice(0, 100);
      if (!todo.length) {
        // Pending ops exist but the session's restaurant can't be read (malformed token): ask the server, so a dead
        // session surfaces as 401 -> refresh -> sign-in instead of the queue silently waiting forever.
        if (!auth.restaurantId && all.some((o) => o.status === "pending" || o.status === "syncing")) {
          await api.restaurant().catch(() => { /* api.ts handles 401 -> refresh -> /login */ });
        }
        lastReachable = true;
        return;
      }
      for (const o of todo) await putOp({ ...o, status: "syncing", attempts: o.attempts + 1 });
      notify();
      /** Stores what the server said about one op (shared by the whole-batch path and the one-by-one path). */
      const settle = async (o: QueuedOp, r: { status: "synced" | "conflict" | "failed"; detail: string | null; conflicts: { item: string; expected: string; current: string }[] | null; data: Record<string, unknown> | null } | undefined) => {
        if (!r) { await putOp({ ...o, status: "pending" }); return; }
        await putOp({ ...o, attempts: o.attempts + 1, status: r.status === "synced" ? "synced" : r.status,
          error: r.detail ?? undefined, conflicts: r.conflicts ?? undefined, result: r.data ?? undefined });
      };
      const send = (ops: QueuedOp[]) => api.syncOperations(ops.map((o) => ({ op_id: o.op_id, device_id: deviceId(), client_created_at: o.created_at, op: o.op })));
      try {
        const { results } = await send(todo);
        lastReachable = true;
        const byId = new Map(results.map((r) => [r.op_id, r]));
        for (const o of todo) await settle(o, byId.get(o.op_id));
      } catch (e) {
        // Network/timeout/5xx: keep everything pending and retry later. An expired access token was already
        // refreshed transparently by api.ts; a 401 here means the session is over: the ops stay queued in
        // IndexedDB (never wiped on 401) and sync after the next sign-in.
        lastReachable = !(e instanceof ApiError && e.status === 0);
        if (e instanceof ApiError && isOpRejection(e.status)) {
          // The server refused the BATCH for a reason in the operations (422 bad value, 409 ...): one bad op must not block every later sale
          // for ever (QA review L1). Send them one at a time; an op the server still refuses is marked failed with the reason (it stays in
          // the list on the Sync screen for the owner to retry or discard, nothing is dropped); the rest go through.
          lastReachable = true;
          const brokenOrders = new Set<string>();
          let stopped = false;
          for (const o of todo) {
            if (stopped) { await putOp({ ...o, status: "pending" }); continue; }
            if (brokenOrders.has(o.order_ref)) { await putOp({ ...o, attempts: o.attempts, status: "failed", error: "An earlier step of this order was refused, so this step was not sent. Fix or discard the order." }); continue; }
            try {
              const { results } = await send([o]);
              await settle(o, results.find((r) => r.op_id === o.op_id));
            } catch (e2) {
              if (e2 instanceof ApiError && isOpRejection(e2.status)) {
                brokenOrders.add(o.order_ref);
                await putOp({ ...o, status: "failed", error: `The server refused this step: ${e2.message || `error ${e2.status}`}` });
              } else {
                stopped = true; // connection / session trouble: the rest waits, as for any failed send
                lastReachable = !(e2 instanceof ApiError && e2.status === 0);
                await putOp({ ...o, status: "pending", error: e2 instanceof ApiError ? e2.message : "Sync failed" });
              }
            }
          }
        } else {
          for (const o of todo) await putOp({ ...o, status: "pending", error: e instanceof ApiError ? e.message : "Sync failed" });
        }
      }
    };
    if (navigator.locks) await navigator.locks.request("pos-sync", { ifAvailable: true }, async (lock) => { if (lock) await run(); });
    else await run();
    await pruneSynced();
    await reportHeartbeat();
  } finally { flushing = false; notify(); }
}

let lastReported = -1;
let pushCheck: { token: string; ok: Promise<boolean> } | null = null;
/** The kitchen role has no sync.push: it must not post heartbeats (the server answers 403 on every page). Unknown (offline) = try. */
function canPush(token: string): Promise<boolean> {
  if (pushCheck?.token !== token) pushCheck = { token, ok: api.me().then((m) => m.role !== "kitchen").catch(() => { pushCheck = null; return true; }) };
  return pushCheck.ok;
}
let lastReportAt = 0;
/** Tells the server how many offline ops are still unsynced so reports can flag incomplete data. Best-effort. */
async function reportHeartbeat() {
  const n = (await listOps()).filter((o) => o.status !== "synced" && belongsToSession(o)).length;
  if (!auth.token || !navigator.onLine || (n === lastReported && Date.now() - lastReportAt < 60000)) return;
  if (!(await canPush(auth.token))) return;
  try { await api.heartbeat(deviceId(), n); lastReported = n; lastReportAt = Date.now(); } catch { /* retry on next flush */ }
}

async function pruneSynced() {
  // Ops of a ticket the counter still shows as "Offline" are kept until it flips (it needs the synced create_order result), see syncPrune.ts.
  const held = offlineRefs(await listDrafts().catch(() => []));
  for (const id of prunableOps(await listOps(), held)) await deleteOp(id);
}

/** Retry a failed op (and failed dependents of the same order). */
export async function retry(orderRef: string) {
  for (const o of await listOps()) if (o.order_ref === orderRef && (o.status === "failed" || o.status === "conflict")) await putOp({ ...o, status: "pending", error: undefined });
  notify(); void flush();
}

/** Manager accepts the current server prices for a conflicting offline order. */
export async function acceptPriceChanges(orderRef: string) {
  for (const o of await listOps()) {
    if (o.order_ref !== orderRef || o.status === "synced") continue;
    const op = o.op.type === "create_order" || o.op.type === "add_lines" ? { ...o.op, accept_price_changes: true } : o.op;
    await putOp({ ...o, op, status: "pending", error: undefined, conflicts: undefined });
  }
  notify(); void flush();
}

/**
 * Changes the customer inside a still-unsynced queued create_order (same client_uuid, so idempotency is untouched).
 * Runs under the same "pos-sync" lock as flush(), so it can never interleave with an upload of that op.
 * "updated": the queued op now carries the customer; "synced": the order already reached the server (use the
 * order endpoint instead); "missing": no queued create_order for this order.
 */
export async function setQueuedOrderCustomer(orderRef: string, customerId: string | null): Promise<"updated" | "synced" | "missing"> {
  const run = async (): Promise<"updated" | "synced" | "missing"> => {
    const o = (await listOps()).find((x) => x.order_ref === orderRef && x.op.type === "create_order");
    if (!o || o.op.type !== "create_order") return "missing";
    if (o.status === "synced") return "synced";
    await putOp({ ...o, op: { ...o.op, order: { ...o.op.order, customer_id: customerId } } });
    return "updated";
  };
  const r = navigator.locks ? await navigator.locks.request("pos-sync", run) : await run();
  notify();
  if (r === "updated") void flush();
  return r;
}

export async function discardOrder(orderRef: string) {
  for (const o of await listOps()) if (o.order_ref === orderRef && o.status !== "synced") await deleteOp(o.op_id);
  notify();
  void flush(); // also refreshes the server's view of this device's unsynced count
}

export async function unsyncedCount(): Promise<number> {
  return (await listOps()).filter((o) => o.status !== "synced").length;
}

/** On startup a crash may have left ops stuck in "syncing"; they are safe to resend (idempotent). */
export async function recoverInterrupted() {
  for (const o of await listOps()) if (o.status === "syncing") await putOp({ ...o, status: "pending" });
}

/**
 * Logout policy: never silently drop unsynced sales or unplaced tickets. `confirmDiscard(ops, drafts)` is asked when
 * either is non-zero (ops = unsynced queue operations, drafts = open tickets with items that were never placed).
 */
export async function safeLogoutCleanup(confirmDiscard: (ops: number, drafts: number) => boolean): Promise<boolean> {
  if (auth.token) await flush();
  const n = await unsyncedCount();
  const d = await unplacedDraftCount(auth.restaurantId);
  if ((n > 0 || d > 0) && !confirmDiscard(n, d)) return false;
  await wipeLocalData();
  return true;
}
