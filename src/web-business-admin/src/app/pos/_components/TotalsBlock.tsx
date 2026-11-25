"use client";

import { useState } from "react";
import { ChevronDown, Info, Pencil, Tag, X } from "lucide-react";
import { NumberRoll } from "@/components/ui/number-roll";
import { Button } from "@chilli/ui";
import { cn } from "@/lib/cn";
import { cmpMoney, currencyMark, formatCurrency, formatMoney, sumMoney } from "@/lib/money";
import { taxPhrases } from "@/lib/taxWords";
import type { PricingState } from "./pricing";

/** "20" for 20.00, "12.5" for 12.50. */
const pct = (p: string) => String(Number(p));
const rateName = (code: string, rate: string, country: string) => {
  const t = taxPhrases(country);
  return code === "zero" ? `Zero rate ${pct(rate)}%` : code === "standard" ? `${t.word} ${pct(rate)}%` : t.none;
};

/**
 * Totals of one ticket: menu subtotal, discount (with reason), service charge (eat-in), the grand Total the customer pays and
 * a compact "incl. GST" line that opens a per-rate breakdown.
 */
export function TotalsBlock({ pricing, currency, owing, paid, balanceDue, canDiscount, discountLocked, billDiscountEditable = false, onDiscount, onRemoveDiscount, serviceChargeConfigured, serviceChargeOn, onToggleServiceCharge, eatIn,
  canToggleOffers = false, offersOn = true, onToggleOffers, manualReason = null }: {
  pricing: PricingState; currency: string;
  /** A finalized bill with money still due: shows Paid + Balance due. */
  owing?: boolean; paid?: string; balanceDue?: string;
  canDiscount: boolean; discountLocked: boolean;
  /** A bill that is made but not paid yet: its discount can still be added / changed (the bill is replaced; the server enforces). */
  billDiscountEditable?: boolean;
  onDiscount: () => void; onRemoveDiscount: () => void;
  /** The restaurant charges a service charge and this order type is eat-in. */
  serviceChargeConfigured: boolean; serviceChargeOn: boolean; onToggleServiceCharge: (on: boolean) => void;
  eatIn: boolean;
  /** Owner / manager may take the automatic offers off this bill (a small toggle, only when offers are in play). */
  canToggleOffers?: boolean; offersOn?: boolean; onToggleOffers?: (on: boolean) => void;
  /** The cashier's own discount reason (the bill's reason also lists the offers). */
  manualReason?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const p = pricing.priced;
  if (!p) return null;
  const cur = (v: string) => formatCurrency(v, currency);
  // Offers are their own lines ("Offer: Lunch 10%"); the Discount row is only the cashier's manual part.
  const offers = p.offers ?? [];
  const offerTotal = offers.length ? sumMoney(offers.map((o) => o.amount)) : "0.00";
  const manualAmount = offers.length ? sumMoney([p.discount_amount, `-${offerTotal}`]) : p.discount_amount;
  const hasDiscount = cmpMoney(manualAmount, 0) > 0;
  const labels = new Set(offers.map((o) => o.label));
  const rawReason = offers.length ? (manualReason ?? (p.discount_reason ?? "").split("; ").filter((x) => !labels.has(x)).join("; ")) || null : p.discount_reason;
  const discountReason = rawReason && rawReason !== "Discount" ? rawReason : null; // "Discount" = no reason was given
  const hasSc = cmpMoney(p.service_charge_amount, 0) > 0;
  const inclusive = p.prices_include_tax;
  const final = pricing.source === "bill";
  const est = pricing.source === "estimate";
  const showSubtotal = true; // Subtotal / GST / Total, always (counter reference); inclusive prices show the GST included under the total
  const money = (v: string, neg?: boolean) => <dd className={cn("tnum font-medium", neg ? "text-success-fg" : "text-fg")}>{neg ? "− " : ""}{cur(v)}</dd>;
  const canEditDiscount = canDiscount && (!discountLocked || billDiscountEditable);
  const scRemoved = serviceChargeConfigured && eatIn && !serviceChargeOn;
  const tx = taxPhrases(p.country);

  return (
    <div data-testid="totals" data-source={pricing.source ?? ""}>
      {pricing.error && <p role="alert" className="mb-2 rounded-lg bg-warning-soft px-3 py-2 text-xs font-medium text-warning-fg">{pricing.error}</p>}
      <dl className="space-y-1.5 text-sm">
        {showSubtotal && <div className="flex items-center justify-between gap-3"><dt className="text-fg-muted">Subtotal</dt>{money(p.items)}</div>}

        {offers.map((o) => (
          <div key={o.offer_id} className="flex items-center justify-between gap-3" data-testid="offer-row">
            <dt className="min-w-0 truncate font-medium text-success-fg">{o.label}</dt>
            {money(o.amount, true)}
          </div>
        ))}
        {canToggleOffers && !discountLocked && !final && onToggleOffers && (offers.length > 0 || !offersOn) && (
          <div className="flex items-center justify-between gap-3" data-testid="apply-offers">
            <dt className="text-xs text-fg-muted">{offersOn ? "Offers applied automatically" : "Offers removed from this bill"}</dt>
            <dd>
              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-xs font-semibold text-fg-muted">
                <input type="checkbox" role="switch" className="ch-check__box ch-check__box--switch" checked={offersOn} onChange={(e) => onToggleOffers(e.target.checked)} />
                Apply offers
              </label>
            </dd>
          </div>
        )}

        {hasDiscount ? (
          <div className="flex items-start justify-between gap-3" data-testid="discount-row">
            <dt className="min-w-0 text-fg-muted">
              <span className="font-medium">Discount</span>
              {discountReason && <span className="block truncate text-xs text-fg-subtle" title={discountReason}>{discountReason}</span>}
              {canEditDiscount && (
                <span className="mt-0.5 flex gap-1">
                  <button type="button" onClick={onDiscount} aria-label="Edit discount" className="inline-flex min-h-11 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-primary-soft-fg hover:bg-primary-soft"><Pencil aria-hidden className="size-3" />Edit</button>
                  <button type="button" onClick={onRemoveDiscount} aria-label="Remove discount" className="inline-flex min-h-11 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-fg-muted hover:bg-danger-soft hover:text-danger-fg"><X aria-hidden className="size-3" />Remove</button>
                </span>
              )}
            </dt>
            {money(manualAmount, true)}
          </div>
        ) : canEditDiscount ? (
          // A <dl> may only hold dt/dd groups (axe definition-list): the button is the value of a visually hidden "Discount" term.
          <div className="flex justify-start">
            <dt className="sr-only">Discount</dt>
            <dd><Button variant="ghost" size="sm" iconStart={<Tag />} onClick={onDiscount} className="-ml-2 min-h-11 text-primary-soft-fg">Add discount</Button></dd>
          </div>
        ) : null}

        {hasSc && (
          <div className="flex items-center justify-between gap-3" data-testid="service-charge-row">
            <dt className="text-fg-muted">
              Service charge {pct(p.service_charge_percent)}%
              {!discountLocked && (
                <button type="button" onClick={() => onToggleServiceCharge(false)} aria-label="Remove service charge"
                  className="ml-1.5 inline-flex min-h-11 items-center rounded-md px-1.5 text-xs font-semibold text-fg-muted underline-offset-2 hover:bg-danger-soft hover:text-danger-fg">remove</button>
              )}
            </dt>
            {money(p.service_charge_amount)}
          </div>
        )}
        {scRemoved && !final && (
          <div className="flex items-center justify-between gap-3" data-testid="service-charge-removed">
            <dt className="text-fg-subtle">Service charge removed</dt>
            <dd><button type="button" onClick={() => onToggleServiceCharge(true)} aria-label="Add service charge back"
              className="inline-flex min-h-11 items-center rounded-md px-1.5 text-xs font-semibold text-primary-soft-fg hover:bg-primary-soft">add back</button></dd>
          </div>
        )}

        {!inclusive && p.vat_registered && p.tax_breakdown.map((b) => (
          <div key={b.code} className="flex items-center justify-between gap-3" data-testid="vat-row">
            <dt className="text-fg-muted">{tx.word} {pct(b.rate_percent)}%{est && <span className="ml-1 text-xs text-fg-subtle">estimate</span>}</dt>
            {money(b.vat)}
          </div>
        ))}
        {!p.vat_registered && <div className="flex items-center gap-1.5 text-xs text-fg-subtle"><dt className="sr-only">{tx.word}</dt><dd className="flex items-center gap-1.5"><Info aria-hidden className="size-3.5" />No {tx.lower} is charged ({tx.notRegistered.toLowerCase()})</dd></div>}

        {p.round_off && cmpMoney(p.round_off, 0) !== 0 && <div className="flex items-center justify-between gap-3" data-testid="round-off-row"><dt className="text-fg-muted">Round off</dt>{money(p.round_off)}</div>}
        {owing && <div className="flex items-center justify-between gap-3"><dt className="text-fg-muted">Total</dt>{money(p.total)}</div>}
        {owing && paid && cmpMoney(paid, 0) > 0 && <div className="flex items-center justify-between gap-3"><dt className="text-fg-muted">Paid</dt>{money(paid, true)}</div>}

        <div className="!mt-3 flex items-end justify-between gap-3 border-t border-dashed border-border-strong pt-3">
          <dt className="font-display text-base font-bold text-fg">{owing ? "Balance due" : "Total"}</dt>
          <dd className="font-display text-2xl font-extrabold tracking-tight text-fg" data-testid="total">
            <NumberRoll value={formatMoney(owing ? balanceDue ?? p.total : p.total)} prefix={currencyMark(currency)} />
          </dd>
        </div>
      </dl>

      {inclusive && p.vat_registered && (
        <div className="mt-1.5" data-testid="gst-summary">
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
            className="-mx-1 inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-xs font-medium text-fg-muted hover:bg-surface-2 hover:text-fg">
            <span data-testid="gst-line">{tx.incl} {cur(p.tax_amount)}{est && <span className="ml-1 text-fg-subtle">(estimate)</span>}</span>
            <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </button>
          {open && (
            <ul className="mt-1 space-y-1 rounded-lg bg-surface-2/70 px-3 py-2 text-xs text-fg-muted" aria-label={`${tx.word} by rate`}>
              {p.tax_breakdown.map((b) => (
                <li key={b.code} className="flex justify-between gap-3">
                  <span>{rateName(b.code, b.rate_percent, p.country)}</span>
                  <span className="tnum text-right">{cmpMoney(b.vat, 0) > 0 || b.code !== "zero" ? <>{tx.word} {cur(b.vat)} <span className="text-fg-subtle">on {cur(b.net)}</span></> : <>{cur(b.gross)} <span className="text-fg-subtle">no {tx.lower}</span></>}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

