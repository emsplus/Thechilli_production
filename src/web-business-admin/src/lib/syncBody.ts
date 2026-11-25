import type { OpPayload } from "./offlineDb";

export interface SyncOpBody { op_id: string; device_id: string; client_created_at: string; op: OpPayload }

/**
 * Body of POST /sync/operations. `client_sent_at` is the device's own clock (raw, no skew correction) at the moment the batch is
 * sent: the server compares it with its time to correct every `client_created_at` of the batch for a wrong device clock, so a slow
 * tablet no longer books a sale on the wrong day / financial year. An older server ignores the extra field.
 */
export function syncBody(operations: SyncOpBody[], now: Date = new Date()): { operations: SyncOpBody[]; client_sent_at: string } {
  return { operations, client_sent_at: now.toISOString() };
}

/**
 * A rejection that is about the OPERATIONS (bad value, refused rule, conflict), not about the connection or the account: one such op
 * must not keep the whole queue stuck for ever. Not these: 401 (sign in again), 402/403 (plan or permission, the same for every op and
 * fixed outside the queue), 408 / 425 / 429 (try again later).
 */
export function isOpRejection(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 402, 403, 408, 425, 429].includes(status);
}
