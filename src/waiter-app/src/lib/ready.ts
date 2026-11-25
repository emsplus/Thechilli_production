import type { QueuedOp } from "./queue/types";
import type { Kot } from "./types";

/**
 * Kots that just became "ready" and have not been announced yet. Pure so the polling transport can later be swapped
 * for a websocket (feed `onReady` the same Kot objects) without touching UI code.
 */
export function newlyReady(kots: Kot[], announced: ReadonlySet<string>): Kot[] {
  return kots.filter((k) => k.status === "ready" && !announced.has(k.id));
}

/** Transport interface. Polling implementation is in useReadyNotifications; a WebSocket one can implement the same shape. */
export interface ReadyFeed {
  start(onReady: (kots: Kot[]) => void): void;
  stop(): void;
}

/**
 * KOTs this device created during the current sign-in: the server answered a send_kot op (result.kot = KOT number) for an
 * order whose server id we learned from a create_order / add_lines result. Other waiters' tickets never match. The KOT number
 * is only unique together with its order, so keys are "orderId#number".
 */
export function myKotKeys(ops: QueuedOp[], sessionStart: string | null, restaurantId?: string | null): Set<string> {
  const mine = ops.filter((o) => o.status === "synced" && (!sessionStart || o.created_at >= sessionStart) && (!o.restaurant_id || !restaurantId || o.restaurant_id === restaurantId));
  const orderIdOf = new Map<string, string>();
  for (const o of mine) { const id = o.result?.order_id; if (typeof id === "string") orderIdOf.set(o.order_ref, id); }
  const keys = new Set<string>();
  for (const o of mine) {
    const n = o.result?.kot, id = orderIdOf.get(o.order_ref);
    if (o.op.type === "send_kot" && typeof n === "number" && id) keys.add(`${id}#${n}`);
  }
  return keys;
}
/** `myOrders`: server ids of open orders the server says are this waiter's (GET /tables/status), so a ticket of an order taken on
 *  the waiter's OTHER device (PWA + app, same sign-in) is announced on both. */
export const onlyMine = (kots: Kot[], keys: ReadonlySet<string>, myOrders?: ReadonlySet<string>): Kot[] =>
  kots.filter((k) => keys.has(`${k.order_id}#${k.number}`) || !!myOrders?.has(k.order_id));
