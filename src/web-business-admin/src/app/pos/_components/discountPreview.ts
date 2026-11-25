import { cmpMoney, sumMoney } from "@/lib/money";
import { taxPhrases } from "@/lib/taxWords";
import type { Bill, BillPreview } from "@/lib/types";

/** One line of the "bill after this discount" panel: label, amount and how to draw it. */
export interface PreviewRow { key: string; label: string; value: string; tone?: "discount" | "total" | "muted"; /** Taxable value a tax row is on. */ hint?: string }

const pct = (p: string) => String(Number(p));
const half = (p: string) => String(Number(p) / 2);

/**
 * The rows of the bill preview shown while a discount is typed, straight from the server's numbers (nothing is calculated here
 * except "items before the discount", the sum of the line amounts): Subtotal, Discount, GST by rate (CGST / SGST halves when
 * the invoice has them), service charge, round off, Total.
 */
export function previewRows(p: BillPreview): PreviewRow[] {
  const t = taxPhrases(p.country);
  const rows: PreviewRow[] = [{ key: "items", label: "Items", value: sumMoney(p.lines.map((l) => l.line_total)) }];
  if (cmpMoney(p.discount_amount, 0) > 0) rows.push({ key: "discount", label: p.discount_reason && p.discount_reason !== "Discount" ? `Discount (${p.discount_reason})` : "Discount", value: p.discount_amount, tone: "discount" });
  if (cmpMoney(p.service_charge_amount, 0) > 0) rows.push({ key: "sc", label: `Service charge ${pct(p.service_charge_percent)}%`, value: p.service_charge_amount });
  if (p.vat_registered) {
    for (const b of p.tax_breakdown) {
      if (b.code === "zero" || cmpMoney(b.vat, 0) === 0) continue;
      const on = b.net; // the taxable value this tax is on
      if (b.cgst != null && b.sgst != null && (cmpMoney(b.cgst, 0) > 0 || cmpMoney(b.sgst, 0) > 0)) {
        rows.push({ key: `${b.code}-cgst`, label: `CGST ${half(b.rate_percent)}%`, value: b.cgst, tone: "muted", hint: on });
        rows.push({ key: `${b.code}-sgst`, label: `SGST ${half(b.rate_percent)}%`, value: b.sgst, tone: "muted", hint: on });
      } else if (b.igst != null && cmpMoney(b.igst, 0) > 0) {
        rows.push({ key: `${b.code}-igst`, label: `IGST ${pct(b.rate_percent)}%`, value: b.igst, tone: "muted", hint: on });
      } else {
        rows.push({ key: b.code, label: `${t.word} ${pct(b.rate_percent)}%`, value: b.vat, tone: "muted", hint: on });
      }
    }
  }
  if (p.round_off != null && cmpMoney(p.round_off, 0) !== 0) rows.push({ key: "round", label: "Round off", value: p.round_off, tone: "muted" });
  rows.push({ key: "total", label: "Total", value: p.total, tone: "total" });
  return rows;
}

/** Roles that can never discount are told so in words, not with a disabled button; this is the one place that decides. */
export function discountLimitFor(can: (perm: string) => boolean, cashierCap: string | null | undefined): string | null {
  return can("bills.discount.over_limit") ? null : cashierCap ?? "10";
}

/**
 * May the discount of this bill still be changed at the counter? Only while it is open: the current version, nothing paid, no
 * automatic offer in it (a replacement invoice would drop the offer; the server refuses too). After a payment only a manager's
 * correction (credit note) or a refund changes the money.
 */
export function billDiscountEditable(bill: Pick<Bill, "paid" | "balance_due" | "offer_amount" | "status"> | null | undefined): boolean {
  if (!bill) return false;
  return cmpMoney(bill.balance_due, 0) > 0 && cmpMoney(bill.paid, 0) === 0 && cmpMoney(bill.offer_amount ?? 0, 0) === 0
    && bill.status !== "superseded" && bill.status !== "voided";
}
