"use client";

import { orderWhere } from "@/lib/tableWhere";
import { formatDateTime } from "@/lib/datetime";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowRight, CircleCheck, PencilLine, Plus, Repeat, Trash2 } from "lucide-react";
import { PillTabs, QtyStepper, SegmentedControl, toast, useConfirm } from "@/components/ui";
import { Badge, Button, Dialog, Input, Notice, Select, Skeleton, Switch } from "@chilli/ui";
import { FoodImage } from "@/components/pos/food-image";
import { BillActions } from "@/components/pos/BillActions";
import { BillSummary } from "@/app/pos/_components/Receipts";
import { api, ApiError } from "@/lib/api";
import { cmpMoney, formatCurrency } from "@/lib/money";
import { useCan } from "@/lib/useRole";
import { uuid } from "@/lib/uuid";
import type { AmendLineInput, AmendOptions, AmendPreview, AmendRequest, AmendResult, Bill, Category, DiningTable, MenuItem } from "@/lib/types";
import { taxPhrases } from "@/lib/taxWords";

const subscribe = (cb: () => void) => { window.addEventListener("online", cb); window.addEventListener("offline", cb); return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); }; };
const useOnline = () => useSyncExternalStore(subscribe, () => navigator.onLine, () => true);

const CHIPS = ["Wrong item", "Wrong quantity", "Customer changed order", "Price mistake", "Other"] as const;
const when = (iso?: string | null) => formatDateTime(iso);
const pctLabel = (code: string, rate: string, country?: string | null) => { const t = taxPhrases(country); return code === "none" ? t.none : `${t.word} ${Number(rate)}%`; };

interface EditLine { key: string; billLineId: string | null; itemId: string; variantId: string | null; name: string; qty: number; override: string; overrideReason: string; overriding: boolean }

function fromBill(bill: Bill): EditLine[] {
  return bill.lines.filter((l) => l.id && l.item_id).map((l) => ({ key: l.id!, billLineId: l.id!, itemId: l.item_id!, variantId: null, name: l.description, qty: l.quantity, override: "", overrideReason: "", overriding: false }));
}

