import { ApiError, apiRequest, authedFetch, errorFrom } from "./api";
import { formatCurrency } from "./money";

/**
 * The restaurant's Chilli: 7-day free trial, then 5 Chilli per bill from a prepaid balance; 1 rupee paid = 1 Chilli
 * (docs/CHILLI_WALLET.md). pos-service proxies platform-core for the signed-in tenant: GET /billing/wallet|ledger|usage
 * (billing.view, owner + manager), POST /billing/topups/intent and GET /billing/topups/{id} (billing.topup, owner).
 * Amounts arrive as integer paise; 1 Chilli = 100 paise. Chilli are shown as "1,250 Chilli", rupees (what is paid) as "₹2,000".
 */

/** `empty` is what a server before the grace of 20 orders called `blocked`. */
export type BillingState = "trial" | "active" | "low" | "grace" | "blocked" | "empty" | "suspended";
export type BannerCode = "trial" | "trial_ending" | "low" | "grace" | "blocked" | "empty" | "suspended";
export interface BillingBanner { level: "info" | "warning" | "critical"; code: BannerCode | string; message?: { en?: string; hi?: string } | null }
export interface BillingBlock {
  state: BillingState | string; model?: "payg" | "subscription" | string;
  trial_ends_at?: string | null; days_left?: number | null;
  balance_paise: number; per_bill_paise: number; fee_gst_mode?: "inclusive" | "exclusive" | string;
  charge_zero_bills?: boolean; low_balance_paise?: number; grace_paise?: number; min_topup_paise?: number;
  bonus_tiers?: { min_paise: number; bonus_paise: number }[];
  can_bill?: boolean; in_grace?: boolean; orders_left?: number | null; grace_orders?: number; blocked?: boolean; bills_left?: number | null; suspended_reason?: string | null;
  banner?: BillingBanner | null; topup_online?: boolean;
  /** pos-service only: fees not yet applied by platform-core (already subtracted from balance_paise), and live | stale. */
  pending_bills?: number; source?: string;
  /** Chilli view of the same numbers (1 rupee = 1 Chilli) and the recharge limits; `enforce` = new orders are refused when empty. */
  unit?: "chilli"; balance_chilli?: number; per_bill_chilli?: number; low_balance_chilli?: number; min_topup_chilli?: number;
  max_topup_paise?: number; max_topup_chilli?: number; enforce?: boolean;
}
export interface RechargeInfo { id: string; status: "created" | "paid" | "expired" | "failed" | string; amount_paise: number; chilli?: number; payment_url?: string | null; expires_at?: string | null }
export interface RechargeIntent { intent: RechargeInfo; checkout: { kind?: string; url: string; expires_at?: string | null } }
export interface RechargeStatus { intent: RechargeInfo; billing?: BillingBlock | null }
export interface WalletResponse { billing: BillingBlock | null; source: "live" | "cached" | "unavailable" | string }
export type LedgerKind = "topup" | "promo" | "void_credit_back" | "bill_fee" | "adjustment";
export interface LedgerRow {
  id: string; kind: LedgerKind | string; amount_paise: number; balance_after_paise: number; source?: string | null;
  ref_type?: string | null; ref_id?: string | null; fee_base_paise?: number | null; fee_gst_paise?: number | null;
  reason?: string | null; actor?: string | null; meta?: Record<string, unknown> | null; at: string;
}
export interface LedgerPage { items: LedgerRow[]; total: number; limit: number; offset: number }
export interface UsageStatement {
  month: string; timezone?: string; period_start?: string; period_end?: string;
  opening_balance_paise: number; closing_balance_paise: number;
  bills: { reported: number; charged: number; free_trial: number; zero_total: number; voided: number; credited_back: number };
  fees_paise: number; fee_credit_backs_paise: number; net_fees_paise: number; gst_in_net_fees_paise?: number;
  topups_paise: number; promo_paise: number; adjustments_paise: number;
  receipts?: { id: string; number: string; amount_paise: number; bonus_paise: number; created_at: string }[];
  tax_notice?: string | null;
}

// ------------------------------------------------------------------ money

