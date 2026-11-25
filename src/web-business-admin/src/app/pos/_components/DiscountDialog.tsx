"use client";

import { useEffect, useMemo, useState } from "react";
import { Percent, Tag } from "lucide-react";
import { SegmentedControl } from "@/components/ui";
import { Button, Dialog, Input } from "@chilli/ui";
import { taxWordLower, useTaxWord } from "@/lib/taxWords";
import { cn } from "@/lib/cn";
import { cmpMoney, currencyMark, formatCurrency } from "@/lib/money";
import { discountPercentOf } from "@/lib/taxEstimate";
import type { BillPreview, DiscountInput } from "@/lib/types";
import { previewRows } from "./discountPreview";
import { discountValueError } from "./discountInput";

export const DISCOUNT_REASONS = ["Staff meal", "Customer complaint", "Loyalty", "Manager comp", "Promotion"];

/**
 * "Add discount": percent or fixed amount + an optional reason (3-200 characters when given; recorded on the bill and audited).
 * `limitPercent` is set for cashiers: a discount above it needs a manager or owner (the server enforces the same rule).
 */
export function DiscountDialog({ open, onOpenChange, current, itemsTotal, currency, limitPercent, onApply, onRemove, preview, note }: {
  open: boolean; onOpenChange: (o: boolean) => void;
  current: DiscountInput | null;
  /** Sum of the line amounts the discount applies to (before any discount). */
  itemsTotal: string;
  currency: string;
  /** Max percentage this user may give (cashier), or null for unlimited (owner / manager). */
  limitPercent: string | null;
  onApply: (d: DiscountInput) => void;
  onRemove: () => void;
  /** The server's exact bill with this discount (before the bill: bill-preview; on an open bill: discount-preview). Absent offline. */
  preview?: (d: DiscountInput, signal: AbortSignal) => Promise<BillPreview>;
  /** What applying does, in words (e.g. the open bill is replaced by a new one). */
  note?: string;
}) {
  const [type, setType] = useState<"percent" | "amount">("percent");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!open) return;
    void Promise.resolve().then(() => {
      setType(current?.type ?? "percent"); setValue(current?.value ?? ""); setReason(current?.reason && current.reason !== "Discount" ? current.reason : ""); setTouched(false);
    });
  }, [open, current]);

  const mark = currencyMark(currency);
  const err = useMemo(() => {
    const v = value.trim();
    const bad = discountValueError(v);
    if (bad) return { value: bad, reason: null, limit: null };
    if (type === "percent" && cmpMoney(v, 100) > 0) return { value: "A discount cannot be more than 100%", reason: null, limit: null };
    if (type === "amount" && cmpMoney(v, itemsTotal) > 0) return { value: `Cannot be more than the bill (${formatCurrency(itemsTotal, currency)})`, reason: null, limit: null };
    const r = reason.trim();
    const reasonErr = r.length > 0 && r.length < 3 ? "A reason needs at least 3 characters (or leave it empty)" : r.length > 200 ? "Keep the reason under 200 characters" : null;
    const pct = discountPercentOf({ type, value: v }, itemsTotal);
    const limit = limitPercent !== null && cmpMoney(pct, limitPercent) > 0
      ? `Cashiers can give up to ${Number(limitPercent)}% (this is ${Number(pct)}%). Ask a manager or owner for a bigger discount.` : null;
    return { value: null, reason: reasonErr, limit };
  }, [value, reason, type, itemsTotal, currency, limitPercent]);
  const invalid = !!(err.value || err.reason || err.limit);

  // Live "bill after this discount" from the server (debounced; a stale answer never replaces a newer one).
  const [pv, setPv] = useState<{ key: string; data: BillPreview | null; error: string | null } | null>(null);
  const pvKey = open && preview && !invalid ? `${type}|${value.trim()}|${reason.trim()}` : null;
  useEffect(() => {
    if (!pvKey || !preview) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      preview({ type, value: value.trim(), reason: reason.trim() }, ctrl.signal).then(
        (data) => setPv({ key: pvKey, data, error: null }),
        (e) => { if (!ctrl.signal.aborted) setPv({ key: pvKey, data: null, error: e instanceof Error && e.message ? e.message : "Could not work out the bill." }); });
    }, 300);
    return () => { clearTimeout(timer); ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pvKey]);
  const shown = pv && pv.key === pvKey ? pv : null;

  function apply() {
    setTouched(true);
    if (invalid) return;
    onApply({ type, value: value.trim(), reason: reason.trim() });
    onOpenChange(false);
  }

  const tw = taxWordLower(useTaxWord());
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={current ? "Edit discount" : "Add discount"}
      description={`Taken off the items before ${tw} is worked out. Bill total before discount: ${formatCurrency(itemsTotal, currency)}.`}
      footer={<>
        {current && <Button variant="danger-soft" onClick={() => { onRemove(); onOpenChange(false); }}>Remove discount</Button>}
        <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" iconStart={<Tag />} onClick={apply} disabled={invalid}>Apply discount</Button>
      </>}>
      <form className="space-y-4 pb-3" noValidate onSubmit={(e) => { e.preventDefault(); apply(); }}>
        <SegmentedControl label="Discount type" block value={type} onChange={(v) => { setType(v); setTouched(false); }}
          options={[{ value: "percent", label: "Percent %", icon: <Percent /> }, { value: "amount", label: `Amount ${mark}`.trim() }]} />
        <Input label={type === "percent" ? "Percent off" : `Amount off (${mark || currency})`} inputMode="decimal" autoComplete="off"
          placeholder={type === "percent" ? "10" : "2.50"} value={value} onChange={(e) => { setValue(e.target.value); setTouched(true); }}
          error={touched ? err.value ?? undefined : undefined} />
        {preview && (
          <div data-testid="discount-preview" aria-live="polite" className="rounded-xl border border-border bg-surface-2/60 px-3 py-2.5 text-sm">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Bill after this discount</p>
            {shown?.data ? (
              <dl className="space-y-1">
                {previewRows(shown.data).map((r) => (
                  <div key={r.key} className={cn("flex items-baseline justify-between gap-3", r.tone === "total" && "mt-1 border-t border-dashed border-border-strong pt-1.5 font-bold text-fg")}>
                    <dt className={cn(r.tone === "muted" ? "text-fg-subtle" : r.tone === "discount" ? "text-success-fg" : "text-fg-muted", r.tone === "total" && "text-fg")}>
                      {r.label}{r.hint ? <span className="ml-1 text-xs text-fg-subtle">on {formatCurrency(r.hint, currency)}</span> : null}
                    </dt>
                    <dd className="tnum" data-testid={`pv-${r.key}`}>{r.tone === "discount" ? "− " : ""}{formatCurrency(r.value, currency)}</dd>
                  </div>
                ))}
              </dl>
            ) : shown?.error ? <p role="alert" className="text-warning-fg">{shown.error}</p>
              : <p className="text-fg-subtle">{invalid ? "Enter the discount to see the bill." : "Working out the bill…"}</p>}
          </div>
        )}
        <div>
          <p className="mb-1.5 text-sm font-semibold text-fg">Reason <span className="font-normal text-fg-subtle">(optional)</span></p>
          <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="Common reasons">
            {DISCOUNT_REASONS.map((r) => (
              <button key={r} type="button" aria-pressed={reason === r} onClick={() => { setReason(r); setTouched(true); }}
                className={cn("min-h-9 rounded-full border px-3 text-sm font-medium transition-colors",
                  reason === r ? "border-primary bg-primary-soft text-primary-soft-fg" : "border-border bg-surface text-fg-muted hover:bg-surface-2")}>{r}</button>
            ))}
          </div>
          {/* The "Reason" heading above labels the chips and this field visually (the original used aria-label, no second visible label). */}
          <input aria-label="Discount reason" placeholder="Or type a reason" maxLength={200} value={reason} onChange={(e) => { setReason(e.target.value); setTouched(true); }}
            aria-invalid={touched && err.reason ? true : undefined} aria-describedby={touched && err.reason ? "discount-reason-err" : undefined} className="ch-input w-full" />
          {touched && err.reason && <p id="discount-reason-err" className="mt-1 text-sm font-medium text-danger-fg">{err.reason}</p>}
        </div>
        {note && <p className="text-xs text-fg-muted" data-testid="discount-note">{note}</p>}
        {touched && err.limit && <p role="alert" data-testid="discount-limit" className="rounded-xl bg-warning-soft px-3 py-2 text-sm font-medium text-warning-fg">{err.limit}</p>}
        {limitPercent !== null && !err.limit && <p className="text-xs text-fg-subtle">Cashiers can give up to {Number(limitPercent)}% off. Managers and owners have no limit.</p>}
      </form>
    </Dialog>
  );
}
