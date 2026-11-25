import { sumMoney } from "./money";
import type { Order } from "./types";
import type { TableStatus } from "./extras";

/** `reserved`: a FREE table held for a booking starting within the hour (GET /tables/status). */
export type TableState = "free" | "occupied" | "kitchen" | "reserved";
export interface TableLive { state: TableState; orders: number; lines: number; total: string }
export const TABLE_STATE_LABEL: Record<TableState, string> = { free: "Free", occupied: "Order open", kitchen: "With kitchen", reserved: "Reserved" };

/** Live state of each table from the server's unpaid orders (open or sent to the kitchen). Tables absent from the map are free. */
export function tableLive(orders: Order[]): Map<string, TableLive> {
  const m = new Map<string, TableLive>();
  for (const o of orders) {
    if (!o.table_id || (o.status !== "open" && o.status !== "sent_to_kitchen")) continue;
    const prev = m.get(o.table_id);
    const state: TableState = o.status === "sent_to_kitchen" || prev?.state === "kitchen" ? "kitchen" : "occupied";
    m.set(o.table_id, { state, orders: (prev?.orders ?? 0) + 1, lines: (prev?.lines ?? 0) + o.lines.length, total: sumMoney([prev?.total ?? "0", o.subtotal]) });
  }
  return m;
}

/** What GET /tables/status adds to a busy table: who took it (the waiter app's "booking" is an order on the table) and its bill state. */
export interface TableExtra { waiters: string[]; billAsked: boolean; billMade: boolean; orderId: string | null }
export function tableExtras(status: TableStatus[]): Map<string, TableExtra> {
  const m = new Map<string, TableExtra>();
  for (const t of status) {
    const os = t.orders ?? [];
    if (!os.length) continue;
    m.set(t.table_id, { waiters: [...new Set(os.map((o) => o.waiter_name).filter((n): n is string => !!n))], billAsked: t.status === "bill_requested" || os.some((o) => !!o.bill_requested_at),
      billMade: t.status === "bill_printed" || os.some((o) => !!o.bill_id), orderId: os[0].order_id });
  }
  return m;
}