/** Integer paise -> decimal rupee string ("-500" -> "-5.00"), exact (no float division). */
export function paiseToRupees(paise: number | null | undefined): string {
  const p = Math.trunc(Number(paise) || 0);
  const abs = Math.abs(p);
  return `${p < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
/** Paise as "₹1,23,456.50" (lakh / crore grouping, "-₹5.00" when negative). */
export const rupees = (paise: number | null | undefined) => formatCurrency(paiseToRupees(paise));
/** A ledger amount with an explicit sign: "+₹500.00" / "-₹5.00". */
export const signedRupees = (paise: number) => (paise > 0 ? `+${rupees(paise)}` : rupees(paise));

/** Chilli for paise (1 Chilli = 100 paise): "1,25,000" style grouping, no decimals unless the amount is not whole. */
export function chilliNumber(paise: number | null | undefined): string {
  const p = Math.trunc(Number(paise) || 0);
  const abs = Math.abs(p);
  const g = groupIndian(String(Math.floor(abs / 100)));
  const frac = abs % 100 ? `.${String(abs % 100).padStart(2, "0")}` : "";
  return `${p < 0 ? "-" : ""}${g}${frac}`;
}
/** "1,250 Chilli" ("1 Chilli" for exactly one). */
export const chilli = (paise: number | null | undefined) => `${chilliNumber(paise)} Chilli`;
/** A ledger amount with an explicit sign: "+2,000 Chilli" / "-5 Chilli". */
export const signedChilli = (paise: number) => (paise > 0 ? `+${chilli(paise)}` : chilli(paise));
function groupIndian(d: string): string {
  if (d.length <= 3) return d;
  return d.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + d.slice(-3);
}

// ------------------------------------------------------------------ states and texts

export const STATE_LABEL: Record<string, string> = { trial: "Free trial", active: "Active", low: "Low balance", grace: "Chilli used up", blocked: "Recharge needed", empty: "Recharge needed", suspended: "Billing paused" };
export const stateLabel = (s: string) => STATE_LABEL[s] ?? s;

/** Tone of the state chip / banner: info (trial), success (active), warning (low), danger (grace, blocked, suspended). */
export function stateTone(b: Pick<BillingBlock, "state" | "banner" | "days_left">): "info" | "success" | "warning" | "danger" {
  if (isBlocked(b) || b.state === "grace" || b.state === "suspended" || b.banner?.level === "critical") return "danger";
  if (b.state === "low" || b.banner?.level === "warning") return "warning";
  if (b.state === "trial") return "info";
  return "success";
}

/** What the server says in its banner (English; the UI is English only), else a plain sentence of our own. null = nothing to say. */
export function bannerText(b: BillingBlock): string | null {
  const m = b.banner?.message?.en?.trim();
  if (m) return m;
  if (!b.banner) {
    if (isBlocked(b)) return RECHARGE_TO_CONTINUE;
    if (b.state === "grace") return graceText(b);
    if (b.state === "suspended") return "Billing is paused by Chilli support. Contact support to keep making bills.";
    return null;
  }
  switch (b.banner.code) {
    case "trial": return `Free trial: ${daysText(b.days_left)} left. After it, each bill uses ${chilli(b.per_bill_paise)}.`;
    case "trial_ending": return `Your free trial ends in ${daysText(b.days_left)}. Recharge to keep billing.`;
    case "low": return "Your Chilli are running low. Recharge soon.";
    case "grace": return graceText(b);
    case "blocked": case "empty": return RECHARGE_TO_CONTINUE;
    case "suspended": return "Billing is paused by Chilli support. Contact support to keep making bills.";
    default: return null;
  }
}
/** No Chilli left and the grace is spent: new orders are refused. */
export const isBlocked = (b: Pick<BillingBlock, "state" | "blocked">) => b.state === "blocked" || b.state === "empty" || b.blocked === true;
/** In grace: orders that can still be started before billing stops (server `orders_left`, else from the balance and the grace). */
export function ordersLeft(b: BillingBlock): number | null {
  if (typeof b.orders_left === "number") return b.orders_left;
  if (b.state !== "grace" || !b.per_bill_paise) return null;
  return Math.max(0, Math.floor(((b.balance_paise ?? 0) + (b.grace_paise ?? 0)) / b.per_bill_paise));
}
export const graceText = (b: BillingBlock) => { const n = ordersLeft(b); return `${n ?? "A few"} ${n === 1 ? "order" : "orders"} left before billing stops. Recharge now.`; };
export const RECHARGE_TO_CONTINUE = "Recharge to continue. You have no Chilli left for new orders.";
export const bannerTone = (b: BillingBlock): "info" | "warning" | "danger" =>
  b.banner?.level === "critical" ? "danger" : b.banner?.level === "warning" ? "warning" : b.banner ? "info" : stateTone(b) === "danger" ? "danger" : "info";

export function daysText(n: number | null | undefined): string {
  const d = Math.max(0, Math.trunc(Number(n) || 0));
  return d === 0 ? "less than a day" : `${d} ${d === 1 ? "day" : "days"}`;
}

/** "About 18 bills" style hint. bills_left from the server wins; else balance / fee (never negative). */
export function billsLeft(b: BillingBlock): number | null {
  if (typeof b.bills_left === "number") return Math.max(0, b.bills_left);
  if (!b.per_bill_paise || b.per_bill_paise <= 0) return null;
  return Math.max(0, Math.floor(b.balance_paise / b.per_bill_paise));
}

export const KIND_LABEL: Record<string, string> = { topup: "Recharge", promo: "Bonus Chilli", void_credit_back: "Voided bill, Chilli returned", bill_fee: "Bill", adjustment: "Adjustment by Chilli support" };
export const kindLabel = (k: string) => KIND_LABEL[k] ?? k.replace(/_/g, " ");

/** Recharge may be offered only when the server says so AND the user may recharge (owner). Otherwise: "not set up yet, ask your account manager". */
export const canTopUpOnline = (b: BillingBlock | null | undefined, mayTopUp: boolean) => !!b?.topup_online && mayTopUp;
export const TOPUP_SOON = "Recharge is not set up yet. Ask your Chilli account manager.";

// ------------------------------------------------------------------ recharge amount (whole rupees; 1 rupee = 1 Chilli)

export const RECHARGE_DEFAULT = 2000;
export const RECHARGE_QUICK = [2000, 5000, 10000] as const;
export const RECHARGE_MIN_PAISE = 200_000;
export const RECHARGE_MAX_PAISE = 10_000_000;

/** "5,000" / "5000" -> 5000; anything that is not a whole number of rupees -> null. */
export function parseRechargeRupees(text: string): number | null {
  const t = text.replace(/[,\s₹]/g, "");
  if (!/^\d{1,9}$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}
/** Plain-English problem with the amount, or null when it can be paid. Limits come from the server block. */
export function rechargeProblem(text: string, b?: Pick<BillingBlock, "min_topup_paise" | "max_topup_paise"> | null): string | null {
  const n = parseRechargeRupees(text);
  const min = Math.max(b?.min_topup_paise ?? RECHARGE_MIN_PAISE, 100), max = b?.max_topup_paise ?? RECHARGE_MAX_PAISE;
  if (n === null) return "Enter a whole number of rupees, for example 2000";
  if (n * 100 < min) return `The smallest recharge is ${rupees(min).replace(/\.00$/, "")}`;
  if (n * 100 > max) return `The largest recharge is ${rupees(max).replace(/\.00$/, "")} at a time`;
  return null;
}
export const rupeesWhole = (n: number) => rupees(n * 100).replace(/\.00$/, "");

// ------------------------------------------------------------------ the counter: 402 chilli_empty on a NEW order

export const CHILLI_EMPTY_TEXT = "Recharge to continue. No Chilli left for new orders";
export const BILLING_SUSPENDED_TEXT = "Billing is paused. Contact Chilli support to keep taking new orders";

/**
 * A NEW order refused because of the Chilli balance (402 chilli_empty, or billing_suspended) -> plain English for the cashier, else
 * null. Orders that are already open keep working (billing and payment are never blocked): the message says so. `wallet_empty` is
 * the older code of the same refusal on a bill and is read the same way.
 */
export function walletBlock(e: unknown): { code: "chilli_empty" | "billing_suspended"; title: string; description: string } | null {
  if (!(e instanceof ApiError) || e.status !== 402) return null;
  const open = "Orders that are already open can still be billed and paid.";
  if (e.code === "billing_suspended") return { code: "billing_suspended", title: BILLING_SUSPENDED_TEXT, description: open };
  return { code: "chilli_empty", title: CHILLI_EMPTY_TEXT, description: `${open} Ask the owner to recharge.` };
}

// ------------------------------------------------------------------ API

const q = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** A server without the wallet routes (older pos-service): 404 / 405 / 501. The UI hides the credit parts. */
export const billingMissing = (e: unknown) => e instanceof ApiError && (e.status === 405 || e.status === 501 || (e.status === 404 && /^not found\.?$/i.test(e.message.trim())));

export const billingApi = {
  wallet: () => apiRequest<WalletResponse>("/billing/wallet"),
  ledger: (f: { from?: string; to?: string; kind?: string; limit?: number; offset?: number } = {}) =>
    apiRequest<LedgerPage>(`/billing/ledger${q({ from: f.from, to: f.to, kind: f.kind, limit: f.limit ?? 50, offset: f.offset ?? 0 })}`),
  usage: (month?: string) => apiRequest<UsageStatement>(`/billing/usage${q({ month, format: "json" })}`),
  async usageCsv(month: string): Promise<Blob> {
    const res = await authedFetch(`/billing/usage${q({ month, format: "csv" })}`);
    if (!res.ok) throw await errorFrom(res, "Could not download the statement");
    return res.blob();
  },
  /** Creates a Razorpay payment link: `checkout.url` is where the owner pays; poll `intent.id` with topupStatus afterwards. */
  topupIntent: (amount_paise: number) => apiRequest<RechargeIntent>("/billing/topups/intent", { method: "POST", body: JSON.stringify({ amount_paise }) }),
  topupStatus: (id: string) => apiRequest<RechargeStatus>(`/billing/topups/${encodeURIComponent(id)}`),
};

/** "2026-11" for a date in the restaurant's time zone (statement months are Asia/Kolkata on the server). */
export function monthOf(d: Date, tz = "Asia/Kolkata"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? String(d.getFullYear());
  const m = parts.find((p) => p.type === "month")?.value ?? String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
/** The month before / after "YYYY-MM". */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const i = y * 12 + (m - 1) + by;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}
