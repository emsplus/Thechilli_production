"use client";
import { Money, Table } from "@chilli/ui";
import type { ApiError } from "@/lib/api";
import type { InvoiceDetail } from "@/lib/api/types";
import { bpsToPercent, fmtDate } from "@/lib/format";
import { DefList, InlineError, Notice, StatusBadge } from "./ui";

export const CA_NOTICE = "CA verification pending: GST rate, SAC, place of supply, rounding and invoice numbering are shown exactly as the platform returned them and have not been verified by a Chartered Accountant.";

/** GST figures are rendered exactly as returned by the API: no recomputation, no rounding here. */
export function InvoiceBody({ d, name, error }: { d: InvoiceDetail; name: string; error?: ApiError }) {
  const intra = d.igst_paise === 0;
  return (
    <div className="hq-stack">
      <Notice tone="warning">{d.tax_notice ?? (d.tax_needs_ca_verification ? CA_NOTICE : "")} {d.tax_needs_ca_verification ? "CA verification pending." : ""}</Notice>
      <DefList items={[["Business", name], ["Status", <StatusBadge key="s" value={d.status} />], ["Issued", fmtDate(d.issued_at)], ["Due", fmtDate(d.due_at)], ["Paid", fmtDate(d.paid_at)], ["Supplier GSTIN", d.supplier_gstin ?? "–"], ["Buyer GSTIN", d.buyer_gstin ?? "–"], ["Place of supply (state)", d.buyer_state_code ?? "–"], ["SAC", d.sac_code], ["Void reason", d.void_reason]]} />
      <Table caption="Invoice lines" getKey={(l) => l.description} rows={d.lines} columns={[
        { key: "d", header: "Description", render: (l) => l.description }, { key: "q", header: "Qty", align: "end", render: (l) => l.quantity },
        { key: "u", header: "Rate", align: "end", render: (l) => <Money value={l.unit_price_paise} alwaysDecimals /> }, { key: "a", header: "Amount", align: "end", render: (l) => <Money value={l.amount_paise} alwaysDecimals /> },
      ]} />
      <table className="hq-totals" aria-label="GST breakup">
        <tbody>
          <tr><th scope="row">Subtotal</th><td><Money value={d.subtotal_paise} alwaysDecimals /></td></tr>
          {d.discount_paise ? <tr><th scope="row">Discount</th><td><Money value={-d.discount_paise} alwaysDecimals /></td></tr> : null}
          <tr><th scope="row">Taxable value</th><td><Money value={d.taxable_paise} alwaysDecimals /></td></tr>
          {intra ? <>
            <tr><th scope="row">CGST ({bpsToPercent(d.gst_rate_bps / 2)})</th><td><Money value={d.cgst_paise} alwaysDecimals /></td></tr>
            <tr><th scope="row">SGST ({bpsToPercent(d.gst_rate_bps / 2)})</th><td><Money value={d.sgst_paise} alwaysDecimals /></td></tr>
          </> : <tr><th scope="row">IGST ({bpsToPercent(d.gst_rate_bps)})</th><td><Money value={d.igst_paise} alwaysDecimals /></td></tr>}
          <tr className="is-total"><th scope="row">Total</th><td><Money value={d.total_paise} alwaysDecimals /></td></tr>
        </tbody>
      </table>
      <InlineError error={error} />
    </div>
  );
}
