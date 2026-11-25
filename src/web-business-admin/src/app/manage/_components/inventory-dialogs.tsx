"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Controller, useForm, useWatch, type UseFormRegisterReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowDownRight, ArrowUpRight, ClipboardCheck, FileText, Minus, ReceiptText, SlidersHorizontal, Trash2, Truck, Undo2 } from "lucide-react";
import { Badge, type BadgeTone, Button, Dialog, Input, Notice, Select, Sheet, Table } from "@chilli/ui";
import { Money, SegmentedControl, Skeleton, toast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";
import { mulDecimal } from "@/lib/decimal";
import type { CountResult, InventoryItem, Movement, MovementKind, Supplier } from "@/lib/types";
import { friendly } from "./ReorderEmailDialog";
import { BASE_LABEL, prettyQty, unitsFor } from "@/lib/units";
import { uuid } from "@/lib/uuid";

const QTY = /^\d+(\.\d{1,3})?$/;
const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Please try again.");

/** A key generated once per dialog open and reused for retries, so a double submit can never post twice. */
function useOpenKey(open: boolean) {
  const key = useRef("");
  useEffect(() => { if (open) key.current = uuid(); }, [open]);
  return key;
}

/** Active suppliers for the "Usual supplier" select (loaded when the dialog opens; empty list on failure). */
function useSuppliers(open: boolean) {
  const [list, setList] = useState<Supplier[]>([]);
  useEffect(() => { if (open) api.suppliers().then(setList).catch(() => setList([])); }, [open]);
  return list;
}

const reorderQtySchema = {
  supplier_id: z.string(),
  reorder_quantity: z.string().trim().refine((v) => v === "" || (QTY.test(v) && Number(v) > 0), "Use a number above 0, or leave empty"),
  reorder_unit: z.string(),
};

/** Usual supplier + how much to ask for: who gets the re-order email when this item runs low. */
function ReorderFields({ supplier, qty, unitField, qtyError, suppliers, unit, hint, auto }: {
  supplier: UseFormRegisterReturn; qty: UseFormRegisterReturn; unitField: UseFormRegisterReturn; qtyError?: string; suppliers: Supplier[]; unit: string; hint?: string; auto?: boolean;
}) {
  return (
    <fieldset className="space-y-3 rounded-xl border border-border p-3">
      <legend className="px-1 text-sm font-medium text-fg">Re-ordering</legend>
      <Select label="Usual supplier" hint={auto ? "Set from your latest invoice. Choose one to keep it." : "Gets the re-order email when this item runs low."} {...supplier}>
        <option value="">None</option>
        {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.email ? "" : " (no email)"}</option>)}
      </Select>
      <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-3">
        <Input label="Order quantity" inputMode="decimal" placeholder="Suggested" hint={hint ?? "How much to ask for. Empty = suggested."} error={qtyError} {...qty} />
        <Select label="Unit" {...unitField}>{unitsFor(unit).map((u) => <option key={u}>{u}</option>)}</Select>
      </div>
    </fieldset>
  );
}

/* ------------------------------------------------------------------ add item */
const itemSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(200),
  base_unit: z.enum(["g", "ml", "pcs"]),
  reorder_level: z.string().trim().regex(QTY, "Use a number such as 500"),
  ...reorderQtySchema,
});
type ItemForm = z.infer<typeof itemSchema>;

