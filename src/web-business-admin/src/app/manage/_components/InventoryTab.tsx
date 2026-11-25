"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ClipboardCheck, FileSpreadsheet, History, Mail, Pencil, Plus, RotateCcw, ScanLine, Search, Trash2, Truck } from "lucide-react";
import { Badge, Button, IconButton, Notice, StatCard, Switch } from "@chilli/ui";
import { useLocale } from "@/lib/i18n";
import { InlineInput } from "@/components/inline-fields";
import { Card, EmptyState, SegmentedControl, Skeleton, StatusPill, toast, useConfirm } from "@/components/ui";
import { StockBoxIllustration } from "@/components/illustrations";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/datetime";
import { prettyQty } from "@/lib/units";
import { useLoader } from "@/lib/useLoader";
import type { InventoryItem } from "@/lib/types";
import { useManage } from "./manage-context";
import { StartStockCard, StockFlowStrip, useDrafts, WaitingLink } from "./stock-flow";
import { ImportStockDialog } from "./ImportStockDialog";
import { ReorderEmailDialog } from "./ReorderEmailDialog";
import { AddItemDialog, AdjustDialog, CountDialog, EditItemDialog, LedgerSheet } from "./inventory-dialogs";

const fetchItems = () => api.allInventoryItems();
const fetchSuppliers = () => api.allSuppliers();
const stateOf = (i: InventoryItem): "ok" | "low" | "out" => (Number(i.balance) <= 0 ? "out" : i.low_stock ? "low" : "ok");

/** Level bar: fill = balance on a scale of max(2x reorder level, balance); tick = reorder level. */
function LevelBar({ item }: { item: InventoryItem }) {
  const bal = Math.max(0, Number(item.balance)), re = Number(item.reorder_level);
  const scale = Math.max(re * 2, bal, 1);
  const st = stateOf(item);
  return (
    <div className="relative h-2.5 w-full rounded-full bg-surface-3" role="img" aria-label={`Balance ${prettyQty(item.balance, item.base_unit)}, reorder level ${prettyQty(item.reorder_level, item.base_unit)}`}>
      <div className={cn("h-full rounded-full transition-[width] duration-300", st === "ok" ? "bg-success" : st === "low" ? "bg-warning" : "bg-danger")} style={{ width: `${Math.min(100, (bal / scale) * 100)}%` }} />
      {re > 0 && <span aria-hidden className="absolute -top-1 h-[18px] w-0.5 rounded-full bg-fg" style={{ left: `${Math.min(99, (re / scale) * 100)}%` }} title="Reorder level" />}
    </div>
  );
}

/** Where the stock last came from, so the list answers "which invoice put this here?". */
function LastReceivedLine({ item: i, onOpen }: { item: InventoryItem; onOpen: (invoiceId: string) => void }) {
  const lr = i.last_received;
  if (!lr) return <p className="mt-0.5 text-xs text-fg-subtle">No deliveries recorded yet</p>;
  const text = ["Last received: " + prettyQty(lr.quantity, i.base_unit), lr.supplier_name, lr.invoice_number, formatDate(lr.at)].filter(Boolean).join(" · ");
  const cls = "mt-0.5 flex max-w-full items-start gap-1 text-xs text-fg-subtle";
  if (!lr.invoice_id) return <p className={cls}><Truck aria-hidden className="mt-0.5 size-3 shrink-0" /><span className="min-w-0 break-words leading-snug">{text}</span></p>;
  return (
    <button type="button" onClick={() => onOpen(lr.invoice_id!)} title="Open the invoice" aria-label={`${text}. Open invoice`}
      className={cn(cls, "rounded text-left hover:text-primary-soft-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring")}>
      <Truck aria-hidden className="mt-0.5 size-3 shrink-0" /><span className="min-w-0 break-words leading-snug">{text}</span>
    </button>
  );
}

