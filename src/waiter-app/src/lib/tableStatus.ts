import type { QueuedOp } from "./queue/types";
import type { ServerOrder } from "./types";

/**
 * Which tables are occupied, from the SERVER's open orders (this is what stops two waiters silently taking one table), plus the
 * orders this device has queued but the server has not confirmed yet.
 *  free    no open order
 *  mine    one open order, created from this device
 *  taken   one open order, created elsewhere (another waiter/device)
 *  queued  only a local order that is not on the server yet
 *  clash   two or more open orders on the same table (two devices raced while offline)
 */
export type TableState = "free" | "mine" | "taken" | "queued" | "clash";
export interface TableInfo {
  state: TableState;
  /** Order to open: server order id when known, else the local order ref. */
  orderId?: string;
  /** client_uuid of that order (for "add items"). */
  orderRef?: string;
  count: number;
}
export type ActiveOrder = Pick<ServerOrder, "id" | "client_uuid" | "table_id" | "status"> & { waiter_id?: string | null };

const ACTIVE = new Set(["open", "sent_to_kitchen"]);

/** `myUserId`: with GET /tables/status the server says which waiter owns each order, so "mine" also covers orders taken on my other devices. */
export function computeTableStatus(server: ActiveOrder[], ops: QueuedOp[], myUserId?: string | null): Record<string, TableInfo> {
  const localRefs = new Set(ops.map((o) => o.order_ref));
  const byTable = new Map<string, { id: string; ref: string; local: boolean; synced: boolean }[]>();
  const add = (table: string, e: { id: string; ref: string; local: boolean; synced: boolean }) => byTable.set(table, [...(byTable.get(table) ?? []), e]);
  const seen = new Set<string>();
  for (const s of server) {
    if (!s.table_id || !ACTIVE.has(s.status)) continue;
    seen.add(s.client_uuid);
    add(s.table_id, { id: s.id, ref: s.client_uuid, local: localRefs.has(s.client_uuid) || (!!myUserId && s.waiter_id === myUserId), synced: true });
  }
  const cancelled = new Set(ops.filter((o) => o.op.type === "cancel_order").map((o) => o.order_ref));
  for (const o of ops) {
    if (o.op.type !== "create_order" || !o.op.order.table_id || seen.has(o.order_ref) || cancelled.has(o.order_ref)) continue;
    if (o.status === "synced" && o.result?.order_id) continue; // already counted from the server list (or since billed/cancelled)
    add(o.op.order.table_id, { id: o.order_ref, ref: o.order_ref, local: true, synced: false });
  }
  const out: Record<string, TableInfo> = {};
  for (const [table, list] of byTable) {
    const first = list[0];
    const state: TableState = list.length > 1 ? "clash" : !first.synced ? "queued" : first.local ? "mine" : "taken";
    out[table] = { state, orderId: first.id, orderRef: first.ref, count: list.length };
  }
  return out;
}

/** True when starting a NEW order on this table would double-book it. */
export const isOccupied = (info: TableInfo | undefined): boolean => !!info && info.state !== "free";

/** Tables for the "My tables" tab: assigned to me, or that I have an order on. `assigned === null` = the server has no assignment API. */
export function myTableIds(tableIds: string[], assigned: Set<string> | null, status: Record<string, TableInfo>): string[] {
  return tableIds.filter((id) => assigned?.has(id) || status[id]?.state === "mine" || status[id]?.state === "queued" || status[id]?.state === "clash");
}
