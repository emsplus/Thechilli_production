"use client";

import { formatDate, formatTime } from "@/lib/datetime";
import { createPortal } from "react-dom";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronDown, CloudOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { billTitle, countryInfo } from "@/lib/countries";
import { sumMoney, cmpMoney, formatCurrency, mulMoney } from "@/lib/money";
import type { Bill } from "@/lib/types";
import { fromBill, fromInvoice, type Priced } from "./pricing";
import type { Provisional } from "./types";
import { taxPhrases } from "@/lib/taxWords";
import { groupCartLines } from "@/lib/groupLines";

const Row = ({ k, v, strong, tone }: { k: ReactNode; v: ReactNode; strong?: boolean; tone?: "good" }) => (
  <div className={strong ? "flex justify-between gap-3 text-base font-bold text-fg" : "flex justify-between gap-3 text-fg-muted"}><span>{k}</span><span className={cn("tnum text-right", tone === "good" && "text-success-fg")}>{v}</span></div>
);
const pct = (p: string) => String(Number(p));
// Tax breakdown row label. The code is "standard" / "zero" / "none" for the generic engines and "gst_5", "gst_18", ... for India: any code that
// carries a rate prints that rate (a "gst_18" row must never read Exempt), only a real no-tax code prints Exempt.
export const rateLabel = (code: string, rate: string, country?: string | null) =>
  code === "none" ? taxPhrases(country).none
    : code === "zero" || code === "gst_0" ? `Zero rate ${pct(rate)}%`
    : Number(rate) > 0 ? `${pct(rate)}%`
    : taxPhrases(country).none;

/** The shared money rows: subtotal, discount, service charge, GST on exclusive prices, total. */
function MoneyRows({ p, currency, est }: { p: Priced; currency: string; est?: boolean }) {
  const cur = (v: string) => formatCurrency(v, currency);
  const disc = cmpMoney(p.discount_amount, 0) > 0;
  const sc = cmpMoney(p.service_charge_amount, 0) > 0;
  // Offers print as their own lines ("Offer: Lunch 10%"); Discount is the manual remainder.
  const offerLabels = new Set((p.offers ?? []).map((o) => o.label));
  const manual = p.offers?.length ? sumMoney([p.discount_amount, `-${p.offer_amount}`]) : p.discount_amount;
  const manualReason = p.offers?.length ? (p.discount_reason ?? "").split("; ").filter((x) => !offerLabels.has(x)).join("; ") || null : p.discount_reason;
  const shownReason = manualReason && manualReason !== "Discount" ? manualReason : null; // "Discount" = no reason was given
  return (
    <>
      {(!p.prices_include_tax || disc || sc) && <Row k="Subtotal" v={cur(p.items)} />}
      {(p.offers ?? []).map((o) => <Row key={o.offer_id} k={o.label} v={`− ${cur(o.amount)}`} tone="good" />)}
      {disc && cmpMoney(manual, 0) > 0 && <Row k={<>Discount{shownReason && <span className="block text-[0.85em] font-normal text-fg-subtle">{shownReason}</span>}</>} v={`− ${cur(manual)}`} tone="good" />}
      {sc && <Row k={`Service charge ${pct(p.service_charge_percent)}%`} v={cur(p.service_charge_amount)} />}
      {!p.prices_include_tax && p.vat_registered && p.tax_breakdown.map((b) => <Row key={b.code} k={`${taxPhrases(p.country).word} ${pct(b.rate_percent)}%${est ? " (est.)" : ""}`} v={cur(b.vat)} />)}
      {p.round_off && cmpMoney(p.round_off, 0) !== 0 && <Row k="Round off" v={cur(p.round_off)} />}
    </>
  );
}

