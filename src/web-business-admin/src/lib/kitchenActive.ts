import { isOpenKot } from "./kitchenStatusMode";

/**
 * One rule for "is this order in the kitchen", shared by the Kitchen board and the Orders tile so they never disagree.
 * The server takes a ticket off the board when the bill is made and counts "in kitchen" from active tickets; the screens read the
 * same way: a ticket counts only while its order is still running (not billed, cancelled or void) and the kitchen has not finished it.
 */
const ENDED = new Set(["billed", "cancelled", "void", "voided"]);

export interface KotLike { order_id: string; status: string; done_at?: string | null }
export interface OrderLike { id: string; status: string }

/** The ticket is still live: open on the kitchen screen and its order has not been billed or cancelled (an unknown order = trust the ticket). */
export function isActiveTicket(k: KotLike, order?: { status: string } | null): boolean {
  return isOpenKot(k) && !(order && ENDED.has(order.status));
}

/** Ids of the orders the kitchen has right now: sent to the kitchen, or holding a live ticket (an add-on ticket on a running order). */
export function inKitchenOrderIds(orders: OrderLike[], kots: KotLike[] | null | undefined): Set<string> {
  const byId = new Map(orders.map((o) => [o.id, o]));
  const ids = new Set<string>();
  for (const o of orders) if (o.status === "sent_to_kitchen") ids.add(o.id);
  for (const k of kots ?? []) { const o = byId.get(k.order_id); if (o && isActiveTicket(k, o) && !ENDED.has(o.status)) ids.add(o.id); }
  return ids;
}
