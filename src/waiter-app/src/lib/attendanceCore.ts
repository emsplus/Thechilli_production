import type { QueuedOp } from "./queue/types";

/** Pure parts of clock in / out (lib/attendance.ts), unit-tested in attendance.test.ts. */
export interface ClockState { open: boolean; since: string | null; client_uuid: string | null; user_id: string | null }
export const CLOSED: ClockState = { open: false, since: null, client_uuid: null, user_id: null };
export const DEVICE = "Chilli Staff app";

/** Pure: the next queue item for a tap, and the state after it. */
export function clockTap(state: ClockState, now: Date, id: string, userId: string | null): { state: ClockState; item: { op: QueuedOp["op"]; order_ref: string; label: string; dedupe_key: string } } {
  const at = now.toISOString();
  if (!state.open) {
    return { state: { open: true, since: at, client_uuid: id, user_id: userId },
      item: { op: { type: "clock_in", client_uuid: id, at, device: DEVICE }, order_ref: `attendance:${id}`, label: "Clock in", dedupe_key: `clock_in:${id}` } };
  }
  const ref = state.client_uuid ?? id;
  return { state: { ...CLOSED, user_id: userId },
    item: { op: { type: "clock_out", client_uuid: state.client_uuid, at, device: DEVICE }, order_ref: `attendance:${ref}`, label: "Clock out", dedupe_key: `clock_out:${ref}` } };
}

/** Pure: is a clock tap of this phone still waiting for the server? */
export const clockPending = (ops: QueuedOp[]): boolean => ops.some((o) => o.status !== "synced" && (o.op.type === "clock_in" || o.op.type === "clock_out"));
export const clockFailed = (ops: QueuedOp[]): QueuedOp | undefined => ops.find((o) => o.status === "failed" && (o.op.type === "clock_in" || o.op.type === "clock_out"));

