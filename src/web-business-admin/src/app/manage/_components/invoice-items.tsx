"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowRight, PackageOpen, Sparkles, Undo2 } from "lucide-react";
import { Button, Checkbox, Dialog, Input, Notice } from "@chilli/ui";
import { InlineInput, InlineSelect } from "@/components/inline-fields";
import { SegmentedControl, toast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { isDecimal, trimDecimal } from "@/lib/decimal";
import { convertPack } from "@/lib/packConvert";
import { formatCurrency } from "@/lib/money";
import { cleanItemName, normalizedName, parsePack, proposeBaseUnit, suggestItem } from "@/lib/matchItems";
import type { InventoryItem, PackInfo } from "@/lib/types";
import { BASE_LABEL, baseOf, unitsFor, type BaseUnit } from "@/lib/units";
import { uuid } from "@/lib/uuid";

const em = (e: unknown, fb: string) => (e instanceof ApiError ? e.message : fb);
const UNIT_OPTIONS: { value: BaseUnit; label: string }[] = [{ value: "g", label: "g" }, { value: "ml", label: "ml" }, { value: "pcs", label: "pcs" }];
/** Unit prices keep their real precision (0.1665 must not read as 0.17). */
const price = (v: string, code: string) => formatCurrency(v, code, Math.min(4, Math.max(2, trimDecimal(v).split(".")[1]?.length ?? 0)));
const REORDER = /^\d+(\.\d{1,3})?$/;

/** The bits of a review line these helpers need. */
export interface LineLike { description: string; item_id: string | null; quantity: string; unit: string; unit_price: string; exclude_from_stock?: boolean; pack?: PackInfo | null }

/* ------------------------------------------------------------------ suggestion chip */
export function SuggestionChip({ name, onUse }: { name: string; onUse: () => void }) {
  return (
    <button type="button" onClick={onUse} aria-label={`Use ${name}?`}
      className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border border-primary/30 max-sm:min-h-11 bg-primary-soft px-3 py-1 text-xs font-semibold text-primary-soft-fg transition-colors hover:border-primary/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <Sparkles aria-hidden className="size-3.5 shrink-0" /><span className="min-w-0 truncate">Use {name}?</span>
    </button>
  );
}

/* ------------------------------------------------------------------ create one item from a line */
export function CreateItemDialog({ open, onOpenChange, line, items, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void; line: LineLike | undefined; items: InventoryItem[];
  /** Called with the created (or already existing) item once it is in the list. */
  onDone: (item: InventoryItem) => Promise<void>;
}) {
  const [name, setName] = useState(() => cleanItemName(line?.description ?? ""));
  const proposal = useMemo(() => proposeBaseUnit(line?.unit ?? "pcs", line?.description, line?.pack), [line]);
  const [base, setBase] = useState<BaseUnit>(proposal.unit);
  const [reorder, setReorder] = useState("0");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const clash = items.find((i) => i.name.trim().toLowerCase() === name.trim().toLowerCase());

  async function submit() {
    if (!name.trim()) { setErr("Enter a name"); return; }
    if (!REORDER.test(reorder.trim())) { setErr("Reorder level must be a number such as 500"); return; }
    setBusy(true); setErr(null);
    try {
      const it = await api.createInventoryItem({ name: name.trim().replace(/\s+/g, " "), base_unit: base, reorder_level: reorder.trim() });
      await onDone(it);
      toast.success(`${it.name} added to your stock list`);
      onOpenChange(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { // created a moment ago elsewhere: use that one instead of failing
        const have = (await api.inventoryItems().catch(() => [])).find((i) => i.name.trim().toLowerCase() === name.trim().toLowerCase());
        if (have) { await onDone(have); toast.message(`${have.name} was already in your stock list, so this line uses it`); onOpenChange(false); return; }
      }
      setErr(em(e, "Could not create the item"));
    } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Create stock item" description="Made from this invoice line. Nothing is added to stock until you confirm the invoice."
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" form="create-item-form" loading={busy}>Create &amp; map line</Button></>}>
      <form id="create-item-form" noValidate className="space-y-4 py-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {line && <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-fg-muted">Invoice line: <span className="font-medium text-fg">{line.description}</span></p>}
        {err && <Notice tone="danger">{err}</Notice>}
        {clash && !err && <Notice tone="warning">“{clash.name}” already exists. Creating it again will be refused; close this and pick it from the list instead.</Notice>}
        <Input label="Name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-fg">Counted in</span>
          <SegmentedControl label="Base unit" block value={base} onChange={setBase} options={UNIT_OPTIONS} />
          <p className="text-xs text-fg-subtle">{BASE_LABEL[base]}. {base === proposal.unit ? proposal.reason + " " : ""}Stock is kept in this unit and cannot be changed later.</p>
        </div>
        <Input label={`Reorder level (${base}, optional)`} inputMode="decimal" value={reorder} onChange={(e) => setReorder(e.target.value)} hint="You are warned when stock falls to this level." />
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ create all unmatched lines */
interface Row { key: string; name: string; base: BaseUnit; proposed: BaseUnit; reason: string; action: string; skip: boolean; lines: number[]; descriptions: string[] }
const NEW = "__new__";

/** Groups unmapped lines by normalised name (duplicates merge) and pre-matches names that already exist. */
export function buildBulkRows(lines: LineLike[], items: InventoryItem[]): Row[] {
  const byKey = new Map<string, Row>();
  lines.forEach((l, i) => {
    if (l.item_id || l.exclude_from_stock || !l.description.trim()) return;
    const name = cleanItemName(l.description);
    const key = normalizedName(name) || name.toLowerCase();
    const have = byKey.get(key);
    if (have) { have.lines.push(i); have.descriptions.push(l.description); return; }
    const exact = suggestItem(name, items);
    const prop = proposeBaseUnit(l.unit, l.description, l.pack);
    byKey.set(key, { key, name, base: prop.unit, proposed: prop.unit, reason: prop.reason, action: exact?.exact ? exact.item.id : NEW, skip: false, lines: [i], descriptions: [l.description] });
  });
  return [...byKey.values()];
}

export function BulkCreateDialog({ open, onOpenChange, lines, items, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void; lines: LineLike[]; items: InventoryItem[];
  /** line index -> item id for every line that now has an item; `created` = how many new items were made. */
  onDone: (mapping: Record<number, string>, created: number) => Promise<void>;
}) {
  const [rows, setRows] = useState<Row[]>(() => buildBulkRows(lines, items));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef(uuid());
  const patch = (k: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === k ? { ...r, ...p } : r)));

  const todo = rows.filter((r) => !r.skip);
  const creating = todo.filter((r) => r.action === NEW);
  const names = creating.map((r) => r.name.trim().toLowerCase());
  const dupName = (r: Row) => r.action === NEW && !r.skip && names.filter((n) => n === r.name.trim().toLowerCase()).length > 1;
  const clashName = (r: Row) => r.action === NEW && !r.skip && items.some((i) => i.name.trim().toLowerCase() === r.name.trim().toLowerCase());
  const bad = (r: Row) => r.action === NEW && !r.skip && (!r.name.trim() || dupName(r) || clashName(r));
  const blocked = creating.some(bad) || todo.length === 0;

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const mapping: Record<number, string> = {};
      const byName = new Map<string, string>();
      let made = 0;
      if (creating.length) {
        const r = await api.bulkCreateItems({ idempotency_key: key.current, items: creating.map((c) => ({ name: c.name.trim().replace(/\s+/g, " "), base_unit: c.base, reorder_level: "0" })) });
        made = r.created.length;
        for (const it of [...r.created, ...r.existing]) byName.set(it.name.toLowerCase(), it.id); // 'existing' = retry-safe: map instead of failing
      }
      for (const r of todo) {
        const id = r.action === NEW ? byName.get(r.name.trim().replace(/\s+/g, " ").toLowerCase()) : r.action;
        if (id) for (const i of r.lines) mapping[i] = id;
      }
      await onDone(mapping, made);
      onOpenChange(false);
    } catch (e) { setErr(em(e, "Could not create the items")); } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Create items from this invoice"
      description="Check the names and units. Names already in your stock list are matched, not created. Tick Skip to leave a line for later."
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={blocked} onClick={() => void submit()}>{creating.length ? `Create ${creating.length} item${creating.length === 1 ? "" : "s"} & map lines` : "Map lines"}</Button></>}>
      <div className="space-y-3 py-2">
        {err && <Notice tone="danger">{err}</Notice>}
        {rows.length === 0 && <p className="py-6 text-center text-sm text-fg-muted">Every line already has an item.</p>}
        <ul aria-label="Items to create" className="space-y-3">
          {rows.map((r, n) => {
            const existing = items.find((i) => i.id === r.action);
            return (
              <li key={r.key} className={cn("rounded-xl border border-border bg-surface p-3", r.skip && "opacity-60")}>
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 text-xs text-fg-subtle">
                    <span className="font-medium text-fg-muted">{r.descriptions[0]}</span>
                    {r.lines.length > 1 && <span> · merged {r.lines.length} lines</span>}
                  </p>
                  <Checkbox label="Skip" aria-label={`Skip row ${n + 1}`} checked={r.skip} onChange={(e) => patch(r.key, { skip: e.target.checked })} className="-my-1 shrink-0" />
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_7.5rem_minmax(0,1.2fr)]">
                  <InlineInput aria-label={`Name, row ${n + 1}`} disabled={r.skip || !!existing} value={existing ? existing.name : r.name} onChange={(e) => patch(r.key, { name: e.target.value })}
                    error={dupName(r) ? "Same name as another row" : clashName(r) ? "Already in stock: choose it on the right" : r.action === NEW && !r.skip && !r.name.trim() ? "Enter a name" : undefined} />
                  <InlineSelect aria-label={`Unit, row ${n + 1}`} disabled={r.skip || !!existing} value={existing ? existing.base_unit : r.base} onChange={(e) => patch(r.key, { base: e.target.value as BaseUnit })}>
                    {UNIT_OPTIONS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                  </InlineSelect>
                  <InlineSelect aria-label={`Action, row ${n + 1}`} disabled={r.skip} value={r.action} onChange={(e) => patch(r.key, { action: e.target.value })}>
                    <option value={NEW}>Create new item</option>
                    {items.map((i) => <option key={i.id} value={i.id}>Use {i.name} ({i.base_unit})</option>)}
                  </InlineSelect>
                </div>
                {!existing && !r.skip && r.base === r.proposed && r.reason !== "Counted by weight." && r.reason !== "Counted by volume." && r.reason !== "Counted in pieces." && <p className="mt-1.5 text-xs text-fg-subtle">{r.reason}</p>}
                {existing && <p className="mt-1.5 text-xs font-medium text-success-fg">Matched to your existing “{existing.name}”. Nothing new is created.</p>}
              </li>
            );
          })}
        </ul>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ pack-size conversion */
