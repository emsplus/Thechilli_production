/** "Remind the counter" may be pressed once a minute per order: the cashier is not buzzed by every tap. */
export const REMIND_GAP_MS = 60_000;
const key = (orderId: string) => `waiter.remind.${orderId}`;

/** Milliseconds until the counter may be reminded again (0 = now). A last reminder "in the future" (clock set back) never blocks for longer than the gap. */
export function remindWaitMs(last: number | null, now: number): number {
  if (last === null || !Number.isFinite(last)) return 0;
  return Math.max(0, Math.min(REMIND_GAP_MS, last + REMIND_GAP_MS - now));
}
export function lastRemindedAt(orderId: string): number | null {
  try { const v = Number(localStorage.getItem(key(orderId))); return v > 0 ? v : null; } catch { return null; }
}
export function markReminded(orderId: string, now = Date.now()) { try { localStorage.setItem(key(orderId), String(now)); } catch { /* ignore */ } }
export function clearReminded(orderId: string) { try { localStorage.removeItem(key(orderId)); } catch { /* ignore */ } }

/** What pressing "Remind the counter" came to. Nothing is queued: a reminder that cannot go out now is not worth sending later. */
export type RemindResult =
  | { kind: "told" }                       // 200: the counter has a payment_reminder alert
  | { kind: "already" }                    // 200 already_sent: the counter was told less than a minute ago (by this or another phone)
  | { kind: "offline" }                    // no connection: "Needs a connection"
  | { kind: "unsupported" }                // an older server (404/405 on POST /orders/{id}/remind-payment): the old "ask the cashier" message
  | { kind: "refused"; message: string }   // 409 in plain words (already paid, bill cancelled, ...)
  | { kind: "failed"; message: string };

/** `send` = api.remindPayment (POST /orders/{id}/remind-payment); `online` = navigator.onLine. Never throws. */
export async function remindCounter(orderId: string, send: (id: string) => Promise<{ already_sent: boolean }>, online: boolean): Promise<RemindResult> {
  if (!online) return { kind: "offline" };
  try {
    const r = await send(orderId);
    return { kind: r.already_sent ? "already" : "told" };
  } catch (e) {
    const status = (e as { status?: number } | null)?.status;
    const message = e instanceof Error ? e.message : "";
    if (status === 0) return { kind: "offline" };
    if (status === 404 || status === 405) return { kind: "unsupported" };
    if (status === 409) return { kind: "refused", message };
    return { kind: "failed", message };
  }
}