export function InventoryTab({ canEdit = true, onChanged, highlight = [], action }: { canEdit?: boolean; onChanged?: () => void; highlight?: string[]; action?: string }) {
  const confirm = useConfirm();
  const { goto } = useManage();
  const { locale } = useLocale();
  const { drafts } = useDrafts();
  const openInvoice = useCallback((id: string) => goto("suppliers", "invoices", { invoice: id, from: "inventory" }), [goto]);
  const scan = () => goto("suppliers", "invoices", { from: "inventory" });
  const marked = useMemo(() => new Set(highlight), [highlight]);
  const { data: all, error, loading, reload } = useLoader(fetchItems);
  const { data: suppliers } = useLoader(fetchSuppliers);
  const [mail, setMail] = useState<{ itemIds?: string[] } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [edit, setEdit] = useState<InventoryItem | null>(null);
  const items = useMemo(() => (all ?? []).filter((i) => i.is_active !== false), [all]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "low">("all");
  const [addOpen, setAddOpen] = useState(action === "add");
  const [imp, setImp] = useState({ open: action === "import", nonce: 0 });
  const [adjust, setAdjust] = useState<{ open: boolean; itemId?: string }>({ open: false });
  const [countOpen, setCountOpen] = useState(false);
  const [ledger, setLedger] = useState<InventoryItem | null>(null);
  const closeAction = useCallback((o: boolean, set: (o: boolean) => void) => { set(o); if (!o && action) goto("inventory"); }, [action, goto]);
  const done = useCallback(() => { void reload(); onChanged?.(); }, [reload, onChanged]);
  const firstMarked = highlight[0];
  useEffect(() => {
    if (!firstMarked || !all) return;
    document.getElementById(`stock-${firstMarked}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [firstMarked, all]);

  const empty = !loading && !all?.length && canEdit; // first run: the guidance card is the whole page
  const low = useMemo(() => items.filter((i) => i.low_stock).length ?? 0, [items]);
  const out = useMemo(() => items.filter((i) => Number(i.balance) <= 0).length, [items]);
  const archivedCount = (all ?? []).length - items.length;
  const list = useMemo(() => (showArchived ? (all ?? []) : items).filter((i) => (filter === "all" || i.low_stock) && i.name.toLowerCase().includes(q.trim().toLowerCase())), [all, items, showArchived, q, filter]);

  async function restore(i: InventoryItem) {
    try { await api.patchInventoryItem(i.id, { is_active: true }); toast.success(`${i.name} restored`); done(); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : "Could not restore the item"); }
  }
  async function archive(i: InventoryItem) {
    if (!(await confirm({ title: `Archive ${i.name}?`, description: "It disappears from stock lists, counts and alerts. History is kept and you can restore it any time. Items used in a current recipe cannot be archived.", confirmLabel: "Archive", tone: "danger" }))) return;
    try { await api.patchInventoryItem(i.id, { is_active: false }); toast.success(`${i.name} archived`); done(); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : "Could not archive the item"); }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">What is on the shelf, what is running low, and where every bit of it came from.</p>
        {!empty && <div className="flex flex-wrap gap-2">
          <Button variant="primary" iconStart={<ScanLine />} onClick={scan}>Scan invoice</Button>
          <Button variant="secondary" iconStart={<ClipboardCheck />} disabled={!items.length} onClick={() => setCountOpen(true)}>Stock count</Button>
          <Button variant="secondary" iconStart={<Trash2 />} disabled={!items.length} onClick={() => setAdjust({ open: true })}>Wastage / adjust</Button>
          {canEdit && <Button variant="secondary" iconStart={<Mail />} disabled={!items.length} onClick={() => setMail({})}>Email supplier</Button>}
          {canEdit && <Button variant="secondary" iconStart={<FileSpreadsheet />} onClick={() => setImp((s) => ({ open: true, nonce: s.nonce + 1 }))}>Import stock list</Button>}
          {canEdit && <Button variant="secondary" iconStart={<Plus />} onClick={() => setAddOpen(true)}>Add item</Button>}
        </div>}
      </div>

      {!loading && !all?.length && canEdit && <StartStockCard from="inventory" className="mb-4" onImport={() => setImp((s) => ({ open: true, nonce: s.nonce + 1 }))} onAdd={() => setAddOpen(true)} />}

      {(loading || !!all?.length) && <section aria-label="Scan an invoice to add stock" className="mb-4 rounded-xl border border-border bg-surface p-3 shadow-card sm:p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-fg">Stock comes in from supplier invoices</p>
          <WaitingLink count={drafts.length} onClick={() => goto("suppliers", "invoices", { from: "inventory" })} />
        </div>
        <StockFlowStrip step={drafts.length ? 2 : undefined} />
      </section>}

      {error && <div className="mb-4"><Notice tone="danger" action={<Button size="sm" variant="secondary" onClick={done}>Retry</Button>}>{error}</Notice></div>}

      {!empty && <div className="mb-5 grid grid-cols-3 gap-2 sm:gap-4 [&_.ch-stat]:min-w-0! max-sm:[&_.ch-stat]:p-3!">
        <StatCard label="Items" value={String(items.length)} loading={loading} locale={locale} />
        <StatCard label="Low stock" value={String(low)} loading={loading} locale={locale} />
        <StatCard label="Out of stock" value={String(out)} loading={loading} locale={locale} />
      </div>}

      {!empty && <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3 sm:p-4">
          <InlineInput aria-label="Search items" placeholder="Search items" leading={<Search />} value={q} onChange={(e) => setQ(e.target.value)} wrapperClassName="min-w-0 flex-1 sm:max-w-xs" />
          <SegmentedControl label="Filter" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "low", label: `Low only${low ? ` (${low})` : ""}` }]} />
          {archivedCount > 0 && <Switch label={`Show archived (${archivedCount})`} checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="ml-auto" />}
        </div>
        {loading ? (
          <div className="space-y-4 p-4" role="status" aria-label="Loading stock">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : !all?.length ? (
          <EmptyState illustration={<StockBoxIllustration />} title="No inventory items yet" hint="Items you create from invoices, a spreadsheet or by hand will appear here."
            action={canEdit ? <Button variant="primary" iconStart={<Plus />} onClick={() => setAddOpen(true)}>Add your first item</Button> : undefined} />
        ) : list.length === 0 ? (
          <EmptyState compact icon={<Search />} title={filter === "low" && !q ? "Nothing is running low" : "No matching items"} hint={filter === "low" && !q ? "Every item is above its reorder level." : "Try a different search."} />
        ) : (
          <ul className="divide-y divide-border">
            <li aria-hidden className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_7rem_8rem_9.5rem] gap-4 bg-surface-2/70 px-5 py-2 text-xs font-semibold uppercase tracking-wide text-fg-muted md:grid">
              <span>Item</span><span>Level (tick = reorder)</span><span className="text-right">Balance</span><span>Status</span><span />
            </li>
            {list.map((i) => {
              const archived = i.is_active === false;
              return (
              <li key={i.id} id={`stock-${i.id}`} className={cn(marked.has(i.id) && "bg-primary-soft/60 ring-2 ring-inset ring-primary/40", "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-surface-2/50 sm:px-5 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_7rem_8rem_9.5rem]", archived && "opacity-70")}>
                <div className="min-w-0">
                  <p className="truncate font-medium text-fg">{i.name}{archived && <Badge tone="neutral" className="ml-2 align-middle">Archived</Badge>}</p>
                  <p className="tnum text-xs text-fg-subtle">Reorder at {prettyQty(i.reorder_level, i.base_unit)}</p>
                  <LastReceivedLine item={i} onOpen={openInvoice} />
                  {i.supplier_name && <p className="mt-0.5 flex max-w-full items-start gap-1 text-xs text-fg-subtle"><Truck aria-hidden className="mt-0.5 size-3 shrink-0" /><span className="min-w-0 break-words leading-snug">Usual supplier: {i.supplier_name}</span></p>}
                  {!archived && i.low_stock && canEdit && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="secondary" iconStart={<Mail />} aria-label={`Email supplier about ${i.name}`} onClick={() => setMail({ itemIds: [i.id] })}>Email supplier</Button>
                      {i.reorder_email && <span data-testid={`emailed-${i.id}`} className={cn("text-xs", i.reorder_email.status === "failed" ? "font-medium text-danger-fg" : "text-fg-subtle")}>
                        {i.reorder_email.status === "failed" ? "Email to supplier failed" : i.reorder_email.status === "queued" ? "Emailing supplier…" : `Supplier emailed ${formatDate(i.reorder_email.at)}`}
                      </span>}
                    </div>
                  )}
                </div>
                <div className="col-span-2 row-start-2 md:col-span-1 md:row-start-auto"><LevelBar item={i} /></div>
                <p className="tnum hidden text-right font-semibold md:block">{prettyQty(i.balance, i.base_unit)}</p>
                <div className="col-span-2 flex items-center justify-between gap-2 md:col-span-1 md:justify-start">
                  <span className="tnum text-sm font-semibold md:hidden">{prettyQty(i.balance, i.base_unit)}</span>
                  {!archived && <StatusPill kind="stock" status={stateOf(i)} size="sm" />}
                </div>
                <div className="col-start-2 row-start-1 flex justify-end gap-1 md:col-start-auto md:row-start-auto">
                  <IconButton label={`Ledger for ${i.name}`} icon={<History />} onClick={() => setLedger(i)} />
                  {archived ? (canEdit && <IconButton label={`Restore ${i.name}`} icon={<RotateCcw />} onClick={() => void restore(i)} />) : (
                    <>
                      <IconButton label={`Wastage or adjustment for ${i.name}`} icon={<Trash2 />} onClick={() => setAdjust({ open: true, itemId: i.id })} />
                      {canEdit && <IconButton label={`Edit ${i.name}`} icon={<Pencil />} onClick={() => setEdit(i)} />}
                      {canEdit && <IconButton label={`Archive ${i.name}`} icon={<Archive />} onClick={() => void archive(i)} />}
                    </>
                  )}
                </div>
              </li>
              );
            })}
          </ul>
        )}
      </Card>}

      <AddItemDialog open={addOpen} onOpenChange={(o) => closeAction(o, setAddOpen)} onDone={done} />
      <ImportStockDialog key={imp.nonce} open={imp.open} onOpenChange={(o) => closeAction(o, (v) => setImp((s) => ({ ...s, open: v })))} existingNames={(all ?? []).map((i) => i.name)} onDone={done}
        onViewStock={(ids) => goto("inventory", undefined, { highlight: ids.join(",") })} />
      <AdjustDialog open={adjust.open} onOpenChange={(o) => setAdjust((s) => ({ ...s, open: o }))} items={items} initialItemId={adjust.itemId} onDone={done} />
      <CountDialog open={countOpen} onOpenChange={setCountOpen} items={items} onDone={done} />
      <ReorderEmailDialog open={!!mail} onClose={() => setMail(null)} suppliers={suppliers ?? []} items={items} itemIds={mail?.itemIds} onDone={done} />
      <EditItemDialog item={edit} onClose={() => setEdit(null)} onDone={done} />
      <LedgerSheet item={ledger} onClose={() => setLedger(null)} onOpenInvoice={(id) => { setLedger(null); openInvoice(id); }} />
    </>
  );
}
