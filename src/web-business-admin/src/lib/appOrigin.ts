/**
 * The Chilli Staff app opens this site inside its own WebView with `?from=<the app's origin>` so a manager who signed out here can
 * get back to the staff (waiter) sign-in. Only the app's own local origins are accepted (localhost over http / https / capacitor),
 * never an arbitrary URL, so this is not an open redirect. Remembered per device in localStorage; absent in a normal browser.
 */
const KEY = "pos.staffAppOrigin";
const ORIGIN = /^(https?|capacitor):\/\/localhost(:\d{1,5})?$/;
export const isAppOrigin = (v: string | null | undefined): v is string => !!v && ORIGIN.test(v);

export function rememberAppOrigin(search: string): void {
  try { const v = new URLSearchParams(search).get("from"); if (isAppOrigin(v)) localStorage.setItem(KEY, v); } catch { /* storage unavailable */ }
}
export function appOrigin(): string | null {
  try { const v = localStorage.getItem(KEY); return isAppOrigin(v) ? v : null; } catch { return null; }
}
/** Where the "Back to staff login" link goes: the app's start page (the WebView serves index.html for every route), which resets its remembered mode and shows the sign-in. */
export const staffLoginHref = (origin: string): string => `${origin}/?mode=staff`;