/** Server-issued invoice / receipt summary of a finalized bill. */
export function BillSummary({ bill, hideHeader }: { bill: Bill; hideHeader?: boolean }) {
  const p = fromBill(bill);
  const cur = (v: string) => formatCurrency(v, bill.currency);
  const [open, setOpen] = useState(false);
  const label = countryInfo(bill.country).taxNumberLabel;
  const tx = taxPhrases(bill.country ?? p.country);
  return (
    <div className="rounded-xl border border-border bg-surface-2/60 p-3 text-sm">
      {!hideHeader && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="font-mono text-sm font-semibold text-fg">{bill.invoice_number}</span>
          <span className="text-xs text-fg-subtle">{billTitle(bill.country, bill.vat_registered)}</span>
        </div>
      )}
      <div className="space-y-1">
        <MoneyRows p={p} currency={bill.currency} />
        <div className="my-1 border-t border-dashed border-border-strong" />
        <Row strong k="Total" v={cur(bill.total)} />
        {p.prices_include_tax && p.vat_registered && (
          <div>
            <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="-mx-1 inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-xs font-medium text-fg-muted hover:bg-surface hover:text-fg">
              {tx.incl} {cur(bill.tax_amount)}<ChevronDown aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-180")} />
            </button>
            {open && <ul className="mt-1 space-y-1 text-xs text-fg-muted" aria-label={`${tx.word} by rate`}>
              {p.tax_breakdown.map((b) => <li key={b.code} className="flex justify-between gap-3"><span>{rateLabel(b.code, b.rate_percent, bill.country)}</span><span className="tnum">{b.cgst != null && b.sgst != null && cmpMoney(b.cgst, 0) + cmpMoney(b.sgst, 0) > 0 ? <>CGST {cur(b.cgst)} · SGST {cur(b.sgst)}</> : <>{tx.word} {cur(b.vat)}</>} <span className="text-fg-subtle">on {cur(b.net)}</span></span></li>)}
            </ul>}
          </div>
        )}
        {Number(bill.paid) > 0 && <Row k="Paid" v={cur(bill.paid)} />}
        <Row k="Balance due" v={cur(bill.balance_due)} />
        {bill.seller_trn && p.vat_registered && <p className="pt-1 text-xs text-fg-subtle">{label} {bill.seller_trn}</p>}
        {p.prices_include_tax && p.vat_registered && <p className="text-xs text-fg-subtle">{tx.pricesInclude}</p>}
      </div>
    </div>
  );
}

const rule = <div className="my-1.5 border-t border-dashed border-border-strong" />;

