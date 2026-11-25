/**
 * PAYG credit math, mirrored from platform-core app/services/wallet.py (state_of, Effective.fee, view, bonus_for) so the
 * confirm step can show what the server WILL do before anything is sent. The server stays the authority: every preview is
 * labelled as such and the real result (the response's `billing` block) replaces it. Also used by the mock backend, so mock
 * mode and live mode compute the same states. Integer paise only, no floats on money.
 */
import type { BillingModel, BillingState, BonusTier, FeeGstMode, LedgerKind } from "./api/types";

export const DAY_MS = 86_400_000;
/** platform-core GST_RATE_BPS default (18%). The admin API does not return the rate; only exclusive-mode previews use it. */
export const GST_RATE_BPS = 1800;
/** platform-core AdjustIn: |amount_paise| <= 10**10 (Rs 10 crore). */
export const MAX_ADJUST_PAISE = 10_000_000_000;
/** platform-core SettingsIn bounds. */
export const MAX_PER_BILL_PAISE = 100_000;
export const MAX_GRACE_PAISE = 100_000_000;
export const MAX_TRIAL_DAYS = 365;
/** platform-core: reason min 3, max 500; Idempotency-Key 8-100 characters. */
export const REASON_MIN = 3;
export const REASON_MAX = 500;

export const LEDGER_KINDS: readonly LedgerKind[] = ["topup", "promo", "void_credit_back", "bill_fee", "adjustment"];
export const KIND_LABEL: Record<LedgerKind, string> = {
  topup: "Top-up", promo: "Promo credit", void_credit_back: "Void credit back", bill_fee: "Bill fee", adjustment: "Adjustment",
};
export const STATE_LABEL: Record<BillingState, string> = { trial: "Free trial", active: "Active", low: "Low credit", empty: "Credit exhausted", suspended: "Billing paused" };

export interface FeeRules {
  billing_model: BillingModel; per_bill_paise: number; fee_gst_mode: FeeGstMode; low_balance_paise: number; grace_paise: number;
}
export interface WalletFacts { balance_paise: number; trial_ends_at: string; suspended: boolean }

/** [debit, base excl. GST, GST] of one bill; same integer rounding as platform-core Effective.fee(). */
export function feeSplit(perBill: number, mode: FeeGstMode, rateBps = GST_RATE_BPS): [number, number, number] {
  if (perBill <= 0) return [0, 0, 0];
  if (mode === "exclusive") { const gst = Math.floor((perBill * rateBps + 5000) / 10000); return [perBill + gst, perBill, gst]; }
  const base = Math.floor((2 * perBill * 10000 + (10000 + rateBps)) / (2 * (10000 + rateBps)));
  return [perBill, base, perBill - base];
}
export const debitPerBill = (r: Pick<FeeRules, "per_bill_paise" | "fee_gst_mode">, rateBps = GST_RATE_BPS) => feeSplit(r.per_bill_paise, r.fee_gst_mode, rateBps)[0];

/** platform-core state_of(). */
export function creditState(w: WalletFacts, r: FeeRules, nowMs = Date.now(), rateBps = GST_RATE_BPS): BillingState {
  if (w.suspended) return "suspended";
  if (r.billing_model !== "payg") return "active";
  if (nowMs < Date.parse(w.trial_ends_at)) return "trial";
  const debit = debitPerBill(r, rateBps);
  if (w.balance_paise - debit < -r.grace_paise) return "empty";
  if (w.balance_paise < r.low_balance_paise || w.balance_paise < debit) return "low";
  return "active";
}

export interface Projection { state: BillingState; bills_left: number | null; in_grace: boolean; debit_paise: number }
/** The parts of platform-core view() the confirm step shows: state, bills left (incl. grace), grace flag. */
export function project(w: WalletFacts, r: FeeRules, nowMs = Date.now(), rateBps = GST_RATE_BPS): Projection {
  const state = creditState(w, r, nowMs, rateBps);
  const debit = debitPerBill(r, rateBps);
  const metered = r.billing_model === "payg";
  const bills_left = metered && debit > 0 && state !== "trial" && state !== "suspended" ? Math.max(0, Math.floor((w.balance_paise + r.grace_paise) / debit)) : null;
  return { state, bills_left, in_grace: metered && (state === "low" || state === "empty") && w.balance_paise < debit, debit_paise: debit };
}

