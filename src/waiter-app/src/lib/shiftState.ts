import type { QueuedOp } from "./queue/types";

export type ShiftSyncState = "queued" | "sending" | "recorded" | "local_only" | "failed";

/** Pure. What may be claimed about a shift's open/close op: "recorded" only after the server said so. */
export function shiftSyncState(ops: QueuedOp[], shiftId: string, which: "shift_open" | "shift_close" = "shift_open"): ShiftSyncState | null {
  const o = ops.find((x) => x.op.type === which && (x.op as { shift_uuid: string }).shift_uuid === shiftId);
  if (!o) return null;
  if (o.status === "failed") return "failed";
  if (o.status === "synced") return o.result?.unsupported ? "local_only" : "recorded";
  return o.status === "syncing" ? "sending" : "queued";
}
