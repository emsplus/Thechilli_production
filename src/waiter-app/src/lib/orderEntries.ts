import { areaLabel } from "./areas";
import { fromMinor, toMinor } from "./money";
import type { LineInput, QueuedOp } from "./queue/types";
import type { DiningTable, ServerOrder } from "./types";

export interface OrderEntry { ref: string; ops: QueuedOp[]; server?: ServerOrder }

/** Shift open/close ops travel through the same queue but are not orders: they must never appear as an order card or count. */
export const isShiftRef = (ref: string): boolean => ref.startsWith("shift:") || ref.startsWith("attendance:");

const hasCreate = (ops: QueuedOp[]) => ops.some((o) => o.op.type === "create_order");

/**
 * Merge local queue groups with server orders. Local entries without a server row are NOT confirmed.
 * Dropped: shift groups, and "ghost" groups that have no create_order of their own (items added to / bill asked for an
 * order that is no longer in the server list, e.g. billed meanwhile) once every op in them is synced: nothing left to show.
 */
export function mergeOrders(ops: QueuedOp[], server: ServerOrder[], serverReadAt: string | null = null): OrderEntry[] {
  const readAt = serverReadAt ? Date.parse(serverReadAt) : NaN;
  const groups = new Map<string, QueuedOp[]>();
  for (const o of ops) if (!isShiftRef(o.order_ref)) groups.set(o.order_ref, [...(groups.get(o.order_ref) ?? []), o]);
  const byRef = new Map(server.map((s) => [s.client_uuid, s]));
  const out: OrderEntry[] = [];
  for (const [ref, g] of groups) {
    const s = byRef.get(ref);
    if (!s && !hasCreate(g) && g.every((o) => o.status === "synced")) continue;
    // An order this device placed that the server confirmed but whose row is gone from a list read AFTER the confirmation: it was billed,
    // paid, cancelled or merged at the counter / another device. It is not an active order any more (it used to stay listed for ever,
    // until 30 newer queue entries pushed it out). The list read must be newer than the last confirmation, or a just-synced order would flicker.
    if (!s && hasCreate(g) && g.every((o) => o.status === "synced") && Number.isFinite(readAt) && readAt > Math.max(...g.map((o) => o.synced_at ?? 0))) continue;
    out.push({ ref, ops: g, server: s });
  }
  for (const s of server) if (!groups.has(s.client_uuid)) out.push({ ref: s.client_uuid, ops: [], server: s });
  return out.sort((a, b) => (b.server?.created_at ?? b.ops[0]?.created_at ?? "").localeCompare(a.server?.created_at ?? a.ops[0]?.created_at ?? ""));
}

const linesTotal = (lines: LineInput[]): number => lines.reduce((s, l) => s + toMinor(l.expected_unit_price ?? "0") * l.quantity, 0);

/** Server subtotal when the server has the order; otherwise the prices the waiter saw on the queued lines (the server re-checks them). */
export function entryTotal(e: OrderEntry): string | null {
  if (e.server) return e.server.subtotal;
  let minor = 0; let any = false;
  for (const o of e.ops) {
    if (o.op.type === "create_order") { minor += linesTotal(o.op.order.lines); any = true; }
    if (o.op.type === "add_lines") { minor += linesTotal(o.op.lines); any = true; }
  }
  return any ? fromMinor(minor) : null;
}

const TYPE_NAME: Record<string, string> = { indoor: "Dine-in", outdoor: "Outdoor", takeaway: "Takeaway", delivery: "Delivery", dine_in: "Dine-in" };
export const orderTypeName = (t: string | null | undefined): string => (t ? TYPE_NAME[t] ?? areaLabel(t) : "Order");

/** Card heading: "Table T4", "Takeaway · Token #3", "Delivery", or "Added items" for a local addition to an order not listed. */
export function entryLabel(e: OrderEntry, tables: DiningTable[]): string {
  const create = e.ops.find((o) => o.op.type === "create_order");
  const order = create?.op.type === "create_order" ? create.op.order : null;
  const tableId = e.server?.table_id ?? order?.table_id ?? null;
  if (tableId) {
    const label = tables.find((t) => t.id === tableId)?.label ?? create?.label.match(/· Table (.+)$/)?.[1]; // the label saved with the order covers a table list that is not loaded
    return `Table ${label ?? (tables.length ? "(removed)" : "")}`.trim();
  }
  const type = e.server?.order_type ?? order?.order_type ?? null;
  if (!type) return "Added items";
  const token = e.server?.token_number ? `Token #${e.server.token_number}` : create?.label.match(/Token #\d+/)?.[0];
  return token ? `${orderTypeName(type)} · ${token}` : orderTypeName(type);
}

/** One unit everywhere (header pill, banner, Orders badge): ORDERS with something still to send. Shift ops are not orders. */
export function pendingOrderCount(ops: QueuedOp[]): number {
  return new Set(ops.filter((o) => o.status !== "synced" && !isShiftRef(o.order_ref)).map((o) => o.order_ref)).size;
}
export function failedOrderCount(ops: QueuedOp[]): number {
  return new Set(ops.filter((o) => o.status === "failed" && !isShiftRef(o.order_ref)).map((o) => o.order_ref)).size;
}
/** A shift open/close still waiting to reach the server (shown separately, never as an order). */
export const shiftPending = (ops: QueuedOp[]): boolean => ops.some((o) => o.status !== "synced" && o.order_ref.startsWith("shift:"));
export const ordersWord = (n: number): string => `${n} order${n === 1 ? "" : "s"}`;
