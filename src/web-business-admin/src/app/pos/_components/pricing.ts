"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { sumMoney } from "@/lib/money";
import { getTaxConfig } from "@/lib/taxConfig";
import { tryComputeInvoice, type EstimateInvoice } from "@/lib/taxEstimate";
import type { Bill, BillPreview, TaxBreakdownRow } from "@/lib/types";
import type { AppliedOffer, Offer } from "@/lib/extras";
import { combinedDiscount, estimateOffers } from "@/lib/modifiers";
import { estimateOf, mergeLines } from "./tickets";
import type { CartLine, Tax, Ticket } from "./types";

/** Everything the totals block needs, whichever source produced it (finalized bill, server preview, client estimate). */
export interface Priced {
  source: "bill" | "server" | "estimate";
  /** Sum of the line amounts as shown on the menu (before discount; GST-inclusive when prices include GST). */
  items: string;
  discount_amount: string; discount_reason: string | null;
  service_charge_amount: string; service_charge_percent: string;
  subtotal: string; tax_amount: string; total: string;
  tax_breakdown: TaxBreakdownRow[];
  prices_include_tax: boolean; vat_registered: boolean; country: string; currency: string;
  /** Automatic offers in this total ("Offer: Lunch 10%"); `discount_amount` includes them. */
  offers: AppliedOffer[]; offer_amount: string;
  /** India GST engine: the round-off line (total = subtotal + tax + round_off). */
  round_off?: string;
}

export const itemsOf = (inv: Pick<BillPreview, "lines">) => sumMoney(inv.lines.map((l) => l.line_total));

export function fromInvoice(inv: EstimateInvoice | BillPreview, source: Priced["source"]): Priced {
  return {
    source, items: itemsOf(inv), discount_amount: inv.discount_amount, discount_reason: inv.discount_reason,
    service_charge_amount: inv.service_charge_amount, service_charge_percent: inv.service_charge_percent,
    subtotal: inv.subtotal, tax_amount: inv.tax_amount, total: inv.total, tax_breakdown: inv.tax_breakdown,
    prices_include_tax: inv.prices_include_tax, vat_registered: inv.vat_registered, country: inv.country, currency: inv.currency,
    offers: ("offers" in inv && inv.offers) || [], offer_amount: ("offer_amount" in inv && inv.offer_amount) || "0.00",
    round_off: ("round_off" in inv && inv.round_off) || undefined,
  };
}

/** A finalized server bill; old bills (before the per-rate breakdown) have none: one row at the bill's rate. */
export function fromBill(b: Bill): Priced {
  const breakdown = b.tax_breakdown ?? [{ code: "standard", rate_percent: b.tax_rate_percent, net: b.subtotal, vat: b.tax_amount, gross: b.total }];
  return {
    source: "bill", items: sumMoney(b.lines.map((l) => l.line_total)),
    discount_amount: b.discount_amount ?? "0.00", discount_reason: b.discount_reason ?? null,
    service_charge_amount: b.service_charge_amount ?? "0.00", service_charge_percent: b.service_charge_percent ?? "0.00",
    subtotal: b.subtotal, tax_amount: b.tax_amount, total: b.total, tax_breakdown: breakdown,
    prices_include_tax: b.prices_include_tax ?? false, vat_registered: b.vat_registered ?? true, country: b.country ?? getTaxConfig()?.country ?? "", currency: b.currency,
    offers: b.offers?.applied ?? [], offer_amount: b.offer_amount ?? "0.00", round_off: b.round_off,
  };
}

export const cartToEstimate = (lines: CartLine[]) =>
  lines.map((l) => ({ description: l.label, quantity: l.qty, unit_price: l.unit, tax_kind: l.item.tax_kind ?? "standard", item_id: l.item.id }));

/**
 * Client-side estimate of a ticket (null when there is no config yet or the config cannot price it). Running offers
 * (GET /offers/active, cached with the menu) are estimated the way the server applies them; with no offers the numbers are
 * exactly the old ones.
 */
