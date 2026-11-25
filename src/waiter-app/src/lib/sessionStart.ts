const KEY = "waiter.sessionStart";
/** Called at sign-in: "this session" for ready-KOT toasts begins now. */
export function markSessionStart(now = new Date()) { try { localStorage.setItem(KEY, now.toISOString()); } catch { /* ignore */ } }
/** ISO time of the current sign-in; initialised on first use so an upgraded install does not announce old tickets. */
export function getSessionStart(): string | null {
  try {
    let s = localStorage.getItem(KEY);
    if (!s) { s = new Date().toISOString(); localStorage.setItem(KEY, s); }
    return s;
  } catch { return null; }
}
