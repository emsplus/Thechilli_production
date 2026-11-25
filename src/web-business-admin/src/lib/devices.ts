/**
 * Signed-in devices, counter devices, staff PINs and step-up (pos-service docs/STAFF_PIN_DEVICES_API.md): shapes and the
 * pure rules the screens use. No React, no network: unit-tested in devices.test.ts.
 */
import type { Role } from "./types";

/** GET /auth/devices row. `active` = still has a live refresh token; `current` = the device that asked (by X-Device-Id). */
export interface SignedInDevice {
  id: string; user_id: string; user_name: string | null; user_role: Role | string | null; device_id: string | null;
  name: string | null; model: string | null; platform: string | null; user_agent: string | null;
  first_seen_at: string | null; last_seen_at: string | null; last_ip: string | null; revoked_at: string | null; active: boolean; current: boolean;
}
/** GET /devices/counter row. */
export interface CounterDevice {
  id: string; name: string; outlet_id: string | null; outlet_name: string | null; created_at: string; created_by: string | null;
  last_seen_at: string | null; last_ip: string | null; revoked_at: string | null; active_sessions: number;
}
/** POST /devices/counter answer: `device_token` is shown once and never again. */
export interface CounterDeviceCreated { id: string; name: string; outlet_id: string | null; created_at: string; device_token: string }
export interface PinStatus { is_set: boolean; set_at: string | null; set_by_manager: boolean }
export interface StepUpGrant { step_up_token: string; expires_in: number; expires_at?: string; method: "pin" | "password" }

export const PERM_DEVICES = "devices.manage";
export const PERM_PIN = "staff.pin.manage";

// ---------------------------------------------------------------- PIN rules (same as the server's 422)
export const PIN_MIN = 4;
export const PIN_MAX = 6;

/** Keeps digits only, at most 6: what a PIN field accepts while typing. */
export const cleanPin = (v: string) => v.replace(/\D/g, "").slice(0, PIN_MAX);

/** null = acceptable; otherwise the message to show. Mirrors staff_pin.validate: 4-6 digits, not all the same, not a straight run. */
export function pinProblem(pin: string): string | null {
  if (!/^\d+$/.test(pin) || pin.length < PIN_MIN || pin.length > PIN_MAX) return "Use 4 to 6 digits";
  if (/^(\d)\1+$/.test(pin)) return "Too easy to guess: avoid the same digit repeated (like 1111)";
  const d = [...pin].map(Number);
  const step = d[1] - d[0];
  if ((step === 1 || step === -1) && d.every((x, i) => i === 0 || x - d[i - 1] === step)) return "Too easy to guess: avoid runs like 1234 or 9876";
  return null;
}

// ---------------------------------------------------------------- who may do what (hides UI only; the API enforces)
export interface Viewer { id: string; role: Role | string; permissions?: string[] }
/** Older servers send no permission list: fall back to owner / manager, who hold both permissions by default. */
export const may = (me: Viewer, perm: string) => (me.permissions ? me.permissions.includes(perm) : me.role === "owner" || me.role === "manager");

/** Revoke a signed-in device: your own always; someone else's with devices.manage, and an owner's only by an owner. */
export const canRevokeDevice = (me: Viewer, d: Pick<SignedInDevice, "user_id" | "user_role">) =>
  d.user_id === me.id || (may(me, PERM_DEVICES) && (d.user_role !== "owner" || me.role === "owner"));

/** Set / reset / remove / unlock someone else's PIN: staff.pin.manage; an owner's PIN only by an owner. Your own goes through My account. */
export const canManagePinOf = (me: Viewer, target: { id: string; role: Role | string }) =>
  target.id !== me.id && may(me, PERM_PIN) && (target.role !== "owner" || me.role === "owner");

/** "Sign out everywhere" for another person (lost phone). */
export const canSignOutUser = (me: Viewer, target: { id: string; role: Role | string | null }) =>
  target.id !== me.id && may(me, PERM_DEVICES) && (target.role !== "owner" || me.role === "owner");

// ---------------------------------------------------------------- display
const PLATFORM: Record<string, string> = { android: "Android", ios: "iPhone / iPad", web: "Web browser", windows: "Windows", macos: "Mac", linux: "Linux" };
export const platformLabel = (p: string | null | undefined) => (p ? PLATFORM[p.toLowerCase()] ?? p : "Unknown");

/** A readable label for this browser, sent as X-Device-Name ("Chrome on Mac"). */
export function browserLabel(ua: string | null | undefined): string {
  if (!ua) return "Web browser";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\/|CriOS\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iPhone" : /Windows/.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : null;
  return os ? `${browser} on ${os}` : browser;
}

/** Title of a device row: its name, else model, else a label from the User-Agent. */
export const deviceTitle = (d: Pick<SignedInDevice, "name" | "model" | "user_agent">) => d.name?.trim() || d.model?.trim() || browserLabel(d.user_agent);

/** "just now", "5 min ago", "3 h ago", "2 days ago", or the date for anything older than a week. */
export function lastSeenText(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "Never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Unknown";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86400);
  if (days < 7) return days === 1 ? "Yesterday" : `${days} days ago`;
  return new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/** "Try again in 15 minutes" from a Retry-After in seconds. */
