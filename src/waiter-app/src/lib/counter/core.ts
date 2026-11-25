/**
 * Shared counter tablet ("phase B"): pure client for the staff PIN API (pos-service docs/STAFF_PIN_DEVICES_API.md, section 3).
 * No React, no storage: `fetch` and the API base are passed in so the rules are unit-tested (core.test.ts).
 *
 * The tablet holds only the counter credential (cdt_..., from business-admin > Devices). A staff member taps their name,
 * types their PIN and gets a short PIN session: an access token with no refresh token, idle 15 min, max 12 h, confined to
 * the tablet's outlet. When it ends (401 + X-Session-Locked) the tablet goes back to the roster.
 */
import { elapsed, type Tick } from "../clock";

export interface CounterStaff { id: string; name: string; role: string; initials: string }
export interface CounterDevice { id: string; name: string; outlet_id: string; outlet_name: string; restaurant_name: string }
export interface Roster { device: CounterDevice; staff: CounterStaff[] }
export interface PinSession {
  access: string; sessionId: string; outletId: string; counterDeviceId: string; expiresAt: string | null;
  idleSeconds: number; user: CounterStaff; pinChangeSuggested: boolean;
}

export type RosterResult = { ok: true; roster: Roster } | { ok: false; reason: "removed" | "offline" | "unsupported" | "error"; detail?: string };
export type PinLoginResult =
  | { ok: true; session: PinSession }
  | { ok: false; reason: "wrong"; attemptsLeft: number | null }
  | { ok: false; reason: "locked"; retryAfterSec: number | null }
  | { ok: false; reason: "removed" | "offline" | "unsupported" | "error"; detail?: string };
export type LogoutReason = "logout" | "idle_lock" | "switch_user";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const TOKEN_RE = /^cdt_[A-Za-z0-9_-]{20,200}$/;
/** What the manager pasted (or a QR decoded): trimmed; anything that is not a cdt_ credential is refused before any request. */
export function normaliseDeviceToken(raw: string): string | null {
  const t = raw.trim().replace(/^["']|["']$/g, "");
  return TOKEN_RE.test(t) ? t : null;
}

const detailOf = async (res: Response): Promise<string | undefined> => {
  try { const b = (await res.json()) as { detail?: unknown }; return typeof b.detail === "string" ? b.detail : undefined; } catch { return undefined; }
};

export async function fetchRoster(f: Fetch, base: string, deviceToken: string): Promise<RosterResult> {
  let res: Response;
  try { res = await f(`${base}/devices/counter/roster`, { headers: { "X-Counter-Token": deviceToken } }); } catch { return { ok: false, reason: "offline" }; }
  if (res.ok) return { ok: true, roster: (await res.json()) as Roster };
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "removed" };
  if (res.status === 404 || res.status === 405 || res.status === 501) return { ok: false, reason: "unsupported" };
  if (res.status >= 500) return { ok: false, reason: "offline" };
  return { ok: false, reason: "error", detail: await detailOf(res) };
}

interface PinLoginBody {
  access_token: string; session_id: string; expires_at?: string | null; idle_timeout_seconds?: number; outlet_id: string;
  counter_device_id: string; user: CounterStaff; pin_change_suggested?: boolean;
}

export async function pinLogin(f: Fetch, base: string, deviceToken: string, userId: string, pin: string, headers: Record<string, string> = {}): Promise<PinLoginResult> {
  let res: Response;
  try {
    res = await f(`${base}/auth/pin-login`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Counter-Token": deviceToken },
      body: JSON.stringify({ user_id: userId, pin }),
    });
  } catch { return { ok: false, reason: "offline" }; }
  if (res.ok) {
    const b = (await res.json()) as PinLoginBody;
    return {
      ok: true,
      session: {
        access: b.access_token, sessionId: b.session_id, outletId: b.outlet_id, counterDeviceId: b.counter_device_id,
        expiresAt: b.expires_at ?? null, idleSeconds: b.idle_timeout_seconds ?? 900, user: b.user, pinChangeSuggested: !!b.pin_change_suggested,
      },
    };
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get("Retry-After"));
    return { ok: false, reason: "locked", retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : null };
  }
  if (res.status === 401) {
    const detail = await detailOf(res);
    if (detail === "Invalid device credential") return { ok: false, reason: "removed" };
    const left = res.headers.get("X-Pin-Attempts-Left");
    return { ok: false, reason: "wrong", attemptsLeft: left === null || left === "" || !Number.isFinite(Number(left)) ? null : Number(left) };
  }
  if (res.status === 404 || res.status === 405 || res.status === 501) return { ok: false, reason: "unsupported" };
  if (res.status >= 500) return { ok: false, reason: "offline" };
  return { ok: false, reason: "error", detail: await detailOf(res) };
}

/** Best effort: the server ends the session even if it is already idle; a network failure is ignored (it idles out). */
export async function pinLogout(f: Fetch, base: string, access: string, reason: LogoutReason): Promise<void> {
  try {
    await f(`${base}/auth/pin-logout`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` }, body: JSON.stringify({ reason }) });
  } catch { /* offline: the server-side idle timer ends it */ }
}

/** Client idle lock: the server idles at `idleSeconds`; the tablet locks a little earlier so the next tap never hits a dead session. */
export function idleLockMs(idleSeconds: number): number {
  const s = Number.isFinite(idleSeconds) && idleSeconds > 0 ? idleSeconds : 900;
  return Math.max(30_000, (s - 30) * 1000);
}

/** Idle lock check. Pass `Tick`s (lib/clock.ts): a wall clock set back since the last touch locks instead of keeping the tablet open. */
export function shouldIdleLock(lastActivity: Tick | number, now: Tick | number, idleSeconds: number): boolean {
  const e = elapsed(lastActivity, now);
  return e.rolledBack || e.ms >= idleLockMs(idleSeconds);
}

export function wrongPinMessage(attemptsLeft: number | null): string {
  if (attemptsLeft === null) return "Wrong PIN.";
  if (attemptsLeft <= 0) return "Wrong PIN. Your PIN is now locked: ask a manager.";
  return `Wrong PIN. ${attemptsLeft === 1 ? "1 try left." : `${attemptsLeft} tries left.`}`;
}

export function lockedMessage(retryAfterSec: number | null): string {
  if (!retryAfterSec) return "PIN locked after too many wrong tries. Ask a manager to unlock it.";
  const m = Math.ceil(retryAfterSec / 60);
  return `PIN locked after too many wrong tries. Try again in ${m} min or ask a manager.`;
}
