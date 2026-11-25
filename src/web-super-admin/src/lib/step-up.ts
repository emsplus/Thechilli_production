/**
 * Per-action step-up ("Confirm with your code"), pure logic. platform-core answers a protected action with
 * 403 step_up_required; the person enters a fresh authenticator (or recovery) code; POST /auth/step-up returns a short-lived,
 * single-use grant; the original request is repeated once with `X-Step-Up-Token`. docs/STEP_UP_UI_STATUS.md.
 *
 * The grant lives in memory only (never in a cookie, localStorage or sessionStorage), is single use and is dropped when it
 * expires or the page is left. Nothing in here touches React or the network.
 */
import { ApiError } from "./api/client";

export const STEP_UP_HEADER = "X-Step-Up-Token";
export const CANCELLED_CODE = "step_up_cancelled";

/** A grant as returned by POST /auth/step-up, reduced to what the client needs. */
export interface StepUpGrant { token: string; expiresAtMs: number }

export interface StepUpGrantOut { step_up_token: string; header: string; expires_in: number; expires_at: string; uses: number; method: "totp" | "recovery_code"; recovery_codes_remaining?: number }

export function grantFromResponse(out: StepUpGrantOut, nowMs = Date.now()): StepUpGrant {
  return { token: out.step_up_token, expiresAtMs: nowMs + Math.max(0, out.expires_in) * 1000 };
}

/** 403 step_up_required (platform-core also sets X-Step-Up-Required: true). Never a plain 403 forbidden: a missing permission needs no code. */
export const isStepUpRequired = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 403 && e.code === "step_up_required";
export const isStepUpCancelled = (e: unknown): e is ApiError => e instanceof ApiError && e.code === CANCELLED_CODE;
export const stepUpCancelled = () => new ApiError(403, CANCELLED_CODE, "Not confirmed, so nothing was changed.");

/* ---------------- what the person is confirming ---------------- */

const seg = "[^/]+";
const ACTIONS: [string, RegExp, string][] = [
  ["POST", new RegExp(`^/admin/tenants/${seg}/wallet/adjust$`), "Change a business's credit"],
  ["POST", new RegExp(`^/admin/tenants/${seg}/wallet/suspend$`), "Pause a business's billing"],
  ["POST", new RegExp(`^/admin/tenants/${seg}/wallet/resume$`), "Resume a business's billing"],
  ["PUT", new RegExp(`^/admin/(tenants|plans)/${seg}/billing-settings$`), "Change billing settings"],
  ["POST", new RegExp(`^/invoices/${seg}/void$`), "Void an invoice"],
  ["POST", new RegExp(`^/payments(/${seg}/status)?$`), "Record a payment"],
  ["POST", new RegExp(`^/plans/${seg}/(retire|reactivate)$`), "Change a plan"],
  ["PUT", new RegExp(`^/plans/${seg}$`), "Edit a plan"],
  ["PATCH", new RegExp(`^/plans/${seg}$`), "Edit a plan"],
  ["POST", new RegExp(`^/tenants/${seg}/suspend$`), "Suspend a business"],
  ["POST", new RegExp(`^/tenants/${seg}/reactivate$`), "Reactivate a business"],
  ["POST", new RegExp(`^/tenants/${seg}/close$`), "Close a business"],
  ["PUT", new RegExp(`^/entitlements/${seg}/overrides/${seg}$`), "Change a feature override"],
  ["DELETE", new RegExp(`^/entitlements/${seg}/overrides/${seg}$`), "Remove a feature override"],
  ["POST", /^\/staff$/, "Add a staff member"],
  ["PATCH", new RegExp(`^/staff/${seg}$`), "Change a staff member's role or access"],
  ["POST", new RegExp(`^/staff/${seg}/reset-password$`), "Reset a staff password"],
  ["POST", new RegExp(`^/staff/${seg}/mfa/reset$`), "Reset a staff member's two-step"],
  ["DELETE", new RegExp(`^/staff/${seg}/sessions$`), "Sign a staff member out everywhere"],
  ["POST", /^\/service-clients(\/[^/]+\/revoke)?$/, "Change a service client"],
  ["POST", /^\/support-access\/grants$/, "Approve support access"],
  ["PUT", new RegExp(`^/config/${seg}$`), "Change platform configuration"],
  ["DELETE", new RegExp(`^/config/${seg}$`), "Delete a platform setting"],
];

/** Plain-language name of the action behind a request, for the dialog ("Change a business's credit"). Unknown routes get a generic one. */
export function describeAction(method: string, path: string): string {
  const p = path.split("?")[0];
  return ACTIONS.find(([m, re]) => m === method.toUpperCase() && re.test(p))?.[2] ?? "This action";
}

/** Grants are kept per action (method + path) so an unspent one can be retried for the same action only. */
export const actionKey = (method: string, path: string) => `${method.toUpperCase()} ${path.split("?")[0]}`;

/* ---------------- the code the person types ---------------- */

export type CodeMode = "totp" | "recovery";