export function estimateTicket(t: Pick<Ticket, "lines" | "more" | "type" | "discount" | "serviceCharge" | "applyOffers">, cfg: Tax, offers: Offer[] = []): { priced: Priced | null; error: string | null } {
  if (!cfg) return { priced: null, error: null };
  const lines = t.more?.length ? mergeLines(t.lines, t.more) : t.lines;
  const est = cartToEstimate(lines);
  const o = offers.length && t.applyOffers !== false ? estimateOffers(lines.map((l) => ({ itemId: l.item.id, categoryId: l.item.category_id, unit: l.unit, qty: l.qty })), offers, t.type) : null;
  const disc = o && o.applied.length ? combinedDiscount(estimateOf(lines), o.total, o.applied.map((a) => a.label), t.discount ?? null) : t.discount ?? null;
  const r = tryComputeInvoice(est, cfg, t.type, disc, t.serviceCharge !== false);
  const priced = r.invoice ? fromInvoice(r.invoice, "estimate") : null;
  if (priced && o && o.applied.length) { priced.offers = o.applied; priced.offer_amount = o.total; }
  return { priced, error: r.error };
}

/** Total the ticket stands at (chips, mobile bar): the bill's, else the estimate's, else the plain menu sum. */
export function ticketTotal(t: Ticket, cfg: Tax, offers: Offer[] = []): string {
  if (t.bill) return t.bill.total;
  const e = estimateTicket(t, cfg, offers).priced;
  return e ? e.total : estimateOf(t.more?.length ? mergeLines(t.lines, t.more) : t.lines);
}

export interface PricingState {
  priced: Priced | null;
  /** "estimate" numbers are computed on this device (label them); "server" came from bill-preview; "bill" is final. */
  source: Priced["source"] | null;
  /** True while a fresh server preview is on its way (the estimate is shown meanwhile). */
  pending: boolean;
  /** Message from the server about this discount / service charge (e.g. cashier over the limit). */
  error: string | null;
}

const DEBOUNCE_MS = 250;

/**
 * Totals of the active ticket. Final bill > server `bill-preview` (placed, online, allowed role; debounced, stale
 * requests cancelled) > client estimate (drafts, offline, any failure). Never throws; always something to show.
 */
export function usePricing(t: Ticket | null, cfg: Tax, opts: { online: boolean; canPreview: boolean; offers?: Offer[] }): PricingState {
  const offers = opts.offers;
  const est = useMemo(() => (t && !t.bill ? estimateTicket(t, cfg, offers) : { priced: null, error: null }),
    [t, cfg, offers]);
  // Items not added to the order yet are not on the server: until they are, the estimate (which includes them) is shown.
  const orderId = t && !t.bill && t.order && !t.order.offline && !t.more?.length ? t.order.id : null;
  const wantPreview = !!orderId && opts.online && opts.canPreview;
  const key = wantPreview ? JSON.stringify([orderId, t!.discount ?? null, t!.serviceCharge !== false, t!.applyOffers !== false]) : null;
  const [res, setRes] = useState<{ key: string; priced: Priced | null; error: string | null } | null>(null);
  const reqs = useRef(0);

  useEffect(() => {
    if (!key || !orderId || !t) return;
    const id = ++reqs.current;
    const ctrl = new AbortController();
    const body = { discount: t.discount ?? null, service_charge: t.serviceCharge !== false, apply_offers: t.applyOffers !== false };
    const timer = setTimeout(() => {
      api.billPreview(orderId, body, ctrl.signal).then(
        (p) => { if (reqs.current === id) setRes({ key, priced: fromInvoice(p, "server"), error: null }); },
        (e) => {
          if (ctrl.signal.aborted || reqs.current !== id) return;
          // 403/422/409 carry a message worth showing; network errors silently keep the estimate. A 401 is the session prompt's job ("Session expired, sign in again"), never "Not authenticated" here.
          setRes({ key, priced: null, error: e instanceof ApiError && e.status !== 0 && e.status !== 401 && e.status < 500 ? e.message : null });
        });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); ctrl.abort(); };
    // `t` is intentionally not a dependency: `key` already encodes everything the request depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, orderId]);

  if (!t) return { priced: null, source: null, pending: false, error: null };
  if (t.bill) return { priced: fromBill(t.bill), source: "bill", pending: false, error: null };
  const fresh = res && res.key === key ? res : null;
  if (fresh?.priced) return { priced: fresh.priced, source: "server", pending: false, error: null };
  return { priced: est.priced, source: est.priced ? "estimate" : null, pending: !!key && !fresh, error: fresh?.error ?? est.error };
}
