/**
 * Takeaway / canteen token numbers: a per-device counter that restarts at 1 each local day.
 * The server has no token field on orders yet (see docs/ANDROID.md), so the number lives in the queued op label and
 * is shown on the order card; it is a counter for the counter, not a server identifier.
 */
export interface TokenState { day: string; last: number }
const KEY = "waiter.token.counter";

export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Pure: the number that comes next, and the state after taking it. */
export function nextToken(state: TokenState | null, today: string): { token: number; state: TokenState } {
  const token = state && state.day === today ? state.last + 1 : 1;
  return { token, state: { day: today, last: token } };
}

function load(): TokenState | null {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "null") as TokenState | null; } catch { return null; }
}
/** The next number without consuming it (shown in the cart). */
export const peekToken = (today = dayKey()): number => nextToken(load(), today).token;
/** Consumes and returns the next number. Called once, when the order is saved to the queue. */
export function takeToken(today = dayKey()): number {
  const { token, state } = nextToken(load(), today);
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* counter resets next launch; harmless */ }
  return token;
}