export function AddItemDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const { register, control, handleSubmit, reset, setValue, formState: { errors, isSubmitting } } = useForm<ItemForm>({
    resolver: zodResolver(itemSchema), defaultValues: { name: "", base_unit: "g", reorder_level: "0", supplier_id: "", reorder_quantity: "", reorder_unit: "g" },
  });
  const [err, setErr] = useState<string | null>(null);
  const suppliers = useSuppliers(open);
  useEffect(() => { if (open) { reset(); void Promise.resolve().then(() => setErr(null)); } }, [open, reset]);
  const unit = useWatch({ control, name: "base_unit" });
  useEffect(() => { setValue("reorder_unit", unit); }, [unit, setValue]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add inventory item" description="Stock is always counted in one base unit; purchases and recipes convert automatically."
      footer={<>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" type="submit" form="add-item-form" loading={isSubmitting}>Add item</Button>
      </>}>
      <form id="add-item-form" className="space-y-4 py-2" noValidate onSubmit={handleSubmit(async (v) => {
        setErr(null);
        try {
          await api.createInventoryItem({ name: v.name, base_unit: v.base_unit, reorder_level: v.reorder_level,
            ...(v.supplier_id ? { supplier_id: v.supplier_id } : {}), ...(v.reorder_quantity ? { reorder_quantity: v.reorder_quantity, reorder_unit: v.reorder_unit } : {}) });
          toast.success(`${v.name} added`); onOpenChange(false); onDone();
        } catch (e) { setErr(msg(e)); }
      })}>
        {err && <Notice tone="danger">{err}</Notice>}
        <Input label="Name" placeholder="e.g. Milk" autoFocus error={errors.name?.message} {...register("name")} />
        <div className="flex flex-col gap-1.5">
          <span id="base-unit-label" className="text-sm font-medium text-fg">Base unit</span>
          <Controller control={control} name="base_unit" render={({ field }) => (
            <SegmentedControl label="Base unit" block value={field.value} onChange={field.onChange}
              options={[{ value: "g", label: "g" }, { value: "ml", label: "ml" }, { value: "pcs", label: "pcs" }]} />)} />
          <p className="text-xs text-fg-subtle">{BASE_LABEL[unit]}. Cannot be changed later.</p>
        </div>
        <Input label={`Reorder level (${unit})`} inputMode="decimal" hint="You get a low-stock alert when the balance falls to this level." error={errors.reorder_level?.message} {...register("reorder_level")} />
        <ReorderFields supplier={register("supplier_id")} qty={register("reorder_quantity")} unitField={register("reorder_unit")} qtyError={errors.reorder_quantity?.message} suppliers={suppliers} unit={unit} />
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ adjustment / wastage */
const adjSchema = z.object({
  item_id: z.string().min(1, "Choose an item"),
  kind: z.enum(["wastage", "adjustment"]),
  quantity: z.string().trim().regex(/^-?\d+(\.\d{1,3})?$/, "Enter a number such as 250"),
  unit: z.string().min(1),
  reason: z.string().trim().min(3, "Give a short reason (3+ characters)").max(300),
}).superRefine((v, ctx) => {
  const n = Number(v.quantity);
  if (!(n !== 0)) ctx.addIssue({ code: "custom", path: ["quantity"], message: "Quantity cannot be zero" });
  else if (v.kind === "wastage" && n < 0) ctx.addIssue({ code: "custom", path: ["quantity"], message: "Enter wastage as a positive amount" });
});
type AdjForm = z.infer<typeof adjSchema>;

export function AdjustDialog({ open, onOpenChange, items, initialItemId, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; items: InventoryItem[]; initialItemId?: string; onDone: () => void }) {
  const key = useOpenKey(open);
  const { register, control, handleSubmit, reset, setValue, formState: { errors, isSubmitting } } = useForm<AdjForm>({
    resolver: zodResolver(adjSchema), defaultValues: { item_id: "", kind: "wastage", quantity: "", unit: "g", reason: "" },
  });
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const it = items.find((i) => i.id === initialItemId);
    reset({ item_id: initialItemId ?? "", kind: "wastage", quantity: "", unit: it?.base_unit ?? "g", reason: "" });
    void Promise.resolve().then(() => setErr(null));
  }, [open, initialItemId, items, reset]);
  const itemId = useWatch({ control, name: "item_id" }), kind = useWatch({ control, name: "kind" });
  const item = items.find((i) => i.id === itemId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Wastage or adjustment" description="Every change is written to the stock ledger and cannot be edited later."
      footer={<>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" type="submit" form="adjust-form" loading={isSubmitting}>{kind === "wastage" ? "Record wastage" : "Post adjustment"}</Button>
      </>}>
      <form id="adjust-form" className="space-y-4 py-2" noValidate onSubmit={handleSubmit(async (v) => {
        setErr(null);
        try {
          await api.adjust({ idempotency_key: key.current, item_id: v.item_id, kind: v.kind, quantity: v.quantity, unit: v.unit, reason: v.reason });
          toast.success(v.kind === "wastage" ? "Wastage recorded" : "Adjustment posted"); onOpenChange(false); onDone();
        } catch (e) { setErr(msg(e)); }
      })}>
        {err && <Notice tone="danger">{err}</Notice>}
        <Select label="Item" error={errors.item_id?.message} {...register("item_id", { onChange: (e) => { const it = items.find((i) => i.id === e.target.value); if (it) setValue("unit", it.base_unit); } })}>
          <option value="">Choose item…</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </Select>
        {item && <p className="-mt-2 text-xs text-fg-subtle">Currently {prettyQty(item.balance, item.base_unit)} in stock.</p>}
        <Controller control={control} name="kind" render={({ field }) => (
          <SegmentedControl label="Type" block value={field.value} onChange={field.onChange}
            options={[{ value: "wastage", label: "Wastage" }, { value: "adjustment", label: "Adjustment" }]} />)} />
        <p className="-mt-2 text-xs text-fg-subtle">{kind === "wastage" ? "Spoiled, dropped or staff meals. Reduces stock." : "Correct the balance. Use a negative number to reduce, positive to add."}</p>
        <div className="grid grid-cols-[1fr_6.5rem] gap-3">
          <Input label="Quantity" inputMode="decimal" placeholder={kind === "wastage" ? "250" : "-100 or 100"} error={errors.quantity?.message} {...register("quantity")} />
          <Select label="Unit" {...register("unit")}>{unitsFor(item?.base_unit).map((u) => <option key={u}>{u}</option>)}</Select>
        </div>
        <Input label="Reason" placeholder="e.g. Spilled during prep" error={errors.reason?.message} {...register("reason")} />
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ stock count */
export function CountDialog({ open, onOpenChange, items, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; items: InventoryItem[]; onDone: () => void }) {
  const key = useOpenKey(open);
  const [vals, setVals] = useState<Record<string, { counted: string; unit: string }>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<CountResult[] | null>(null);
  useEffect(() => { if (open) void Promise.resolve().then(() => { setVals({}); setErr(null); setResult(null); }); }, [open]);

  const filled = useMemo(() => items.filter((i) => (vals[i.id]?.counted ?? "").trim() !== ""), [items, vals]);
  const invalid = filled.some((i) => !QTY.test(vals[i.id].counted.trim()));
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  async function post() {
    setBusy(true); setErr(null);
    try {
      const r = await api.stockCount({ idempotency_key: key.current, lines: filled.map((i) => ({ item_id: i.id, counted: vals[i.id].counted.trim(), unit: vals[i.id].unit || i.base_unit })) });
      setResult(r); onDone();
      toast.success("Stock count posted");
    } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={result ? "Count results" : "Stock count"}
      description={result ? "The ledger now matches what you counted. Differences were posted as count movements." : "Count what is physically on the shelf. Leave items you did not count blank."}
      footer={result ? <Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button> : <>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" iconStart={<ClipboardCheck />} loading={busy} disabled={!filled.length || invalid} onClick={() => void post()}>Post count ({filled.length})</Button>
      </>}>
      <div className="py-2">
        {err && <div className="mb-3"><Notice tone="danger">{err}</Notice></div>}
        {result ? (
          <Table caption="Count results" getKey={(r) => r.item_id} rows={result} columns={[
            { key: "item", header: "Item", render: (r) => <span className="font-medium">{byId.get(r.item_id)?.name ?? "Item"}</span> },
            { key: "exp", header: "Expected", align: "end", render: (r) => prettyQty(r.expected, byId.get(r.item_id)?.base_unit ?? "") },
            { key: "cnt", header: "Counted", align: "end", render: (r) => prettyQty(r.counted, byId.get(r.item_id)?.base_unit ?? "") },
            { key: "diff", header: "Difference", align: "end", render: (r) => {
              const d = Number(r.difference); const u = byId.get(r.item_id)?.base_unit ?? "";
              return <Badge tone={d === 0 ? "success" : d < 0 ? "danger" : "warning"}>{d === 0 ? <Minus /> : d < 0 ? <ArrowDownRight /> : <ArrowUpRight />}{d === 0 ? "Matches" : `${d > 0 ? "+" : ""}${prettyQty(r.difference, u)}`}</Badge>;
            } },
          ]} />
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {items.map((i) => {
              const v = vals[i.id] ?? { counted: "", unit: i.base_unit };
              const bad = v.counted.trim() !== "" && !QTY.test(v.counted.trim());
              return (
                <li key={i.id} className="grid grid-cols-[1fr_6rem_5.5rem] items-center gap-2 px-3 py-2 sm:grid-cols-[1fr_8rem_6.5rem_7rem]">
                  <div className="min-w-0 sm:col-span-1"><p className="truncate text-sm font-medium text-fg">{i.name}</p><p className="tnum text-xs text-fg-subtle sm:hidden">System {prettyQty(i.balance, i.base_unit)}</p></div>
                  <p className="tnum hidden text-right text-xs text-fg-subtle sm:block">System {prettyQty(i.balance, i.base_unit)}</p>
                  <input aria-label={`Counted ${i.name}`} inputMode="decimal" placeholder="Counted" aria-invalid={bad || undefined} value={v.counted}
                    onChange={(e) => setVals((s) => ({ ...s, [i.id]: { ...v, counted: e.target.value } }))}
                    className="tnum h-11 w-full rounded-lg border border-border-strong bg-surface px-3 text-base text-fg placeholder:text-fg-subtle focus:border-ring focus:outline-none focus:ring-3 focus:ring-ring/25 aria-[invalid=true]:border-danger sm:text-sm" />
                  <select aria-label={`Unit for ${i.name}`} value={v.unit || i.base_unit} onChange={(e) => setVals((s) => ({ ...s, [i.id]: { ...v, unit: e.target.value } }))}
                    className="h-11 w-full rounded-lg border border-border-strong bg-surface px-2 text-base text-fg sm:text-sm">{unitsFor(i.base_unit).map((u) => <option key={u}>{u}</option>)}</select>
                </li>);
            })}
          </ul>
        )}
        {!result && invalid && <p role="alert" className="mt-2 text-xs font-medium text-danger-fg">Counted values must be numbers such as 1200 or 2.5.</p>}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ ledger */
const MOVE: Record<MovementKind, { label: string; tone: BadgeTone; icon: ReactNode }> = {
  purchase: { label: "Purchase", tone: "success", icon: <Truck /> }, sale: { label: "Sale", tone: "info", icon: <ReceiptText /> },
  adjustment: { label: "Adjustment", tone: "neutral", icon: <SlidersHorizontal /> }, wastage: { label: "Wastage", tone: "danger", icon: <Trash2 /> },
  count: { label: "Stock count", tone: "primary", icon: <ClipboardCheck /> },
  purchase_return: { label: "Returned to supplier", tone: "warning", icon: <Undo2 /> }, expiry_writeoff: { label: "Expired, written off", tone: "danger", icon: <Trash2 /> },
};
type LedgerFilter = "all" | "purchase" | "sale" | "waste" | "count";
const FILTERS: { value: LedgerFilter; label: string; kinds: MovementKind[] }[] = [
  { value: "all", label: "All", kinds: [] }, { value: "purchase", label: "Purchases", kinds: ["purchase", "purchase_return"] }, { value: "sale", label: "Sales", kinds: ["sale"] },
  { value: "waste", label: "Wastage & adjustments", kinds: ["wastage", "adjustment", "expiry_writeoff"] }, { value: "count", label: "Counts", kinds: ["count"] },
];
const COST_UNIT: Record<string, [string, number]> = { g: ["kg", 1000], ml: ["l", 1000], pcs: ["pcs", 1] };

/** The server words every purchase "Purchase invoice"; a delivery booked on a goods receipt, a return and an expiry write-off get their own words. */
function movementLabel(m: Movement, fallback: string): string {
  if (m.movement_type === "purchase" && m.ref_type === "grn_line" && !m.source?.invoice_id) return "Goods received on a purchase order";
  if (m.movement_type === "purchase_return") return m.note ? `Returned to supplier · ${m.note.replace(/^Return /, "")}` : "Returned to supplier";
  if (m.movement_type === "expiry_writeoff") return m.note ? `Expired batch written off · ${m.note}` : "Expired batch written off";
  return m.source?.label ?? (m.note ? `${fallback} · ${m.note}` : fallback);
}

export function LedgerSheet({ item, onClose, onOpenInvoice }: { item: InventoryItem | null; onClose: () => void; onOpenInvoice?: (invoiceId: string) => void }) {
  const [rows, setRows] = useState<Movement[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [last, setLast] = useState<InventoryItem | null>(null);
  const [filter, setFilter] = useState<LedgerFilter>("all");
  const shown = item ?? last;
  useEffect(() => {
    if (!item) return;
    let off = false;
    void Promise.resolve().then(() => { setLast(item); setRows(null); setErr(null); setFilter("all"); });
    api.inventoryLedger(item.id).then((r) => { if (!off) setRows(r); }).catch((e) => { if (!off) setErr(msg(e)); });
    return () => { off = true; };
  }, [item]);
  const kinds = FILTERS.find((f) => f.value === filter)?.kinds ?? [];
  const list = rows?.filter((m) => !kinds.length || kinds.includes(m.movement_type)) ?? [];
  const base = shown?.base_unit ?? "g";
  return (
    <Sheet side="right" open={!!item} onOpenChange={(o) => { if (!o) onClose(); }} title={shown ? `${shown.name} ledger` : "Ledger"}
      description={shown ? `Every change to this item's stock, newest first. Balance now: ${prettyQty(shown.balance, shown.base_unit)}.` : undefined}>
      <div className="py-2">
        {err && <Notice tone="danger">{err}</Notice>}
        {!rows && !err && <div className="space-y-3" role="status" aria-label="Loading ledger">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>}
        {rows && rows.length > 0 && (
          <div className="mb-2">
            <SegmentedControl label="Show movements" className="flex-wrap" value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ value: f.value, label: f.label }))} />
          </div>
        )}
        {rows && rows.length === 0 && <p className="py-8 text-center text-sm text-fg-muted">No stock movements yet.</p>}
        {rows && rows.length > 0 && list.length === 0 && <p className="py-8 text-center text-sm text-fg-muted">Nothing of this kind yet.</p>}
        {list.length > 0 && (
          <ul className="divide-y divide-border">
            {list.map((m) => {
              const q = Number(m.quantity); const def = MOVE[m.movement_type] ?? MOVE.adjustment;
              const src = m.source;
              const [cu, factor] = COST_UNIT[base] ?? ["", 1];
              return (
                <li key={m.id} className="flex items-start gap-3 py-3">
                  <span aria-hidden className={`mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl [&_svg]:size-4 ${def.tone === "success" ? "bg-success-soft text-success-fg" : def.tone === "info" ? "bg-info-soft text-info-fg" : def.tone === "danger" ? "bg-danger-soft text-danger-fg" : def.tone === "primary" ? "bg-primary-soft text-primary-soft-fg" : "bg-surface-2 text-fg-muted"}`}>{def.icon}</span>
                  <div className="min-w-0 flex-1">
                    <Badge tone={def.tone}>{def.label}</Badge>
                    <p className="mt-1 text-sm font-medium text-fg">{movementLabel(m, def.label)}</p>
                    <p className="mt-0.5 text-xs text-fg-subtle">{formatDateTime(m.created_at)}{src?.user_name && m.movement_type !== "wastage" && m.movement_type !== "adjustment" ? ` · by ${src.user_name}` : ""}</p>
                    {src?.invoice_id && onOpenInvoice && (
                      <button type="button" onClick={() => onOpenInvoice(src.invoice_id!)} aria-label={`Open invoice ${src.invoice_number ?? ""}`.trim()}
                        className="mt-1 inline-flex items-center gap-1 rounded text-xs font-semibold text-primary-soft-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                        <FileText aria-hidden className="size-3.5" />View invoice
                      </button>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={`tnum font-semibold ${q < 0 ? "text-danger-fg" : "text-success-fg"}`}>{q > 0 ? "+" : q < 0 ? "−" : ""}{prettyQty(Math.abs(q), base)}</p>
                    {m.unit_cost && <p className="text-xs text-fg-subtle">@ <Money value={mulDecimal(m.unit_cost, factor)} />{cu ? ` / ${cu}` : ""}</p>}
                  </div>
                </li>);
            })}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ edit item */
const editSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(200, "Keep it under 200 characters"),
  reorder_level: z.string().trim().regex(QTY, "Use a number such as 500"),
  ...reorderQtySchema,
});
type EditForm = z.infer<typeof editSchema>;

/** Rename an item or change its reorder level. The base unit is shown but cannot change (the ledger depends on it). */
export function EditItemDialog({ item, onClose, onDone }: { item: InventoryItem | null; onClose: () => void; onDone: () => void }) {
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<EditForm>({ resolver: zodResolver(editSchema), defaultValues: { name: "", reorder_level: "0", supplier_id: "", reorder_quantity: "", reorder_unit: "g" } });
  const [err, setErr] = useState<string | null>(null);
  const suppliers = useSuppliers(!!item);
  const [last, setLast] = useState<InventoryItem | null>(null);
  useEffect(() => {
    if (!item) return;
    const rq = friendly(item.reorder_quantity, item.base_unit);
    reset({ name: item.name, reorder_level: String(+Number(item.reorder_level).toFixed(3)), supplier_id: item.supplier_id ?? "", reorder_quantity: rq.quantity, reorder_unit: rq.unit });
    void Promise.resolve().then(() => { setErr(null); setLast(item); });
  }, [item, reset]);
  const shown = item ?? last;
  return (
    <Dialog open={!!item} onOpenChange={(o) => { if (!o) onClose(); }} title={shown ? `Edit ${shown.name}` : "Edit item"} description="Change the name, when you get a low-stock alert, and who to re-order from."
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form="edit-inv-form" loading={isSubmitting}>Save changes</Button>
      </>}>
      <form id="edit-inv-form" className="space-y-4 py-2" noValidate onSubmit={handleSubmit(async (v) => {
        if (!item) return;
        setErr(null);
        try {
          const was = friendly(item.reorder_quantity, item.base_unit);
          const qtyChanged = v.reorder_quantity !== was.quantity || (v.reorder_quantity !== "" && v.reorder_unit !== was.unit);
          await api.patchInventoryItem(item.id, {
            name: v.name, reorder_level: v.reorder_level,
            // sent only when changed: choosing a supplier pins it against the automatic link from invoices
            ...(v.supplier_id !== (item.supplier_id ?? "") ? { supplier_id: v.supplier_id || null } : {}),
            ...(qtyChanged ? { reorder_quantity: v.reorder_quantity || null, reorder_unit: v.reorder_unit } : {}),
          });
          toast.success(`${v.name} updated`); onClose(); onDone();
        } catch (e) { setErr(msg(e)); }
      })}>
        {err && <Notice tone="danger">{err}</Notice>}
        <Input label="Name" error={errors.name?.message} {...register("name")} />
        <Input label={`Reorder level (${shown?.base_unit ?? "g"})`} inputMode="decimal" hint="You get a low-stock alert when the balance falls to this level." error={errors.reorder_level?.message} {...register("reorder_level")} />
        <ReorderFields supplier={register("supplier_id")} qty={register("reorder_quantity")} unitField={register("reorder_unit")} qtyError={errors.reorder_quantity?.message} suppliers={suppliers} unit={shown?.base_unit ?? "g"} auto={!!shown?.supplier_id && !shown.supplier_manual}
          hint={shown?.suggested_quantity ? `Empty = ask for about ${prettyQty(shown.suggested_quantity, shown.base_unit)}.` : undefined} />
        <p className="text-xs text-fg-subtle">Counted in {shown ? BASE_LABEL[shown.base_unit].toLowerCase() : "base units"}. The unit cannot be changed once an item has stock history.</p>
      </form>
    </Dialog>
  );
}
