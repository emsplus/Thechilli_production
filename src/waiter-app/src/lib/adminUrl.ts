/**
 * Owner / manager use the full Business app (POS, menu, reports, Manage, AI...) instead of the waiter screens. One APK,
 * the role decides: the waiter app opens the Business app in its own WebView. The URL is set per build
 * (NEXT_PUBLIC_ADMIN_URL: UAT build -> UAT business app, Prod build -> Prod). Unset = old behaviour (waiter screens for everyone).
 */
export const ADMIN_URL = (process.env.NEXT_PUBLIC_ADMIN_URL ?? "").trim();
export const isAdminRole = (role: string | undefined | null): boolean => role === "owner" || role === "manager";
export const adminAvailable = (role: string | undefined | null): boolean => !!ADMIN_URL && isAdminRole(role);

const MODE_KEY = "chilli.mode"; // "admin" | "staff": what this phone opened last (a per-device convenience, never a credential)
export const getMode = (): "admin" | "staff" | null => { try { const v = localStorage.getItem(MODE_KEY); return v === "admin" || v === "staff" ? v : null; } catch { return null; } };
export const setMode = (m: "admin" | "staff"): void => { try { localStorage.setItem(MODE_KEY, m); } catch { /* storage unavailable */ } };

/**
 * Leaves the waiter screens for the Business app (same WebView; the host is whitelisted in capacitor.config.ts) and remembers
 * "admin" so the next cold start opens it again. `replace` is for the automatic cold-start hop (no way "back" to the splash).
 */
export function openAdmin(replace = false): void {
  if (!ADMIN_URL || typeof window === "undefined") return;
  setMode("admin");
  let target = ADMIN_URL;
  try { const u = new URL("/login", ADMIN_URL); u.searchParams.set("from", window.location.origin); target = u.toString(); } catch { /* keep the plain URL */ }
  if (replace) window.location.replace(target); else window.location.assign(target);
}
