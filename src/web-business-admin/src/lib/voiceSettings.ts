/**
 * Per-device voice settings (kept in this browser, like the hands-free switch): the countdown before a spoken "place order" /
 * "send to kitchen" runs by itself (seconds, default 3, 0 = at once; a dish with a Check marker always gets at least 5).
 */
const KEY = "pos.voiceCountdown";
export const VOICE_COUNTDOWN_CHOICES = [0, 2, 3, 5, 8] as const;
export const voiceCountdown = {
  get(): number {
    try { const v = Number(localStorage.getItem(KEY)); return localStorage.getItem(KEY) !== null && Number.isFinite(v) && v >= 0 && v <= 30 ? v : 3; } catch { return 3; }
  },
  set(s: number) { try { localStorage.setItem(KEY, String(Math.max(0, Math.min(30, Math.round(s))))); } catch { /* storage unavailable: default */ } },
};