/** platform-core Effective.bonus_for(): the highest tier whose minimum the amount reaches. */
export function bonusFor(tiers: readonly BonusTier[], amountPaise: number): number {
  let best = 0;
  for (const t of [...tiers].sort((a, b) => a.min_paise - b.min_paise)) if (amountPaise >= t.min_paise) best = t.bonus_paise;
  return best;
}

export type AdjustMode = "topup" | "promo" | "deduct" | "add_back";
export interface AdjustPreview {
  kind: "topup" | "promo" | "adjustment"; amount_paise: number; bonus_paise: number; before_paise: number; after_paise: number;
  /** The server refuses this (409 would_go_negative) unless allow_negative is sent. */
  goes_negative: boolean; projection: Projection;
}
/** What an admin credit change will do. `amountPaise` is always the positive amount typed; `deduct` makes it negative. */
export function previewAdjust(mode: AdjustMode, amountPaise: number, w: WalletFacts, r: FeeRules & { bonus_tiers: readonly BonusTier[] }, nowMs = Date.now()): AdjustPreview {
  const kind = mode === "topup" || mode === "promo" ? mode : "adjustment";
  const amount = mode === "deduct" ? -amountPaise : amountPaise;
  const bonus = mode === "topup" ? bonusFor(r.bonus_tiers, amountPaise) : 0;
  const after = w.balance_paise + amount + bonus;
  return { kind, amount_paise: amount, bonus_paise: bonus, before_paise: w.balance_paise, after_paise: after, goes_negative: amount < 0 && w.balance_paise + amount < 0, projection: project({ ...w, balance_paise: after }, r, nowMs) };
}

export type AmountCheck = { ok: true; paise: number } | { ok: false; error: string };
/** Validates a typed positive rupee amount (already parsed to paise, or null when unparsable). */
export function checkAmount(paise: bigint | number | null, max = MAX_ADJUST_PAISE): AmountCheck {
  if (paise === null) return { ok: false, error: "Enter an amount in rupees, e.g. 500 or 499.50." };
  const n = Number(paise);
  if (!(n > 0)) return { ok: false, error: "Enter an amount above zero." };
  if (n > max) return { ok: false, error: "That is above the largest amount the server accepts." };
  return { ok: true, paise: n };
}
export const reasonError = (reason: string) => {
  const n = reason.trim().length;
  return n < REASON_MIN ? `Give a reason of at least ${REASON_MIN} characters.` : n > REASON_MAX ? `Keep the reason under ${REASON_MAX} characters.` : undefined;
};

export type TrialPlan = { ok: true; trial_days: number; new_end: string } | { ok: false; error: string };
/**
 * platform-core moves the trial end to trial start + trial_days (PUT billing-settings), so "extend by N days" becomes a
 * trial_days value: N days after the later of now and the current end, rounded up to whole days from the trial start.
 */
export function planTrialExtension(trialStartedAt: string, trialEndsAt: string, extraDays: number, nowMs = Date.now()): TrialPlan {
  if (!Number.isInteger(extraDays) || extraDays < 1) return { ok: false, error: "Enter a whole number of days, 1 or more." };
  const start = Date.parse(trialStartedAt);
  const target = Math.max(nowMs, Date.parse(trialEndsAt)) + extraDays * DAY_MS;
  const days = Math.ceil((target - start) / DAY_MS);
  if (days > MAX_TRIAL_DAYS) {
    const last = new Date(start + MAX_TRIAL_DAYS * DAY_MS).toISOString();
    return { ok: false, error: `A trial can last at most ${MAX_TRIAL_DAYS} days from its start, so it cannot end after ${last.slice(0, 10)}.` };
  }
  return { ok: true, trial_days: days, new_end: new Date(start + days * DAY_MS).toISOString() };
}

/**
 * What the Credit panel says about two-step. It never blocks anything: platform-core decides per action (403 step_up_required)
 * and the app-wide "Confirm with your code" dialog answers it (src/lib/step-up.ts). The hint only sets expectations:
 *  - "confirm": the account has two-step, so each change asks for a fresh code;
 *  - "tip": no two-step set up (an optional role), so the server asks for nothing; recommend turning it on;
 *  - "none": not known (status not loaded): say nothing.
 */
export type StepUpHint = "confirm" | "tip" | "none";
export function stepUpHint(mfa: { required: boolean; enrolled: boolean } | undefined): StepUpHint {
  if (!mfa) return "none";
  return mfa.required || mfa.enrolled ? "confirm" : "tip";
}
