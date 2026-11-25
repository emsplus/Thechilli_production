import type { OpPayload, SyncResultOut } from "./types";

/**
 * Ops that are not in POST /sync/operations are sent as ordinary REST calls. This file is the single place that knows the
 * paths (assumed ones are listed in docs/WAITER_API_ASSUMPTIONS.md). Every call carries the queue op_id as Idempotency-Key and in
 * the body, so a resend after a cut connection is harmless.
 */
export interface RestCall { method: "POST"; path: string; body: Record<string, unknown> }

export function restCall(op: OpPayload): RestCall | null {
  if (op.type === "clock_in") return { method: "POST", path: "/attendance/clock-in", body: { client_uuid: op.client_uuid, at: op.at, device: op.device } };
  if (op.type === "clock_out") return { method: "POST", path: "/attendance/clock-out", body: { ...(op.client_uuid ? { client_uuid: op.client_uuid } : {}), at: op.at, device: op.device } };
  if (op.type !== "cancel_order" || !op.server_order_id) return null;
  // Not yet on a KOT: the waiter-level route (orders.cancel_unsent). With a KOT: the cashier/manager route (orders.cancel).
  return op.unsent
    ? { method: "POST", path: `/orders/${op.server_order_id}/cancel-unsent`, body: { reason: op.reason } }
    : { method: "POST", path: `/orders/${op.server_order_id}/cancel`, body: { reason: op.reason } };
}

const RESULT_STATUS = new Set(["synced", "conflict", "failed"]);
/**
 * The per-operation verdicts inside an error answer of POST /sync/operations (M3 of docs/testing/INDEPENDENT_REVIEW_REPORT.md: a 409 may
 * come from ONE op, with `results` for the batch, at the top level or under `detail`). null = the answer says nothing per operation.
 */
export function perOpResults(body: unknown): SyncResultOut[] | null {
  const b = body && typeof body === "object" ? (body as { results?: unknown; detail?: unknown }) : null;
  const raw = Array.isArray(b?.results) ? b.results : b?.detail && typeof b.detail === "object" && Array.isArray((b.detail as { results?: unknown }).results) ? (b.detail as { results: unknown[] }).results : null;
  if (!raw) return null;
  const ok = raw.filter((r): r is SyncResultOut => !!r && typeof r === "object" && typeof (r as SyncResultOut).op_id === "string" && RESULT_STATUS.has((r as SyncResultOut).status))
    .map((r) => ({ ...r, detail: r.detail ?? null, conflicts: r.conflicts ?? null, data: r.data ?? null }));
  return ok.length ? ok : null;
}

/**
 * Result of one extended op inside a /sync/operations call. An older server (422 on the unknown op type) means "not supported".
 * 409: only the operations the answer names are decided; with no per-operation information nothing is decided ("retry": every op
 * stays queued and is sent again with backoff), never "every op of the group failed".
 */
export function interpretExtBatchError(ops: { op_id: string; op: OpPayload }[], status: number, body?: unknown): SyncResultOut[] | "retry" | "auth" {
  if (status === 401) return "auth";
  if (status === 409) return perOpResults(body) ?? "retry";
  if (status === 0 || status === 408 || status === 425 || status === 429 || (status >= 500 && status !== 501)) return "retry";
  return ops.map((o) => {
    const unsupported = status === 404 || status === 405 || status === 422 || status === 501;
    if (unsupported && (o.op.type === "shift_open" || o.op.type === "shift_close")) return { op_id: o.op_id, status: "synced" as const, detail: null, conflicts: null, data: { unsupported: true } };
    if (unsupported) return { op_id: o.op_id, status: "failed" as const, detail: plainHttpError(501, o.op.type, null), conflicts: null, data: { unsupported: true } };
    return { op_id: o.op_id, status: "failed" as const, detail: plainHttpError(status, o.op.type, null), conflicts: null, data: null };
  });
}

/** What a failed HTTP answer means for an op. "retry" = transient, keep it queued; otherwise a final result for the op. */
export type RestOutcome = { kind: "result"; result: SyncResultOut } | { kind: "retry"; status: number; message: string } | { kind: "auth" };

const UNSUPPORTED = new Set([404, 405, 501]);
/** Shift records are bookkeeping: a server without the endpoint must not stop the waiter from working. */
const BEST_EFFORT = new Set<string>();

export function plainHttpError(status: number, type: OpPayload["type"], detail: string | null): string {
  if (type === "bill_request" && status === 403) return "You are not allowed to ask for the bill.";
  if (status === 403 && (type === "clock_in" || type === "clock_out")) return "Your role cannot clock in on this app. Ask a manager.";
  if (status === 404 && type === "clock_out") return "The server has no clock-in for this. Ask a manager to correct it.";
  if (status === 403) return type === "cancel_order" ? "Only a cashier or manager can cancel an order the kitchen already has." : "You are not allowed to do this.";
  if (status === 409 && type === "cancel_order") return "The kitchen already has this order. Ask a cashier or manager to cancel it.";
  if (status === 409) return detail || "The server says this has already changed. Refresh and check the order.";
  if (status === 404 && type === "cancel_order") return "The server cannot find this order.";
  if (UNSUPPORTED.has(status)) return "This server does not support this yet. Tell the cashier directly.";
  if (status === 422 || status === 400) return detail || "The server did not accept this.";
  return detail || `The server answered with an error (${status}).`;
}

export function interpret(op: OpPayload, opId: string, status: number, body: unknown): RestOutcome {
  const detail = body && typeof body === "object" && typeof (body as { detail?: unknown }).detail === "string" ? (body as { detail: string }).detail : null;
  const done = (data: Record<string, unknown> | null, st: SyncResultOut["status"] = "synced", msg: string | null = null): RestOutcome =>
    ({ kind: "result", result: { op_id: opId, status: st, detail: msg, conflicts: null, data } });
  if (status >= 200 && status < 300) return done(body && typeof body === "object" ? (body as Record<string, unknown>) : null);
  if (status === 401) return { kind: "auth" };
  // Already in the state the tap asked for (clocked in on another phone, or the record was closed by a manager): done.
  if (status === 409 && (op.type === "clock_in" || op.type === "clock_out")) return done(body && typeof body === "object" ? (body as Record<string, unknown>) : null);
  if (status === 409 && op.type === "cancel_order") return done(null, "failed", plainHttpError(409, op.type, detail)); // KOT exists / already billed
  if (UNSUPPORTED.has(status) && !(status === 404 && op.type === "cancel_order")) {
    if (BEST_EFFORT.has(op.type)) return done({ unsupported: true });
    return done({ unsupported: true }, "failed", plainHttpError(status, op.type, detail));
  }
  if (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500) return { kind: "retry", status, message: detail ?? "Server not reachable" };
  return done(null, "failed", plainHttpError(status, op.type, detail));
}
