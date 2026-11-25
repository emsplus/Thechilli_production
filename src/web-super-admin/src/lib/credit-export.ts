import { parseRupees, toCsv } from "@chilli/ui/data";
import type { LedgerRow } from "./api/types";
import { checkAmount, type AmountCheck } from "./credit";

/** Typed rupees ("1,250.50" is accepted: the Indian grouping commas are dropped) to a checked positive paise amount. */
export const rupeesInput = (text: string, max?: number): AmountCheck => checkAmount(parseRupees(text.replace(/,/g, "")), max);

/** Free-text detail of a ledger line: invoice number for bill rows, receipt / payment ref for top-ups, else the reason. */
export function ledgerDetail(r: LedgerRow): string {
  const m = r.meta ?? {};
  const inv = typeof m.invoice_number === "string" ? m.invoice_number : null;
  const pay = typeof m.payment_ref === "string" ? m.payment_ref : null;
  return [inv, r.reason, pay ? `Payment ref ${pay}` : null].filter(Boolean).join(" · ");
}

/**
 * The ledger as CSV, built with the design system's toCsv: cells a spreadsheet could run as a formula (=, +, -, @ or a
 * control character first, e.g. a reason typed by staff) get an apostrophe, quotes are doubled, CRLF records. Amounts stay
 * integer paise (the platform-core convention for exports) next to a rupee column for people; the rupee column
 * is written as a number (an integer paise / 100 prints exactly), because a text "-5.00" would be guarded as a formula.
 */
export function ledgerCsv(rows: readonly LedgerRow[]): string {
  return toCsv(
    ["at", "kind", "amount_paise", "amount_rupees", "balance_after_paise", "source", "reference", "detail", "actor"],
    rows.map((r) => [r.at, r.kind, r.amount_paise, r.amount_paise / 100, r.balance_after_paise, r.source, r.ref_id ?? "", ledgerDetail(r), r.actor]),
  );
}
