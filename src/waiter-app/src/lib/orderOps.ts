import type { QueuedOp } from "./queue/types";

export type OpUiState = "none" | "queued" | "sending" | "done" | "failed";

function stateOfOp(o: QueuedOp | undefined): { state: OpUiState; error?: string; unsupported?: boolean } {
  if (!o) return { state: "none" };
  if (o.status === "synced") return { state: "done" };
  if (o.status === "failed") return { state: "failed", error: o.error, unsupported: !!o.result?.unsupported };
  return { state: o.status === "syncing" ? "sending" : "queued" };
}

/**
 * Bill request: "done" (the UI may say "Cashier notified") only when the server accepted the request, or the server order
 * itself says one was made. A queued/failed request never claims a notification.
 */
export function billRequestState(ops: QueuedOp[], serverBillRequestedAt?: string | null) {
  if (serverBillRequestedAt) return { state: "done" as OpUiState };
  return stateOfOp(ops.find((o) => o.op.type === "bill_request"));
}
export const cancelState = (ops: QueuedOp[]) => stateOfOp(ops.find((o) => o.op.type === "cancel_order"));

/** Lines still waiting to leave this device (never attempted), with the op that holds them: the only lines a waiter may remove. */
export function unsentLines(ops: QueuedOp[]): { opId: string; index: number; item_id: string; variant_id: string | null; quantity: number; note?: string | null; editable: boolean }[] {
  const out: ReturnType<typeof unsentLines> = [];
  for (const o of ops) {
    if (o.status === "synced") continue;
    const lines = o.op.type === "create_order" ? o.op.order.lines : o.op.type === "add_lines" ? o.op.lines : null;
    if (!lines) continue;
    lines.forEach((l, index) => out.push({ opId: o.op_id, index, item_id: l.item_id, variant_id: l.variant_id ?? null, quantity: l.quantity, note: l.note, editable: o.status !== "syncing" && o.attempts === 0 }));
  }
  return out;
}

/** The server accepted a bill request for this order: remembered here because synced ops are pruned from the queue after a while. */
export const markBillRequested = (ref: string) => { try { localStorage.setItem(`waiter.billreq.${ref}`, "1"); } catch { /* ignore */ } };
export const wasBillRequested = (ref: string): boolean => { try { return localStorage.getItem(`waiter.billreq.${ref}`) === "1"; } catch { return false; } };
