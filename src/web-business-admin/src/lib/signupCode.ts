import { ApiError } from "./api";

/**
 * Sign-up email code (pos-service docs/EMAIL.md, SIGNUP_EMAIL_VERIFICATION=true): pure helpers behind
 * src/components/auth/SignupCodeStep.tsx, kept here so they are unit-tested without a DOM.
 */
export const CODE_LENGTH = 6;
export const DEFAULT_RESEND_SECONDS = 60;
/** Wall clock for the countdowns (event handlers only; a module function keeps the React compiler's purity check quiet). */
export const clockNow = () => Date.now();

/**
 * Types or pastes `input` into box `index`: one character fills that box; several (paste, SMS / mail autofill into the
 * first box) fill from `index` onwards. Returns the new boxes and the box to focus next (the last box when full).
 */
export function fillCode(boxes: readonly string[], index: number, input: string): { boxes: string[]; focus: number } {
  const next = [...boxes];
  const digits = input.replace(/\D/g, "");
  if (!digits) return { boxes: next, focus: index };
  // A full code pasted anywhere replaces everything: nobody means "the second half of my code".
  const start = digits.length >= CODE_LENGTH ? 0 : index;
  let i = start;
  for (const d of digits.slice(0, CODE_LENGTH - start)) next[i++] = d;
  return { boxes: next, focus: Math.min(i, CODE_LENGTH - 1) };
}

export const emptyCode = () => Array.from({ length: CODE_LENGTH }, () => "");
export const isComplete = (boxes: readonly string[]) => boxes.every((b) => /^\d$/.test(b));

/** "0:42" for the resend button; minutes once it is a long wait (hourly limits). */
export function formatWait(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s >= 120) return `${Math.ceil(s / 60)} minutes`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Seconds from a 429's Retry-After (set by src/lib/api.ts on the sign-up code calls). */
export const retryAfterOf = (e: unknown): number | undefined => {
  const r = (e as { retryAfter?: unknown } | null)?.retryAfter;
  return typeof r === "number" && r > 0 ? r : undefined;
};

const OFFLINE = "Cannot reach the server. Check your internet connection and try again.";
const SERVER = "The server had a problem. Please try again in a moment.";

/**
 * POST /auth/verify-email failures. Every bad code is the same 400 (wrong, expired, or dead after 5 wrong tries), so the
 * message always points at Resend code; 429 is the per-network hourly limit on code checks.
 */
export function verifyErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong. Please try again.";
  if (e.status === 0) return OFFLINE;
  if (e.status === 400) return "That code is wrong or has expired. Check the newest email, or tap Resend code to get a new one. After 5 wrong tries a code stops working.";
  if (e.status === 422) return `Enter the ${CODE_LENGTH}-digit code from the email.`;
  if (e.status === 429) {
    const w = retryAfterOf(e);
    return `Too many code attempts from this network. ${w ? `Try again in ${formatWait(w)}.` : "Please wait a while and try again."}`;
  }
  if (e.status >= 500) return SERVER;
  return e.message || "Something went wrong. Please try again.";
}

/** POST /auth/verify-email/resend failures; `wait` (seconds) restarts the resend countdown. */
export function resendError(e: unknown): { message: string; wait?: number } {
  if (!(e instanceof ApiError)) return { message: "Something went wrong. Please try again." };
  if (e.status === 0) return { message: OFFLINE };
  if (e.status === 429) {
    const wait = retryAfterOf(e) ?? DEFAULT_RESEND_SECONDS;
    return { message: wait > DEFAULT_RESEND_SECONDS ? `Too many codes requested. You can ask for another in ${formatWait(wait)}.` : "Please wait before asking for another code.", wait };
  }
  if (e.status >= 500) return { message: SERVER };
  return { message: e.message || "Could not send a new code. Please try again." };
}
