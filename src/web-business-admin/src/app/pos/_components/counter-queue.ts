import type { Customer, DiningTable, Kot, Order } from "@/lib/types";
import { isOpenKot, type KitchenStatusMode } from "@/lib/kitchenStatusMode";

/** One card of the counter's ticket queue (orders not billed yet, oldest first). */
export interface QueueEntry {
  orderId: string;
  /** "T4", "Takeaway", "Delivery". */
  where: string;
  customer: string | null;
  total: string;
  /** Kitchen state of the newest KOT: none sent yet, waiting, cooking, ready, served. */
  status: "new" | "sent" | "cooking" | "ready" | "served";
  /** When the newest KOT was sent (elapsed timer); null before any KOT. */
  since: string | null;
  items: number;
  /** The kitchen still has the newest ticket (KOT-only: not Done yet). Drives the late warning without any status. */
  working: boolean;
}

const KOT_STATUS: Record<string, QueueEntry["status"]> = { pending: "sent", preparing: "cooking", ready: "ready", served: "served" };

/**
 * Pure: open / in-kitchen orders joined with their newest KOT, table and customer. Cancelled KOTs are ignored.
 * `kot_only` (the default kitchen mode): no Cooking / Ready / Served states, a sent order is just "sent" (shown as "In kitchen").
 */
export function counterQueue(orders: Order[], kots: Kot[], tables: DiningTable[], customers: Customer[], mode: KitchenStatusMode = "track"): QueueEntry[] {
  const newest = new Map<string, Kot>();
  for (const k of kots) {
    if (k.status === "cancelled") continue;
    const cur = newest.get(k.order_id);
    if (!cur || k.number > cur.number) newest.set(k.order_id, k);
  }
  const tableOf = new Map(tables.map((t) => [t.id, t.label]));
  const nameOf = new Map(customers.map((c) => [c.id, c.name || c.phone || null]));
  return orders
    .filter((o) => o.status === "open" || o.status === "sent_to_kitchen")
    .map((o): QueueEntry => {
      const k = newest.get(o.id);
      const where = o.table_id && tableOf.get(o.table_id) ? tableOf.get(o.table_id)! : o.order_type === "delivery" ? "Delivery" : o.order_type === "takeaway" ? "Takeaway" : "No table";
      return {
        orderId: o.id, where, customer: o.customer_id ? nameOf.get(o.customer_id) ?? null : null, total: o.subtotal,
        status: !k ? "new" : mode === "kot_only" ? "sent" : KOT_STATUS[k.status] ?? "sent", since: k?.created_at ?? null,
        items: o.lines.reduce((n, l) => n + l.quantity, 0),
        working: !!k && (mode === "kot_only" ? isOpenKot(k) : k.status === "pending" || k.status === "preparing"),
      };
    })
    .sort((a, b) => (a.since ?? "9").localeCompare(b.since ?? "9"));
}

/** "4:05" (m:ss) under an hour, "1 h 12 m" after. */
export function elapsed(since: string | null, now: number): string {
  if (!since) return "";
  const s = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} m`;
}