/** Menu picker: search + category pills + photos. Variants are chosen on a second step. */
function ItemPicker({ open, onClose, onPick, title }: { open: boolean; onClose: () => void; onPick: (item: MenuItem, variantId: string | null) => void; title: string }) {
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [cats, setCats] = useState<Category[]>([]);
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");
  const [variantOf, setVariantOf] = useState<MenuItem | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open || items) return;
    let off = false;
    void Promise.all([api.items(), api.categories()]).then(([i, c]) => { if (!off) { setItems(i.filter((x) => x.is_active)); setCats(c); } }, (e) => { if (!off) setErr(e instanceof ApiError ? e.message : "Could not load the menu"); });
    return () => { off = true; };
  }, [open, items]);
  const catName = useMemo(() => new Map(cats.map((c) => [c.id, c.name])), [cats]);
  const shown = (items ?? []).filter((i) => (cat === "all" || i.category_id === cat) && i.name.toLowerCase().includes(q.trim().toLowerCase()));
  const close = () => { setVariantOf(null); setQ(""); onClose(); };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }} title={variantOf ? `${variantOf.name}: choose an option` : title}>
      {err && <Notice tone="danger">{err}</Notice>}
      {!items && !err && <div role="status" aria-label="Loading menu" className="grid grid-cols-2 gap-2"><Skeleton className="h-24 rounded-xl" /><Skeleton className="h-24 rounded-xl" /></div>}
      {items && !variantOf && (
        <div className="space-y-3 pb-3">
          <Input label="Search the menu" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. salad" />
          <PillTabs label="Category" value={cat} onChange={setCat} options={[{ value: "all", label: "All" }, ...cats.map((c) => ({ value: c.id, label: c.name }))]} />
          {shown.length === 0 ? <p className="py-6 text-center text-sm text-fg-muted">No dishes match.</p> : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {shown.map((i) => (
                <li key={i.id}>
                  <button type="button" aria-label={`${i.name}, ${formatCurrency(i.price)}`} onClick={() => { if (i.variants.length) setVariantOf(i); else { onPick(i, null); close(); } }}
                    className="flex h-full w-full flex-col gap-1.5 rounded-xl border border-border bg-surface p-2 text-left transition-colors hover:border-primary hover:bg-surface-2">
                    <FoodImage src={i.thumb_url ?? i.image_url} name={i.name} category={catName.get(i.category_id)} className="aspect-[4/3] w-full rounded-lg" />
                    <span className="line-clamp-2 text-sm font-semibold text-fg">{i.name}</span>
                    <span className="tnum text-xs text-fg-muted">{formatCurrency(i.price)}{i.variants.length > 0 && " · options"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {variantOf && (
        <ul className="space-y-2 pb-3">
          <li><Button className="w-full" variant="secondary" onClick={() => { onPick(variantOf, null); close(); }}>{variantOf.name} <span className="tnum text-fg-muted">{formatCurrency(variantOf.price)}</span></Button></li>
          {variantOf.variants.map((v) => (
            <li key={v.id}><Button className="w-full" variant="secondary" onClick={() => { onPick(variantOf, v.id); close(); }}>{v.name} <span className="tnum text-fg-muted">+{formatCurrency(v.price_delta)}</span></Button></li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function Delta({ value, currency }: { value: string; currency: string }) {
  const c = cmpMoney(value, 0);
  return <span className={c < 0 ? "text-success-fg" : c > 0 ? "text-warning-fg" : "text-fg-subtle"}>{c > 0 ? "+" : ""}{formatCurrency(value, currency)}</span>;
}

/**
 * "Edit this bill" (owner / manager). The user edits items like on a new bill; saving issues a credit note for the
 * original and a replacement invoice (original date kept, GST recomputed server-side). The original stays on record.
 */
export function AmendBillDialog({ bill, open, onClose, onDone }: { bill: Bill; open: boolean; onClose: () => void; onDone: (r: AmendResult) => void }) {
  const confirm = useConfirm();
  const online = useOnline();
  const { feature } = useCan();
  const discountOn = feature("billing.discount"), serviceChargeOn = feature("billing.service_charge"); // Manage > Features
  const [opts, setOpts] = useState<AmendOptions | null>(null);
  const [optsErr, setOptsErr] = useState<string | null>(null);
  const [lines, setLines] = useState<EditLine[]>(() => fromBill(bill));
  const [picker, setPicker] = useState<{ mode: "add" } | { mode: "swap"; key: string } | null>(null);
  const [discMode, setDiscMode] = useState<"keep" | "none" | "custom">("keep");
  const [dType, setDType] = useState<"percent" | "amount">("percent");
  const [dValue, setDValue] = useState("");
  const [dReason, setDReason] = useState("");
  const [scTouched, setScTouched] = useState(false);
  const [scOn, setScOn] = useState(Number(bill.service_charge_percent ?? 0) > 0);
  const [preview, setPreview] = useState<AmendPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chip, setChip] = useState<(typeof CHIPS)[number] | null>(null);
  const [note, setNote] = useState("");
  const [refundMethod, setRefundMethod] = useState<"cash" | "card" | "other" | "">("");
  const [result, setResult] = useState<AmendResult | null>(null);
  const [payBusy, setPayBusy] = useState(false);
  const [paid, setPaid] = useState<string | null>(null);
  const key = useRef(uuid());
  const hadDiscount = Number(bill.discount_amount ?? 0) > 0;
  const dineIn = bill.order_type === "indoor" || bill.order_type === "outdoor";
  const hasSc = Number(bill.service_charge_percent ?? 0) > 0 || dineIn;
  const [tables, setTables] = useState<DiningTable[]>([]);
  const [tableId, setTableId] = useState("");  // "" = keep the original table
  // "Table AC1 · Indoor": the table's own area (the server derives the bill's type from it); takeaway / delivery by name.
  const whereOf = (label: string | null | undefined, type: string | null | undefined) =>
    orderWhere({ order_type: type, table_id: label ? "x" : null }, label ? tables.find((t) => t.label === label) ?? { label } : null);

  useEffect(() => {
    if (!open) return;
    let off = false;
    void api.amendOptions(bill.id).then((o) => { if (!off) { setOpts(o); setOptsErr(null); } }, (e) => { if (!off) setOptsErr(e instanceof ApiError ? e.message : "Could not check whether this bill can be corrected"); });
    if (dineIn) void api.tables().then((t) => { if (!off) setTables(t.filter((x) => x.is_active !== false && (x.area === "indoor" || x.area === "outdoor"))); }, () => {});
    return () => { off = true; };
  }, [open, bill.id, dineIn]);

  const request: AmendRequest = useMemo(() => {
    const r: AmendRequest = {
      lines: lines.map((l): AmendLineInput => ({
        bill_line_id: l.billLineId, item_id: l.itemId, variant_id: l.variantId, quantity: l.qty,
        ...(l.overriding && l.override.trim() ? { unit_price_override: l.override.trim(), override_reason: l.overrideReason.trim() } : {}),
      })),
    };
    if (discMode === "none") r.discount = null;
    else if (discMode === "custom") r.discount = dValue.trim() ? { type: dType, value: dValue.trim(), reason: dReason.trim() } : null;
    if (scTouched) r.service_charge = scOn;
    if (tableId) r.table_id = tableId;
    return r;
  }, [lines, discMode, dType, dValue, dReason, scTouched, scOn, tableId]);
  const reqKey = JSON.stringify(request);

  // Live preview: prices and GST come from the server for the current lines (nothing is saved).
  useEffect(() => {
    if (!open || !online || (opts && !opts.amendable) || result) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api.amendPreview(bill.id, JSON.parse(reqKey) as AmendRequest, ctrl.signal).then(
        (p) => { setPreview(p); setPreviewErr(null); },
        (e) => { if (e instanceof DOMException && e.name === "AbortError") return; setPreviewErr(e instanceof ApiError ? e.message : "Could not work out the corrected bill"); });
    }, 200);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [open, online, opts, reqKey, bill.id, result]);

  const cur = bill.currency;
  const d = preview?.diff;
  const refundDue = d && cmpMoney(d.refund_due, 0) > 0;
  const balanceDue = d && cmpMoney(d.balance_due, 0) > 0;
  const refundable = preview?.refundable_by_method ?? opts?.refundable_by_method;
  const methodOk = (m: "cash" | "card" | "other") => !d || !refundable || cmpMoney(refundable[m] ?? "0", d.refund_due) >= 0;
  const reason = chip ? (note.trim() ? `${chip}: ${note.trim()}` : chip) : note.trim();
  const reasonOk = reason.length >= 3 && !(chip === "Other" && note.trim().length < 3);
  const overrideBad = lines.some((l) => l.overriding && l.override.trim() && l.overrideReason.trim().length < 3);
  const changed = preview ? JSON.stringify(preview.lines.map((l) => [l.bill_line_id, l.item_id, l.quantity, l.unit_price])) !== JSON.stringify(bill.lines.map((l) => [l.id, l.item_id, l.quantity, l.unit_price])) || cmpMoney(preview.total, bill.total) !== 0 : false;
  const effMethod = refundDue ? (refundMethod && methodOk(refundMethod) ? refundMethod : (["cash", "card", "other"] as const).find(methodOk) ?? "") : "";
  const moved = !!preview && (preview.table_label !== (bill.table_label ?? null) || preview.order_type !== (bill.order_type ?? null));
  const canSave = online && !!preview && !previewErr && (opts?.amendable ?? false) && reasonOk && !overrideBad && !busy && (!refundDue || !!effMethod) && (changed || moved || discMode !== "keep" || scTouched);

  const setLine = (k: string, patch: Partial<EditLine>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));

  function picked(item: MenuItem, variantId: string | null) {
    const p = picker; if (!p) return;
    const name = variantId ? `${item.name} (${item.variants.find((v) => v.id === variantId)?.name ?? ""})` : item.name;
    if (p.mode === "swap") setLine(p.key, { itemId: item.id, variantId, name, override: "", overriding: false, overrideReason: "" });
    else setLines((ls) => [...ls, { key: uuid(), billLineId: null, itemId: item.id, variantId, name, qty: 1, override: "", overrideReason: "", overriding: false }]);
  }

  async function save() {
    if (!preview) return;
    const orig = when(bill.sale_at ?? bill.finalized_at);
    const ok = await confirm({
      title: `Correct bill ${bill.invoice_number}?`, confirmLabel: "Issue credit note and new invoice",
      description: `This creates a credit note (CN-…) that cancels ${bill.invoice_number}, and a replacement invoice (INV-…) dated ${orig}. The original stays on record. ` +
        (refundDue ? `${formatCurrency(preview.diff.refund_due, cur)} is returned to the customer by ${effMethod}.` : balanceDue ? `The customer owes ${formatCurrency(preview.diff.balance_due, cur)}.` : "No money changes hands."),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.amend(bill.id, { ...request, reason, idempotency_key: key.current, ...(refundDue && effMethod ? { refund_method: effMethod } : {}) });
      setResult(r);
      toast.success(`Corrected: ${r.replacement.invoice_number} replaces ${r.credit_note.invoice_number}`);
      onDone(r);
    } catch (e) { toast.error(e instanceof ApiError ? e.message : "Could not correct the bill"); }
    finally { setBusy(false); }
  }

  async function takePayment(method: "cash" | "card") {
    if (!result) return;
    setPayBusy(true);
    try {
      const amount = result.replacement.balance_due;
      await api.pay(result.replacement.id, { idempotency_key: uuid(), method, amount });
      setPaid(`${formatCurrency(amount, cur)} ${method}`);
      const fresh = await api.bill(result.replacement.id);
      setResult({ ...result, replacement: fresh });
      onDone({ ...result, replacement: fresh });
    } catch (e) { toast.error(e instanceof ApiError ? e.message : "Could not take the payment"); }
    finally { setPayBusy(false); }
  }

  const blocked = opts && !opts.amendable;
  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}
        title={result ? "Bill corrected" : `Edit bill ${bill.invoice_number}`}
        description={result ? undefined : `Sale of ${when(bill.sale_at ?? bill.finalized_at)}${` · ${whereOf(bill.table_label, bill.order_type)}`}${bill.customer_name || bill.customer_phone ? ` · ${bill.customer_name || bill.customer_phone}` : ""}`}
        footer={result ? <Button variant="primary" className="w-full" onClick={onClose}>Done</Button> : (
          <>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!canSave} data-testid="amend-save">Save correction</Button>
          </>)}>
        {!online && <div className="mb-3"><Notice tone="warning" title="You are offline">Corrections need a connection to the server. Reconnect to edit this bill.</Notice></div>}
        {optsErr && <div className="mb-3"><Notice tone="danger">{optsErr}</Notice></div>}
        {blocked && <div className="mb-3"><Notice tone="warning" title="This bill can't be corrected">{opts.reason_if_not}</Notice></div>}

        {result ? (
          <div className="space-y-3 pb-3 text-sm" data-testid="amend-result">
            <Notice tone="success" title={`${result.replacement.invoice_number} replaces ${result.credit_note.invoice_number}`}>
              Credit note {result.credit_note.credit_note_number} cancels the original. The new invoice keeps the sale date ({when(result.replacement.sale_at)}). The original stays on record.
            </Notice>
            {result.refund && <Notice tone="info" title={`Return ${formatCurrency(result.refund.amount, cur)} to the customer`}>Pay it back by {result.refund.method}. It is recorded on {result.refund.credit_note_number}.</Notice>}
            <BillSummary bill={result.replacement} />
            {cmpMoney(result.replacement.balance_due, 0) > 0 ? (
              <div className="space-y-2 rounded-xl border border-warning/40 bg-warning-soft p-3">
                <p className="font-semibold text-warning-fg">Customer owes {formatCurrency(result.replacement.balance_due, cur)}</p>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="primary" onClick={() => void takePayment("cash")} loading={payBusy}>Take cash</Button>
                  <Button variant="secondary" onClick={() => void takePayment("card")} loading={payBusy}>Take card</Button>
                </div>
              </div>
            ) : <Badge tone="success"><CircleCheck />{paid ? `Paid ${paid}` : "Settled"}</Badge>}
            <BillActions bill={result.replacement} />
          </div>
        ) : (
          <div className="grid gap-4 pb-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <div className="space-y-3">
              <ul className="space-y-2" aria-label="Bill lines">
                {lines.map((l, idx) => {
                  const pl = preview?.lines[idx];
                  return (
                    <li key={l.key} data-testid="amend-line" className="rounded-xl border border-border bg-surface p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-fg">{pl?.description ?? l.name}</p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
                            <span className="tnum">{pl ? formatCurrency(pl.unit_price, cur) : "…"} each</span>
                            {pl && <Badge tone={pl.tax_code === "zero" ? "info" : "neutral"}><span data-testid="line-vat">{pctLabel(pl.tax_code, pl.rate_percent, bill.country)}</span></Badge>}
                            {pl?.price_source === "override" && <Badge tone="warning">Price overridden</Badge>}
                            {pl && !pl.kept && pl.price_source === "menu" && <Badge tone="primary">Menu price</Badge>}
                          </p>
                        </div>
                        <p className="tnum shrink-0 font-semibold text-fg">{pl ? formatCurrency(pl.line_total, cur) : ""}</p>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <QtyStepper value={l.qty} min={1} max={999} size="sm" incLabel={`Add one ${l.name}`} decLabel={`Remove one ${l.name}`}
                          onIncrement={() => setLine(l.key, { qty: l.qty + 1 })} onDecrement={() => setLine(l.key, { qty: Math.max(1, l.qty - 1) })} />
                        <Button size="sm" variant="secondary" iconStart={<Repeat />} onClick={() => setPicker({ mode: "swap", key: l.key })}>Change item</Button>
                        <Button size="sm" variant="ghost" iconStart={<PencilLine />} onClick={() => setLine(l.key, { overriding: !l.overriding })} aria-expanded={l.overriding}>Override price</Button>
                        <Button size="sm" variant="ghost" iconStart={<Trash2 />} disabled={lines.length === 1} aria-label={`Remove ${l.name}`}
                          onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>Remove</Button>
                      </div>
                      {l.overriding && (
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <Input label="Unit price" inputMode="decimal" value={l.override} onChange={(e) => setLine(l.key, { override: e.target.value.replace(/[^0-9.]/g, "") })} placeholder={pl?.unit_price} hint={`${taxPhrases(bill.country).word} is worked out from this price.`} />
                          <Input label="Reason for the new price" value={l.overrideReason} onChange={(e) => setLine(l.key, { overrideReason: e.target.value })} placeholder="e.g. Manager price match" />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              <Button variant="secondary" iconStart={<Plus />} onClick={() => setPicker({ mode: "add" })} data-testid="amend-add-item">Add item</Button>

              {dineIn && (
                <div className="space-y-2 rounded-xl border border-border bg-surface-2/50 p-3">
                  <Select label="Table" value={tableId} onChange={(e) => setTableId(e.target.value)} data-testid="amend-table"
                    hint="Moving to an outdoor table makes it an outdoor bill, and the other way round.">
                    <option value="">{bill.table_label ? `Keep ${whereOf(bill.table_label, bill.order_type)}` : "Keep as it is"}</option>
                    {(["indoor", "outdoor"] as const).map((area) => {
                      const ts = tables.filter((t) => t.area === area && t.label !== bill.table_label);
                      return ts.length ? <optgroup key={area} label={area === "indoor" ? "Indoor" : "Outdoor"}>{ts.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</optgroup> : null;
                    })}
                  </Select>
                </div>
              )}

              {(discountOn || (hasSc && serviceChargeOn)) && <div className="space-y-2 rounded-xl border border-border bg-surface-2/50 p-3">
                {discountOn && <><p className="text-sm font-semibold text-fg">Discount</p>
                <SegmentedControl label="Discount" size="md" value={discMode} onChange={setDiscMode}
                  options={[...(hadDiscount ? [{ value: "keep" as const, label: "Keep original" }] : []), { value: "none" as const, label: "None" }, { value: "custom" as const, label: "Custom" }]} />
                {discMode === "custom" && (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <Select label="Type" value={dType} onChange={(e) => setDType(e.target.value as "percent" | "amount")}><option value="percent">Percent %</option><option value="amount">Amount</option></Select>
                    <Input label="Value" inputMode="decimal" value={dValue} onChange={(e) => setDValue(e.target.value.replace(/[^0-9.]/g, ""))} />
                    <Input label="Reason" value={dReason} onChange={(e) => setDReason(e.target.value)} />
                  </div>
                )}</>}
                {hasSc && serviceChargeOn && <Switch label="Service charge" hint="Recomputed from the original bill's percentage." checked={scOn} onChange={(e) => { setScOn(e.target.checked); setScTouched(true); }} />}
              </div>}
            </div>

            <aside className="space-y-3" aria-label="Before and after">
              {previewErr && <Notice tone="danger">{previewErr}</Notice>}
              <div className="rounded-xl border border-border bg-surface p-3 text-sm" data-testid="amend-diff">
                <p className="mb-2 font-semibold text-fg">Before → after</p>
                {!d ? <Skeleton className="h-24 rounded-lg" /> : (
                  <dl className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2"><dt className="text-fg-muted">Total</dt><dd className="tnum flex items-center gap-1.5">{formatCurrency(d.old_total, cur)}<ArrowRight aria-hidden className="size-3.5 text-fg-subtle" /><b data-testid="new-total">{formatCurrency(d.new_total, cur)}</b></dd></div>
                    <div className="flex items-center justify-between gap-2"><dt className="text-fg-muted">{taxPhrases(bill.country).word}</dt><dd className="tnum flex items-center gap-1.5">{formatCurrency(d.old_vat, cur)}<ArrowRight aria-hidden className="size-3.5 text-fg-subtle" /><b data-testid="new-vat">{formatCurrency(d.new_vat, cur)}</b></dd></div>
                    <div className="flex items-center justify-between gap-2 border-t border-dashed border-border-strong pt-1.5"><dt className="text-fg-muted">Change</dt><dd className="tnum font-semibold" data-testid="delta"><Delta value={d.delta} currency={cur} /></dd></div>
                    {moved && preview && <div className="flex items-center justify-between gap-2"><dt className="text-fg-muted">Table</dt><dd className="flex items-center gap-1.5">{whereOf(bill.table_label, bill.order_type)}<ArrowRight aria-hidden className="size-3.5 text-fg-subtle" /><b data-testid="new-table">{whereOf(preview.table_label, preview.order_type)}</b></dd></div>}
                    <div className="flex items-center justify-between gap-2"><dt className="text-fg-muted">Paid so far</dt><dd className="tnum">{formatCurrency(d.paid, cur)}</dd></div>
                  </dl>
                )}
                {refundDue && d && <div className="mt-3"><Notice tone="info" title={`Refund ${formatCurrency(d.refund_due, cur)} to customer`}>
                  <Select label="Return it by" value={effMethod} onChange={(e) => setRefundMethod(e.target.value as "cash" | "card" | "other")}>
                    {(["cash", "card", "other"] as const).map((m) => <option key={m} value={m} disabled={!methodOk(m)}>{m[0].toUpperCase() + m.slice(1)}{refundable ? ` (paid ${formatCurrency(refundable[m], cur)})` : ""}</option>)}
                  </Select>
                </Notice></div>}
                {balanceDue && d && <div className="mt-3"><Notice tone="warning" title={`Customer owes ${formatCurrency(d.balance_due, cur)}`}>You can take the payment right after saving.</Notice></div>}
              </div>

              {preview && preview.stock_impact.length > 0 && (
                <div className="rounded-xl border border-border bg-surface-2/50 p-3 text-xs text-fg-muted" data-testid="stock-impact">
                  <p className="mb-1 font-semibold text-fg">Stock impact</p>
                  <ul className="space-y-0.5">{preview.stock_impact.map((s) => <li key={s.item_id} className="flex justify-between gap-2"><span>{s.item_name}</span><span className="tnum">{Number(s.delta_base_quantity) > 0 ? "+" : ""}{Number(s.delta_base_quantity)} {s.unit}</span></li>)}</ul>
                </div>
              )}

              <div className="space-y-2">
                <p className="text-sm font-semibold text-fg">Why is this bill being corrected?</p>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Reason">
                  {CHIPS.map((c) => (
                    <button key={c} type="button" aria-pressed={chip === c} onClick={() => setChip(chip === c ? null : c)}
                      className={`min-h-9 rounded-full border px-3 text-xs font-semibold transition-colors ${chip === c ? "border-primary bg-primary text-primary-fg" : "border-border bg-surface text-fg-muted hover:bg-surface-2"}`}>{c}</button>
                  ))}
                </div>
                <Input label="Note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={250} placeholder={chip === "Other" || !chip ? "Required (at least 3 characters)" : "Optional detail"} />
              </div>
            </aside>
          </div>
        )}
      </Dialog>
      <ItemPicker open={picker !== null} title={picker?.mode === "swap" ? "Change item" : "Add item"} onClose={() => setPicker(null)} onPick={picked} />
    </>
  );
}