export interface PackSnapshot { quantity: string; unit: string; unit_price: string; locked_total?: string }


export function PackHelper({ line, item, lineTotal, currency, onApply }: {
  line: LineLike; item: InventoryItem; lineTotal: string; currency: string;
  onApply: (next: { quantity: string; unit: string; unit_price: string; total: string }) => void;
}) {
  const hint = useMemo(() => { const p = parsePack(line.description, line.quantity); return p && baseOf(p.unit) === item.base_unit ? p : null; }, [line.description, line.quantity, item.base_unit]);
  const units = unitsFor(item.base_unit);
  const [size, setSize] = useState(hint?.quantity ?? "");
  const [unit, setUnit] = useState(hint && units.includes(hint.unit) ? hint.unit : item.base_unit === "pcs" ? "pcs" : units[units.length - 1]);
  const next = convertPack(line.quantity, size, unit, lineTotal);
  const fmt = (q: string, u: string, p: string) => `${trimDecimal(q)} ${u} @ ${price(p, currency)}`;
  return (
    <div role="group" aria-label="Pack size" className="rounded-xl border border-warning/30 bg-warning-soft/50 p-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-warning-fg"><PackageOpen aria-hidden className="size-4" />How much is in one {line.unit}?</p>
      <p className="mt-0.5 text-xs text-fg-muted">{item.name} is counted in {item.base_unit}. Tell us what one {line.unit} holds; the line total stays the same.{hint ? " Size read from the description: check it." : ""}</p>
      <div className="mt-2 grid grid-cols-[minmax(0,1fr)_6rem] gap-2 sm:grid-cols-[8rem_6rem_auto] sm:items-end">
        <InlineInput aria-label="Quantity in one pack" inputMode="decimal" placeholder="e.g. 25" value={size} onChange={(e) => setSize(e.target.value)} error={size && !isDecimal(size) ? "Number" : undefined} />
        <InlineSelect aria-label="Unit of one pack" value={unit} onChange={(e) => setUnit(e.target.value)}>{units.map((u) => <option key={u}>{u}</option>)}</InlineSelect>
        <Button variant="primary" className="col-span-2 sm:col-span-1" disabled={!next} onClick={() => next && onApply(next)}>Convert</Button>
      </div>
      {next && (
        <p aria-live="polite" className="tnum mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
          <span>{fmt(line.quantity, line.unit, line.unit_price)}</span><ArrowRight aria-hidden className="size-3.5" />
          <span className="font-semibold text-fg">{fmt(next.quantity, next.unit, next.unit_price)}</span>
          <span>· total {formatCurrency(next.total, currency)} unchanged</span>
        </p>
      )}
    </div>
  );
}

export function PackConverted({ before, now, currency, onUndo }: { before: PackSnapshot & { unit: string }; now: LineLike; currency: string; onUndo: () => void }) {
  return (
    <p className="tnum flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-success-soft px-3 py-2 text-xs text-success-fg">
      <span>Converted from {trimDecimal(before.quantity)} {before.unit} @ {price(before.unit_price, currency)} to <span className="font-semibold">{trimDecimal(now.quantity)} {now.unit}</span> @ {price(now.unit_price, currency)}.</span>
      <button type="button" onClick={onUndo} className="inline-flex min-h-8 items-center max-sm:min-h-11 gap-1 rounded-md font-semibold underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"><Undo2 aria-hidden className="size-3.5" />Undo</button>
    </p>
  );
}
