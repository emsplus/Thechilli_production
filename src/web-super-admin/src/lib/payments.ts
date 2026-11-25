/** Collections maths for the Payments page. Integer paise throughout; dates compared as instants. */
import type { Invoice, Payment, PaymentStatus, UsageStatement } from "./api/types";

/** platform-core caps a page at 200 and GET /payments has no status or date filter: the page works on the newest 200. */
export const PAYMENTS_WINDOW = 200;

export function paymentTotals(items: Payment[]) {
  const sum = (s: PaymentStatus) => items.filter((p) => p.status === s).reduce((a, p) => a + p.amount_paise, 0);
  const count = (s: PaymentStatus) => items.filter((p) => p.status === s).length;
  return { received_paise: sum("succeeded"), refunded_paise: sum("refunded"), failed: count("failed"), pending: count("initiated") };
}

/** Issued invoices past their due date, most overdue first, with whole days overdue. */
export function overdue(invoices: Invoice[], nowMs = Date.now()): (Invoice & { days_overdue: number })[] {
  return invoices
    .filter((i) => i.status === "issued" && i.due_at && Date.parse(i.due_at) < nowMs)
    .map((i) => ({ ...i, days_overdue: Math.floor((nowMs - Date.parse(i.due_at!)) / 86_400_000) }))
    .sort((a, b) => b.days_overdue - a.days_overdue);
}

export function usageTotals(items: UsageStatement[]) {
  const s = (k: "topups_paise" | "promo_paise" | "net_fees_paise" | "adjustments_paise" | "closing_balance_paise") => items.reduce((a, r) => a + r[k], 0);
  return { topups_paise: s("topups_paise"), promo_paise: s("promo_paise"), net_fees_paise: s("net_fees_paise"), adjustments_paise: s("adjustments_paise"), closing_balance_paise: s("closing_balance_paise") };
}

/** Businesses whose credit closed the month below zero (they are billing on grace or blocked). */
export const negativeCredit = (items: UsageStatement[]) => items.filter((r) => r.closing_balance_paise < 0).sort((a, b) => a.closing_balance_paise - b.closing_balance_paise);

/** Current month in IST (the billing timezone), "YYYY-MM". */
export const istMonth = (nowMs = Date.now()) => new Date(nowMs + 5.5 * 3600_000).toISOString().slice(0, 7);
