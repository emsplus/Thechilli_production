import { cmpMoney } from "./money";
import { onlyUnpaid, type PaymentsGap } from "./takings";

export type Severity = "high" | "medium" | "low";
export interface Flag { severity: Severity; code: string; message: string }
export interface UnpaidLeak { count: number; balance: string; min_age_days: number; bills: unknown[] }
export interface UnpaidFigure { bills: number; balance: string }

/** Title of a flag row: only high / medium are "priority"; a low flag (the server marks awaiting-payment bills low) is information. */
export const flagTitle = (s: Severity): string => (s === "high" ? "High priority" : s === "medium" ? "Medium priority" : "For your information");

const isUnpaidFlag = (f: Flag) => /unpaid|awaiting|payment/i.test(f.code);

/**
 * What the Leakage "Unpaid bills" section and its informational row say. One figure for both sections: the larger of the Leakage
 * report's own count and the Payments report's, so Leakage never says "No bills are waiting for payment" while Payments lists some.
 */
export function unpaidSummary(leak: UnpaidLeak, pay?: UnpaidFigure | null): { count: number; balance: string; any: boolean; listed: number } {
  const fromPay = pay && (pay.bills > leak.count || cmpMoney(pay.balance, leak.balance) > 0) ? pay : null;
  const count = fromPay ? Math.max(fromPay.bills, leak.count) : leak.count;
  const balance = fromPay && cmpMoney(fromPay.balance, leak.balance) > 0 ? fromPay.balance : leak.balance;
  return { count, balance, any: count > 0 || cmpMoney(balance, 0) > 0, listed: leak.bills.length };
}

/** True when the server already sent a flag about unpaid bills (then no extra informational row is added). */
export const hasUnpaidFlag = (flags: Flag[]) => flags.some(isUnpaidFlag);

/**
 * A "payments differ from the amount billed" flag whose only cause is unpaid bills is information (the money is still to be collected),
 * never "High priority". Any other cause keeps the server's severity.
 */
export function flagSeverity(f: Flag, gap?: PaymentsGap | null): Severity {
  return f.code === "payments_vs_takings" && onlyUnpaid(gap) ? "low" : f.severity;
}

/**
 * Payments and Leakage both showed a "Cancelled orders" figure and could disagree (0 vs 2). The server now sends one definition; when
 * one response set still holds two different numbers, Leakage's is shown only under its own label ("Cancelled by staff") and the
 * Payments tile with the other number is not shown.
 */
export function cancelledView(payCount: number | null | undefined, leakCount: number | null | undefined): { conflict: boolean; hidePaymentsTile: boolean; leakageLabel: string } {
  const conflict = payCount != null && leakCount != null && payCount !== leakCount;
  return { conflict, hidePaymentsTile: conflict, leakageLabel: conflict ? "Cancelled by staff" : "Cancelled orders" };
}