export function retryAfterText(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "Try again later.";
  if (seconds < 60) return `Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
  const m = Math.ceil(seconds / 60);
  if (m < 60) return `Try again in ${m} minute${m === 1 ? "" : "s"}.`;
  const h = Math.ceil(m / 60);
  return `Try again in ${h} hour${h === 1 ? "" : "s"}.`;
}

/** This device first, then signed-in before signed-out, then most recently seen. */
export function sortDevices<T extends Pick<SignedInDevice, "current" | "active" | "last_seen_at">>(list: T[]): T[] {
  const seen = (d: T) => (d.last_seen_at ? Date.parse(d.last_seen_at) || 0 : 0);
  return [...list].sort((a, b) => Number(b.current) - Number(a.current) || Number(b.active) - Number(a.active) || seen(b) - seen(a));
}

/** People who have at least one device in the list (for the "filter by person" picker), by name. */
export function peopleOf(list: Pick<SignedInDevice, "user_id" | "user_name" | "user_role">[]): { id: string; name: string; role: string | null }[] {
  const m = new Map<string, { id: string; name: string; role: string | null }>();
  for (const d of list) if (!m.has(d.user_id)) m.set(d.user_id, { id: d.user_id, name: d.user_name || "Unnamed", role: d.user_role ?? null });
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Rows of one person, or all ("" / null). */
export const filterByPerson = <T extends Pick<SignedInDevice, "user_id">>(list: T[], userId: string | null | undefined) => (userId ? list.filter((d) => d.user_id === userId) : list);

/** A counter device is usable while it is not revoked. */
export const counterActive = (c: Pick<CounterDevice, "revoked_at">) => !c.revoked_at;

// ---------------------------------------------------------------- step-up
/**
 * Is this API error "re-enter your PIN first"? The server answers 403 with header X-Step-Up-Required: 1 (mapped to
 * code "step_up_required" by api.ts when the header is readable). Cross-origin, the header is only readable if the API
 * exposes it (CORS expose_headers), so the message "(step-up required)" is accepted too.
 */
export function isStepUpRequired(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const x = e as { status?: number; code?: string; message?: string };
  return x.status === 403 && (x.code === "step_up_required" || /step-up required/i.test(x.message ?? ""));
}

/** A clock that only moves forward and ignores the wall clock being set (performance.now; Date.now where it does not exist). */
export const monoNow = (): number => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());

/**
 * Seconds left on a step-up grant: `expires_in` (a duration) counted from when the grant arrived, both on the MONOTONIC clock
 * (`received` and `now` are monoNow() values). The server's `expires_at` is deliberately not compared with the device clock: a device
 * clock more than 5 minutes ahead made every fresh grant look expired (a PIN prompt loop), one behind sent an expired token (QA review M1).
 * 0 = expired.
 */
export function stepUpSecondsLeft(g: { expires_in: number; received: number } | null, now: number = monoNow()): number {
  if (!g) return 0;
  return Math.max(0, Math.floor(g.expires_in - (now - g.received) / 1000));
}

/** Message for a failed PIN / password check: wrong (with attempts left), locked (Retry-After), or the server's text. */
export function stepUpFailure(status: number, opts: { attemptsLeft?: number | null; retryAfter?: number | null; message?: string; method: "pin" | "password" }): string {
  const what = opts.method === "pin" ? "PIN" : "password";
  if (status === 429) return `Too many wrong attempts. ${retryAfterText(opts.retryAfter)}${opts.method === "pin" ? " A manager can unlock your PIN." : ""}`;
  if (status === 401) {
    const n = opts.attemptsLeft;
    if (n != null && n >= 0) return n === 0 ? `Wrong ${what}. No attempts left.` : `Wrong ${what}. ${n} attempt${n === 1 ? "" : "s"} left before it locks.`;
    return `Wrong ${what}.`;
  }
  if (status === 422) return opts.method === "pin" ? "Enter your 4 to 6 digit PIN." : "Enter your password.";
  return opts.message || "Could not check it. Try again.";
}

// ---------------------------------------------------------------- this browser's device id (X-Device-Id)
const DEVICE_KEY = "pos.deviceId";
let memoryId: string | null = null;
/**
 * Random id of this browser install (not a secret, not a credential: it only lets the API say "this device" and keep it on
 * "sign out everywhere else"). Kept in localStorage so it survives sign-outs; memory only when storage is blocked.
 */
export function deviceId(store: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): string {
  try {
    const have = store?.getItem(DEVICE_KEY);
    if (have && /^[A-Za-z0-9_-]{8,100}$/.test(have)) return have;
  } catch { /* storage blocked */ }
  memoryId ??= (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, "");
  try { store?.setItem(DEVICE_KEY, memoryId); } catch { /* storage blocked */ }
  return memoryId;
}

/** Headers that describe this browser to the API (login, refresh, device list, sign out everywhere). */
export function deviceHeaders(ua: string | null | undefined = typeof navigator === "undefined" ? null : navigator.userAgent): Record<string, string> {
  return { "X-Device-Id": deviceId(), "X-Device-Name": browserLabel(ua), "X-Device-Platform": "web" };
}