/** Thermal-paper look (80 mm): logo, restaurant, banner, ref, items, discount, service charge, total, GST summary, payment, thank you. */
function ReceiptBody({ prov, restaurant }: { prov: Provisional; restaurant?: string }) {
  const when = new Date(prov.at);
  const inv = prov.inv ?? null;
  const registered = inv ? inv.vat_registered : true;
  const cur = (v: string) => formatCurrency(v, prov.currency);
  const priced: Priced | null = inv ? fromInvoice(inv, "estimate") : null;
  const country = prov.country ?? inv?.country ?? null;
  const tx = taxPhrases(country);
  return (
    <div className="font-mono text-[0.78rem] leading-snug">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/receipt-logo.png" alt="" width={96} height={96} className="mx-auto mb-1 size-16 object-contain" />
      {restaurant && <p className="text-center text-sm font-bold">{restaurant}</p>}
      <p className="mt-1 text-center text-[0.8rem] font-bold leading-tight tracking-wide">
        PROVISIONAL RECEIPT
        {registered && <> — <span className="text-danger-fg">NOT A TAX INVOICE</span></>}
      </p>
      <p className="text-center text-[0.65rem] leading-tight">{registered ? "The invoice number and its date are issued when synced" : "The final receipt number and date are issued when synced"}</p>
      {rule}
      <div className="flex justify-between"><span>Date: {formatDate(when)}</span><span>Ref: {prov.ref}</span></div>
      <div>Time: {formatTime(when)}</div>
      {rule}
      <div className="grid grid-cols-[1fr_2rem_4.5rem] gap-x-1 font-bold"><span>Item</span><span className="text-right">Qty</span><span className="text-right">Amt</span></div>
      <ul className="mt-0.5 space-y-0.5">
        {groupCartLines(prov.lines).map((l) => (
          <li key={l.key} className="grid grid-cols-[1fr_2rem_4.5rem] gap-x-1"><span className="break-words">{l.label}</span><span className="text-right">{l.qty}</span><span className="tnum text-right">{formatCurrency(mulMoney(l.unit, l.qty), prov.currency)}</span></li>
        ))}
      </ul>
      {rule}
      {priced ? (
        <>
          <MoneyRows p={priced} currency={prov.currency} est />
          <div className="my-1 border-t border-border-strong" />
          <Row strong k="TOTAL" v={cur(priced.total)} />
          {registered && (
            <>
              {rule}
              <p className="font-bold">{tx.word} summary <span className="font-normal">(estimate)</span></p>
              <div className="grid grid-cols-[1fr_4rem_3.5rem] gap-x-1 text-[0.72rem] font-bold"><span>Rate</span><span className="text-right">Net</span><span className="text-right">{tx.word}</span></div>
              {priced.tax_breakdown.map((b) => (
                <div key={b.code} className="tnum grid grid-cols-[1fr_4rem_3.5rem] gap-x-1 text-[0.72rem]"><span>{rateLabel(b.code, b.rate_percent, country)}</span><span className="text-right">{formatCurrency(b.net, prov.currency)}</span><span className="text-right">{formatCurrency(b.vat, prov.currency)}</span></div>
              ))}
              <Row k={`Total ${tx.word}`} v={cur(priced.tax_amount)} />
              {priced.prices_include_tax && <p className="mt-0.5 text-[0.7rem]">{tx.pricesInclude}</p>}
            </>
          )}
        </>
      ) : (
        <>
          <Row k="Sub Total" v={cur(prov.subtotal)} />
          {prov.vat !== null && prov.total !== null ? (
            <>
              <Row k={`${tx.word} ${Number(prov.rate)}% (est.)`} v={cur(prov.vat)} />
              <div className="my-1 border-t border-border-strong" />
              <Row strong k="Grand Total" v={cur(prov.total)} />
            </>
          ) : <p className="text-[0.7rem]">{tx.word} is calculated when synced.</p>}
        </>
      )}
      {rule}
      <Row k="Payment" v={prov.method.toUpperCase()} />
      {rule}
      <p className="text-center text-xs font-bold">Thank you for dining with us!<br />Visit again.</p>
    </div>
  );
}

const noop = () => () => {};

/**
 * Paper-style provisional receipt. The on-screen copy carries data-testid="provisional"; a print-only
 * copy is portaled to <body> so the `.print-area` rules in globals.css work regardless of scroll containers.
 */
export function ProvisionalReceipt({ prov, restaurant }: { prov: Provisional; restaurant?: string }) {
  const body = useSyncExternalStore(noop, () => document.body, () => null);
  return (
    <>
      <div data-testid="provisional" className="relative mx-auto w-full max-w-xs rounded-sm border border-border bg-surface px-4 pb-5 pt-4 text-fg shadow-pop"
        style={{ clipPath: "polygon(0 0,100% 0,100% calc(100% - 8px),96% 100%,92% calc(100% - 8px),88% 100%,84% calc(100% - 8px),80% 100%,76% calc(100% - 8px),72% 100%,68% calc(100% - 8px),64% 100%,60% calc(100% - 8px),56% 100%,52% calc(100% - 8px),48% 100%,44% calc(100% - 8px),40% 100%,36% calc(100% - 8px),32% 100%,28% calc(100% - 8px),24% 100%,20% calc(100% - 8px),16% 100%,12% calc(100% - 8px),8% 100%,4% calc(100% - 8px),0 100%)" }}>
        <span className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1 text-xs font-semibold text-warning-fg"><CloudOff className="size-3.5" aria-hidden />Saved offline</span>
        <ReceiptBody prov={prov} restaurant={restaurant} />
      </div>
      {body && createPortal(<div className="print-area hidden bg-white p-2 text-black print:block [--border-strong:#999] [--danger-fg:#a61b1b] [--fg-muted:#333] [--fg-subtle:#555] [--fg:#000]"><ReceiptBody prov={prov} restaurant={restaurant} /></div>, body)}
    </>
  );
}
