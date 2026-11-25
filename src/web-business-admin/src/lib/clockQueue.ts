import { useSyncExternalStore } from "react";

/**
 * Offline clock in / out (pos-service docs/RESERVATIONS_ATTENDANCE_SETUP_API.md): a tap without a connection is queued on this
 * device with its own `client_uuid` and the device time `at`, and sent when the connection is back. The server makes replays
 * safe: clock-in with the same `client_uuid` answers 200 with the same record; clock-out's `client_uuid` is the CLOCK-IN's key and
 * closes exactly that record. `at` may be up to 24 h old.
 */
export interface ClockOp { kind: "in" | "out"; client_uuid?: string; at: string; device?: string }

/** Is the person clocked in once the queued taps are applied on top of what the server last said? */
export function effectiveState(serverOpen: { clock_in_at: string; client_uuid?: string | null } | null, queue: readonly ClockOp[]):
  { open: boolean; since: string | null; inKey: string | null; pending: boolean } {
  let open = !!serverOpen, since = serverOpen?.clock_in_at ?? null, inKey = serverOpen?.client_uuid ?? null;
  for (const op of queue) {
    if (op.kind === "in") { open = true; since = op.at; inKey = op.client_uuid ?? null; } else { open = false; since = null; inKey = null; }
  }
  return { open, since, inKey, pending: queue.length > 0 };
}

/** The op for a tap: clock in with a fresh key, or clock out of the record the person is in (by its clock-in key when known). */
export function nextOp(state: { open: boolean; inKey: string | null }, at: string, newKey: () => string, device?: string): ClockOp {
  return state.open ? { kind: "out", ...(state.inKey ? { client_uuid: state.inKey } : {}), at, device } : { kind: "in", client_uuid: newKey(), at, device };
}

/** Error from a send: `offline` keeps the op for later; `final` means the server will never accept it (drop it, tell the user). */
export type SendResult = "ok" | "offline" | "final" | "retry";

/**
 * Sends the queued ops in order. Stops at the first op that cannot be sent now (offline, or a server error worth retrying);
 * drops ops the server answers with a final refusal (already clocked in, not clocked in, too old, unknown key).
 */
export async function flushOps(queue: readonly ClockOp[], send: (op: ClockOp) => Promise<SendResult>): Promise<{ remaining: ClockOp[]; sent: ClockOp[]; dropped: ClockOp[] }> {
  const rest = [...queue]; const sent: ClockOp[] = []; const dropped: ClockOp[] = [];
  while (rest.length) {
    const r = await send(rest[0]);
    if (r === "offline" || r === "retry") break;
    (r === "ok" ? sent : dropped).push(rest.shift()!);
  }
  return { remaining: rest, sent, dropped };
}

/* ---------- storage (per signed-in user, this device) ---------- */
const PREFIX = "pos.clockQueue:";
const EVT = "pos-clock-queue";
const EMPTY: ClockOp[] = [];
const cache = new Map<string, { raw: string | null; ops: ClockOp[] }>();

export function readQueue(user: string | null): ClockOp[] {
  if (!user) return EMPTY;
  let raw: string | null = null;
  try { raw = localStorage.getItem(PREFIX + user); } catch { /* storage unavailable */ }
  const hit = cache.get(user);
  if (hit && hit.raw === raw) return hit.ops; // stable identity for useSyncExternalStore
  let ops: ClockOp[] = EMPTY;
  try { const v = raw ? JSON.parse(raw) : []; if (Array.isArray(v)) ops = v.filter((o) => o && (o.kind === "in" || o.kind === "out") && typeof o.at === "string"); } catch { /* corrupt: start over */ }
  cache.set(user, { raw, ops });
  return ops;
}

export function writeQueue(user: string, ops: ClockOp[]) {
  try { if (ops.length) localStorage.setItem(PREFIX + user, JSON.stringify(ops)); else localStorage.removeItem(PREFIX + user); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(EVT));
}

const subscribe = (cb: () => void) => {
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", cb);
  return () => { window.removeEventListener(EVT, cb); window.removeEventListener("storage", cb); };
};

/** The queued clock taps of `user` on this device (live). */
export function useClockQueue(user: string | null): ClockOp[] {
  return useSyncExternalStore(subscribe, () => readQueue(user), () => EMPTY);
}
