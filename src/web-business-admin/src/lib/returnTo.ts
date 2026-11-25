/**
 * "Come back here after signing in": the counter's "Session expired, sign in again" prompt saves the page it was on, so the
 * cashier lands back on the counter (where the saved order and tabs are) instead of the role's home page.
 * sessionStorage only (per tab, gone when the tab closes); only same-site paths are ever followed.
 */
const KEY = "pos.afterSignIn";

export const isSafePath = (p: unknown): p is string => typeof p === "string" && /^\/[A-Za-z0-9_\-/]*$/.test(p) && !p.startsWith("//") && !p.startsWith("/login");

export function returnToAfterSignIn(path: string): void {
  try { if (isSafePath(path)) sessionStorage.setItem(KEY, path); } catch { /* storage blocked: the role's home page is used */ }
}

/** The saved page (once), or null. */
export function takeReturnTo(): string | null {
  try { const p = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY); return isSafePath(p) ? p : null; } catch { return null; }
}