/** What stays in the field: totp = digits only (max 6, so "123 456" pastes cleanly); recovery = letters, digits and dashes, upper-case. */
export function cleanCode(raw: string, mode: CodeMode): string {
  if (mode === "totp") return raw.replace(/\D/g, "").slice(0, 6);
  return raw.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 40);
}
/** Message for a code that is not worth sending, or null. */
export function codeProblem(code: string, mode: CodeMode): string | null {
  if (mode === "totp") return /^\d{6}$/.test(code) ? null : "Enter the 6-digit code from your authenticator app.";
  return code.replace(/-/g, "").length >= 10 ? null : "Enter one of your recovery codes, for example ABCDE-FGHJK-LMNPQ.";
}

export function formatWait(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `${s} ${s === 1 ? "second" : "seconds"}`;
  const m = Math.floor(s / 60), r = s % 60;
  return r === 0 ? `${m} min` : `${m} min ${r} s`;
}

export type StepUpFailure =
  | { kind: "wrong_code"; message: string }
  | { kind: "locked"; message: string; retryAfterSeconds: number }
  | { kind: "not_enrolled"; message: string }
  | { kind: "session"; message: string }
  | { kind: "other"; message: string };

/** Turns a failed POST /auth/step-up into what the dialog says and does. */
export function classifyStepUpError(e: unknown, mode: CodeMode = "totp"): StepUpFailure {
  if (!(e instanceof ApiError)) return { kind: "other", message: "Something went wrong. Try again." };
  if (e.status === 400 && e.code === "invalid_code") {
    return { kind: "wrong_code", message: mode === "recovery" ? "That recovery code is not valid, or it was already used. Check it and try again." : "That code did not work. It may be wrong or already used: wait for the next code in your app and try again." };
  }
  if (e.status === 429) {
    const s = e.retryAfterSeconds ?? 300;
    return { kind: "locked", retryAfterSeconds: s, message: "Too many wrong codes." };
  }
  if (e.status === 409 && e.code === "mfa_not_enrolled") return { kind: "not_enrolled", message: "Two-step verification is not set up for your account, so this action cannot be confirmed." };
  if (e.status === 401) return { kind: "session", message: "Your session ended. Sign in again." };
  if (e.status === 422) return { kind: "wrong_code", message: mode === "recovery" ? "Enter a valid recovery code." : "Enter the 6-digit code from your authenticator app." };
  if (e.status === 0) return { kind: "other", message: "Cannot reach the server. Check your connection and try again." };
  return { kind: "other", message: e.status >= 500 ? "The server had a problem. Try again in a moment." : e.message };
}

/* ---------------- in-memory grants ---------------- */

const SKEW_MS = 2000; // a grant about to expire is treated as expired: it could lapse before the request arrives
const MAX_HELD = 8;

/** Unspent grants, in memory, per action. `take` hands a grant out once. Not persisted anywhere. */
export class GrantStore {
  private held = new Map<string, StepUpGrant>();
  constructor(private now: () => number = Date.now) {}
  put(key: string, g: StepUpGrant) {
    this.sweep();
    if (g.expiresAtMs - SKEW_MS <= this.now()) return;
    this.held.delete(key);
    this.held.set(key, g);
    while (this.held.size > MAX_HELD) this.held.delete(this.held.keys().next().value as string);
  }
  take(key: string): StepUpGrant | null {
    const g = this.held.get(key);
    this.held.delete(key);
    return g && g.expiresAtMs - SKEW_MS > this.now() ? g : null;
  }
  clear() { this.held.clear(); }
  get size() { this.sweep(); return this.held.size; }
  private sweep() { for (const [k, g] of this.held) if (g.expiresAtMs - SKEW_MS <= this.now()) this.held.delete(k); }
}

/* ---------------- the retry wrapper ---------------- */

/** A grant on loan for one retry. `settle(false)` says the action failed without using it up (platform-core rolls the use back), so it can be offered again. */
export interface HeldGrant { token: string; settle: (spent: boolean) => void }
export interface StepUpProvider { acquire: (key: string) => Promise<HeldGrant | null> }

/**
 * Runs `attempt()`; on 403 step_up_required asks the provider for a grant (dialog or a still-valid unspent one) and repeats the
 * request ONCE with it. The same request (and Idempotency-Key) is repeated, so a retry can never apply an action twice.
 * No provider, `enabled: false`, or the person cancelling: the original error / a "not confirmed" error is thrown.
 */
export async function retryWithStepUp<T>(key: string, attempt: (stepUpToken?: string) => Promise<T>, provider?: StepUpProvider, enabled = true): Promise<T> {
  try {
    return await attempt();
  } catch (first) {
    if (!enabled || !provider || !isStepUpRequired(first)) throw first;
    const held = await provider.acquire(key);
    if (!held) throw stepUpCancelled();
    try {
      const out = await attempt(held.token);
      held.settle(true);
      return out;
    } catch (second) {
      // Still asked for a code: the grant is bad or spent. Any other failure rolled back, so the grant is unspent.
      held.settle(isStepUpRequired(second));
      throw second;
    }
  }
}
