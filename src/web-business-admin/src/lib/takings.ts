import { cmpMoney, formatCurrency } from "./money";

/**
 * X / Z report money (pos-service docs/REPORTS.md "Total takings, billed total and the payments gap").
 * New server: `deductions.total_takings` = money RECEIVED, `deductions.billed_total` = what was invoiced (unpaid bills included),
 * `deductions.takings.billed_not_received` = the difference, `checks_info.payments_gap` = the real causes of payments vs billed.
 * Older server: none of those fields; `total_takings` is the billed figure and the screens say what they always said.
 */
export interface GapCause { code: string; label?: string; count: number; amount: string }
export interface PaymentsGap { difference?: string; causes: GapCause[]; unexplained?: string; explained?: boolean }
interface DeductionsLike { total_takings: string; billed_total?: string; takings?: { payments: string; refunds_paid: string; billed_not_received: string } }

/** The server sends the split (billed_total present). */
export const hasTakingsSplit = (d: DeductionsLike): boolean => typeof d.billed_total === "string";
/** What was billed: `billed_total`, or on an older server the figure it called `total_takings`. */
export const billedOf = (d: DeductionsLike): string => d.billed_total ?? d.total_takings;
/** Billed but not received (unpaid bills): null on an older server. */
export const notReceivedOf = (d: DeductionsLike): string | null => (hasTakingsSplit(d) ? d.takings?.billed_not_received ?? null : null);

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
/** "-₹760.00" / "+₹120.00": the cause's signed contribution to payments minus billed. */
export const signedMoney = (amount: string, currency?: string | null): string =>
  cmpMoney(amount, 0) < 0 ? `-${formatCurrency(amount.replace("-", ""), currency)}` : `+${formatCurrency(amount, currency)}`;

/** One plain sentence per cause code, with its own signed amount. Unknown codes use the server's label. */
export function causeText(c: GapCause, currency?: string | null): string {
  const amt = signedMoney(c.amount, currency);
  switch (c.code) {
    case "unpaid_bills": return `Unpaid bills of this period: ${n(c.count, "bill", "bills")}, ${amt}`;
    case "settled_other_period": return `Money received for bills of an earlier period: ${n(c.count, "bill", "bills")}, ${amt}`;
    case "refunds": return `Refunds paid out: ${n(c.count, "refund", "refunds")}, ${amt}`;
    case "corrections": return `Corrected bills: ${n(c.count, "bill", "bills")}, ${amt}`;
    case "voided_bills": return `Bills voided in this period: ${n(c.count, "bill", "bills")}, ${amt}`;
    default: return `${c.label ?? c.code}: ${amt}`;
  }
}

/** Lines under the Payments block of the report; null = the server did not send the gap (fall back to the old sentence). */
export function gapLines(gap: PaymentsGap | null | undefined, currency?: string | null): { causes: { code: string; text: string }[]; unexplained: string | null } | null {
  if (!gap || !Array.isArray(gap.causes)) return null;
  const un = gap.unexplained && cmpMoney(gap.unexplained, 0) !== 0 ? `Unexplained: ${formatCurrency(gap.unexplained, currency)}` : null;
  return { causes: gap.causes.map((c) => ({ code: c.code, text: causeText(c, currency) })), unexplained: un };
}

/** A gap of unpaid bills only (nothing unexplained) is not a leak: the screens show it as information. */
export const onlyUnpaid = (gap: PaymentsGap | null | undefined): boolean =>
  !!gap && gap.causes.length > 0 && gap.causes.every((c) => c.code === "unpaid_bills") && (!gap.unexplained || cmpMoney(gap.unexplained, 0) === 0);
