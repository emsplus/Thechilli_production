import { ApiError, authedFetch, errorFrom } from "./api";

/**
 * Password reset by emailed code (pos-service docs/EMAIL.md, PASSWORD_RESET_MODE=otp):
 *   1. POST /auth/forgot-password {email}            -> always the same 200
 *   2. POST /auth/password-reset/verify {email, otp} -> {reset_token, expires_in_seconds}
 *   3. POST /auth/password-reset/complete {email, reset_token, new_password} -> 204
 * A server in link mode (PASSWORD_RESET_MODE=link, or an older server) answers step 1 with "a reset link has been sent"; the
 * screen then keeps the old "check your email" message. These routes are public: no session is needed (a stored token is
 * harmless, they never answer 401).
 */

export type ResetMode = "otp" | "link";
/** Default gap between two codes (OTP_RESEND_SECONDS on the server). A 429 with Retry-After overrides it. */
export const RESEND_SECONDS = 60;
export const CODE_LENGTH = 6;

/**
 * Which flow the server is using, from the step 1 answer. The answer has no explicit mode field today, so the wording decides:
 * the code flow says "we have sent a code", the link flow "a reset link has been sent". An explicit `mode` wins if a later server
 * sends one. Anything else (an empty or unknown body) is treated as link mode: the email then explains itself, and the screen
 * still offers "I have a code".
 */
export function resetModeOf(body: unknown): ResetMode {
  if (body && typeof body === "object") {
    const b = body as { mode?: unknown; detail?: unknown; resend_after_seconds?: unknown };
    if (b.mode === "otp" || b.mode === "code") return "otp";
    if (b.mode === "link") return "link";
    if (typeof b.resend_after_seconds === "number") return "otp";
    if (typeof b.detail === "string") {
      if (/\blink\b/i.test(b.detail)) return "link";
      if (/\bcode\b/i.test(b.detail)) return "otp";
    }
  }
  return "link";
}

/** Seconds from a Retry-After header (seconds or an HTTP date); `fallback` when absent or unreadable. Clamped to 1..3600. */
export function retryAfterSeconds(header: string | null | undefined, fallback = RESEND_SECONDS, nowMs = Date.now()): number {
  if (!header) return fallback;
  const n = Number(header.trim());
  let s = Number.isFinite(n) ? n : Math.ceil((Date.parse(header) - nowMs) / 1000);
  if (!Number.isFinite(s)) return fallback;
  s = Math.round(s);
  return Math.min(3600, Math.max(1, s));
}

/** Keeps only digits (people paste "123 456" or "123-456" from the email), at most 6. */
export const cleanCode = (raw: string) => raw.replace(/\D/g, "").slice(0, CODE_LENGTH);
export const isFullCode = (code: string) => new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code);

/** "0:45" / "1:00" for the resend countdown. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The server's password-policy message without pydantic's "Value error, " prefix (docs/AUTH_CONTRACT.md section 4). */
export const policyMessage = (msg: string) => msg.replace(/^Value error,\s*/i, "").replace(/;\s*Value error,\s*/gi, "; ");

/** An ApiError that also carries the Retry-After seconds of a 429. */
export class ResetError extends ApiError {
  constructor(status: number, message: string, code: string | undefined, public retryAfter: number | null) { super(status, message, code); }
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const res = await authedFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const e = await errorFrom(res);
    throw new ResetError(e.status, e.message, e.code, res.status === 429 ? retryAfterSeconds(res.headers.get("Retry-After")) : null);
  }
  if (res.status === 204) return undefined as T;
  try { return await res.json() as T; } catch { return undefined as T; }
}

export const resetApi = {
  /** Step 1 (also link mode). Resolves the mode the server is in. 404 / 405 / 501: the server has no email reset. */
  async request(email: string, restaurant_id?: string): Promise<{ mode: ResetMode; resendAfter: number }> {
    const body = await call<{ resend_after_seconds?: number } | undefined>("/auth/forgot-password", { email, ...(restaurant_id ? { restaurant_id } : {}) });
    const ra = body && typeof body.resend_after_seconds === "number" ? body.resend_after_seconds : RESEND_SECONDS;
    return { mode: resetModeOf(body), resendAfter: ra };
  },
  /** Step 2. 400 = wrong or expired code (5 wrong tries kill it). */
  verify: (email: string, otp: string) => call<{ reset_token: string; expires_in_seconds: number }>("/auth/password-reset/verify", { email, otp }),
  /** Step 3. 400 = the reset session expired; 422 = password policy (message as the server words it). */
  complete: (email: string, reset_token: string, new_password: string) => call<void>("/auth/password-reset/complete", { email, reset_token, new_password }),
};
