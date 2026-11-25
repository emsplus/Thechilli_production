"use client";

import { useMemo, useState } from "react";
import { PackageCheck, Plus, Send, XCircle } from "lucide-react";
import { Badge, Button, ConfirmDialog, DateInput, Dialog, Notice, Select, Sheet, Input, IconButton, type BadgeTone } from "@chilli/ui";
import { DataTable, FilterBar, type DataColumn } from "@chilli/ui/data";
import { toast } from "@/components/ui";
import { useLocale, useMsg } from "@/lib/i18n";
import { inv, isPercent, trimDec, isQty, isRate, lineNet, PO_STATUSES, poActions, poReceived, remainingQty, PERM, type PoInput, type PoStatus, type PurchaseOrder } from "@/lib/inventoryApi";
import { sumMoney } from "@/lib/money";
import { factorToBase, prettyQty, unitsFor } from "@/lib/units";
import { useCurrency } from "@/lib/taxConfig";
import { formatCurrency } from "@/lib/money";
import { useCan } from "@/lib/useRole";
import { INV_MSG } from "./messages";
import { ErrorNotice, errText, fmtDate, Gate, useRefs, useSection } from "./shared";
import { ReceiveDialog } from "./ReceiveDialog";

export const PO_TONE: Record<PoStatus, BadgeTone> = { draft: "neutral", sent: "info", partially_received: "warning", closed: "success", cancelled: "danger" };

export function OrdersSection() {
  const t = useMsg(INV_MSG);
  const { locale } = useLocale();
  const { can } = useCan();
  const cur = useCurrency();
  const refs = useRefs();
  const [status, setStatus] = useState("");
  const { state, reload } = useSection(() => inv.pos({ status: status || undefined }), [status]);
  const [form, setForm] = useState<{ po: PurchaseOrder | null } | null>(null);
  const [view, setView] = useState<PurchaseOrder | null>(null);
  const [receive, setReceive] = useState<PurchaseOrder | null>(null);
  const [confirm, setConfirm] = useState<{ po: PurchaseOrder; action: "cancel" | "close" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canManage = can(PERM.purchases);
  const canReceive = can(PERM.receive);

  async function act(po: PurchaseOrder, a: "send" | "cancel" | "close") {
    setBusy(true); setErr(null);
    try { await inv.poAction(po.id, a); toast.success(t(a === "send" ? "poSend" : a === "cancel" ? "poCancel" : "poClose")); setConfirm(null); setView(null); await reload(); }
    catch (e) { setErr(errText(e, "Could not update the order")); setConfirm(null); } finally { setBusy(false); }
  }

  const columns = (rows: PurchaseOrder[]): DataColumn<PurchaseOrder>[] => [
    { key: "number", header: t("number"), sortValue: (p) => p.number, render: (p) => <button type="button" className="min-h-11 font-semibold text-primary underline-offset-2 hover:underline" onClick={() => setView(p)}>{p.number}</button> },
    { key: "supplier", header: t("supplier"), sortValue: (p) => refs.supplierName(p.supplier_id), render: (p) => refs.supplierName(p.supplier_id) },
    { key: "status", header: t("status"), sortValue: (p) => p.status, csv: (p) => p.status, render: (p) => <Badge tone={PO_TONE[p.status]}>{t(`st_${p.status}`)}</Badge> },
    { key: "expected", header: t("poExpected"), sortValue: (p) => p.expected_date ?? "", render: (p) => fmtDate(p.expected_date) },
    { key: "total", header: t("total"), align: "end", sortValue: (p) => Number(p.total), csv: (p) => p.total, render: (p) => <span className="tnum">{formatCurrency(p.total, cur)}</span> },
    { key: "act", header: t("actions"), render: (p) => {
      const a = poActions(p.status, poReceived(p));
      return (
        <span className="flex flex-wrap gap-1">
          {canManage && a.send && <Button size="sm" iconStart={<Send />} onClick={() => void act(p, "send")}>{t("poSend")}</Button>}
          {canReceive && a.receive && <Button size="sm" variant="primary" iconStart={<PackageCheck />} onClick={() => setReceive(p)}>{t("poReceive")}</Button>}
          {rows.length > 0 && <Button size="sm" variant="ghost" onClick={() => setView(p)}>{t("poView")}</Button>}
        </span>
      );
    } },
  ];

  return (
    <section aria-label={t("orders")}>
      <FilterBar label={t("orders")} locale={locale} activeCount={status ? 1 : 0} onReset={() => setStatus("")}>
        <Select label={t("status")} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t("all")}</option>
          {PO_STATUSES.map((s) => <option key={s} value={s}>{t(`st_${s}`)}</option>)}
        </Select>
        {canManage && <Button variant="primary" iconStart={<Plus />} onClick={() => setForm({ po: null })}>{t("poNew")}</Button>}
      </FilterBar>
      <ErrorNotice message={err} />
      <Gate state={state} reload={() => void reload()}>
        {(rows) => (
          <DataTable caption={t("orders")} columns={columns(rows)} rows={rows} getKey={(p) => p.id} exportName="purchase-orders" locale={locale}
            empty={<div className="py-8 text-center"><p className="font-semibold text-fg">{t("poEmpty")}</p><p className="mt-1 text-sm text-fg-muted">{t("poEmptyHint")}</p>{canManage && <div className="mt-3"><Button variant="secondary" iconStart={<Plus />} onClick={() => setForm({ po: null })}>{t("poNew")}</Button></div>}</div>} />
        )}
      </Gate>
      <PoForm state={form} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); }} />
      <PoDetail po={view} onClose={() => setView(null)} canManage={canManage} canReceive={canReceive}
        onEdit={(p) => { setView(null); setForm({ po: p }); }} onSend={(p) => void act(p, "send")} onReceive={(p) => { setView(null); setReceive(p); }}
        onCancel={(p) => setConfirm({ po: p, action: "cancel" })} onClose2={(p) => setConfirm({ po: p, action: "close" })} />
      <ReceiveDialog po={receive} onClose={() => setReceive(null)} onDone={() => { setReceive(null); void reload(); }} />
      <ConfirmDialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }} locale={locale} busy={busy} destructive={confirm?.action === "cancel"}
        title={confirm ? `${confirm.action === "cancel" ? t("poCancel") : t("poClose")} ${confirm.po.number}?` : ""} confirmLabel={confirm?.action === "cancel" ? t("poCancel") : t("poClose")}
        onConfirm={() => confirm && void act(confirm.po, confirm.action)} />
    </section>
  );
}

/* ------------------------------------------------------------------ detail */
function PoDetail({ po, onClose, canManage, canReceive, onEdit, onSend, onReceive, onCancel, onClose2 }: {
  po: PurchaseOrder | null; onClose: () => void; canManage: boolean; canReceive: boolean;
  onEdit: (p: PurchaseOrder) => void; onSend: (p: PurchaseOrder) => void; onReceive: (p: PurchaseOrder) => void; onCancel: (p: PurchaseOrder) => void; onClose2: (p: PurchaseOrder) => void;
}) {
  const t = useMsg(INV_MSG);
  const { locale } = useLocale();
  const cur = useCurrency();
  const refs = useRefs();
  const a = po ? poActions(po.status, poReceived(po)) : null;
  return (
    <Sheet side="right" open={!!po} onOpenChange={(o) => { if (!o) onClose(); }} locale={locale} title={po ? `${po.number} · ${refs.supplierName(po.supplier_id)}` : t("orders")}
      description={po ? `${t(`st_${po.status}`)}${po.expected_date ? ` · ${t("poExpected")} ${fmtDate(po.expected_date)}` : ""}` : undefined}
      footer={po && a ? <>
        {canManage && a.edit && <Button onClick={() => onEdit(po)}>{t("poEdit")}</Button>}
        {canManage && a.send && <Button iconStart={<Send />} onClick={() => onSend(po)}>{t("poSend")}</Button>}
        {canManage && a.cancel && <Button variant="danger-soft" iconStart={<XCircle />} onClick={() => onCancel(po)}>{t("poCancel")}</Button>}
        {canManage && a.close && <Button onClick={() => onClose2(po)}>{t("poClose")}</Button>}
        {canReceive && a.receive && <Button variant="primary" iconStart={<PackageCheck />} onClick={() => onReceive(po)}>{t("poReceive")}</Button>}
      </> : undefined}>
      {po && (
        <div className="space-y-3">
          {po.notes && <p className="text-sm text-fg-muted">{po.notes}</p>}
          <ul className="divide-y divide-border rounded-xl border border-border">
            {po.lines.map((l) => {
              const item = refs.itemById(l.item_id);
              return (
                <li key={l.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0"><p className="truncate font-medium text-fg">{refs.itemName(l.item_id)}</p>
                    <p className="tnum text-xs text-fg-subtle">{t("poOrdered")} {trimDec(l.quantity)} {l.unit_code} · {t("poReceived")} {trimDec(l.received_quantity)} {l.unit_code}{item && Number(remainingQty(l)) > 0 ? ` · ${prettyQty(remainingQty(l), l.unit_code)}` : ""}</p></div>
                  <span className="tnum shrink-0 text-fg">{formatCurrency(lineNet(l.quantity, l.unit_price), cur)}</span>
                </li>);
            })}
          </ul>
          <dl className="tnum grid grid-cols-2 gap-1 text-sm">
            <dt className="text-fg-muted">{t("total")}</dt><dd className="text-right font-semibold">{formatCurrency(po.total, cur)}</dd>
          </dl>
        </div>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------------ form */
interface Row { key: number; item_id: string; quantity: string; unit: string; unit_price: string; tax_rate: string; auto?: boolean }
let rowKey = 1;
const blank = (): Row => ({ key: rowKey++, item_id: "", quantity: "", unit: "", unit_price: "", tax_rate: "0" });

function PoForm({ state, onClose, onSaved }: { state: { po: PurchaseOrder | null } | null; onClose: () => void; onSaved: () => void }) {
  const t = useMsg(INV_MSG);
  const { locale } = useLocale();
  const refs = useRefs();
  const cur = useCurrency();
  const po = state?.po ?? null;
  const [supplier, setSupplier] = useState("");
  const [expected, setExpected] = useState("");
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState<Row[]>([blank()]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);

  // Reset when a different order (or none) opens.
  const sig = state ? po?.id ?? "new" : null;
  if (sig !== shown) {
    setShown(sig);
    if (state) {
      setSupplier(po?.supplier_id ?? ""); setExpected(po?.expected_date ?? ""); setNotes(po?.notes ?? ""); setErr(null);
      setRows(po ? po.lines.map((l) => ({ key: rowKey++, item_id: l.item_id, quantity: l.quantity, unit: l.unit_code, unit_price: l.unit_price, tax_rate: l.tax_rate })) : [blank()]);
    }
  }

  const items = useMemo(() => refs.items.filter((i) => i.is_active !== false), [refs.items]);
  const set = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const valid = (r: Row) => r.item_id && isQty(r.quantity) && isRate(r.unit_price) && isPercent(r.tax_rate || "0");
  const complete = rows.filter(valid);
  const total = sumMoney(complete.map((r) => lineNet(r.quantity, r.unit_price)), 2);

  async function save() {
    if (!supplier) { setErr(t("poChooseSupplier")); return; }
    if (!complete.length || complete.length !== rows.filter((r) => r.item_id || r.quantity || r.unit_price).length) { setErr(t("poNeedLines")); return; }
    const body: PoInput = {
      supplier_id: supplier, expected_date: expected || null, notes: notes.trim() || null,
      lines: complete.map((r) => ({ item_id: r.item_id, quantity: r.quantity.trim(), unit: r.unit || refs.itemById(r.item_id)?.base_unit || "pcs", unit_price: r.unit_price.trim(), tax_rate: (r.tax_rate || "0").trim() })),
    };
    setBusy(true); setErr(null);
    try { if (po) await inv.updatePo(po.id, body); else await inv.createPo(body); toast.success(t("poSaved")); onSaved(); }
    catch (e) { setErr(errText(e, "Could not save the order")); } finally { setBusy(false); }
  }

  return (
    <Dialog open={!!state} onOpenChange={(o) => { if (!o) onClose(); }} locale={locale} title={po ? `${t("poEdit")} ${po.number}` : t("poNew")}
      footer={<><Button onClick={onClose}>{t("cancel")}</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{t("save")}</Button></>}>
      <div className="space-y-3">
        {err && <Notice tone="danger" locale={locale}>{err}</Notice>}
        <Select label={t("supplier")} value={supplier} onChange={(e) => setSupplier(e.target.value)}>
          <option value="">{t("poChooseSupplier")}</option>
          {refs.suppliers.filter((s) => s.is_active !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <DateInput label={t("poExpected")} value={expected} onChange={(e) => setExpected(e.target.value)} />
        <Input label={t("note")} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        <p className="text-sm font-semibold text-fg">{t("poLines")}</p>
        <ul className="space-y-3">
          {rows.map((r, i) => {
            const base = refs.itemById(r.item_id)?.base_unit;
            return (
              <li key={r.key} className="grid grid-cols-2 gap-2 rounded-xl border border-border p-3 sm:grid-cols-[1fr_5rem_6rem_6rem_5rem_auto]">
                <div className="ch-inline-sm col-span-2 sm:col-span-1">
                  <Select label={t("item")} aria-label={`${t("item")} ${i + 1}`} value={r.item_id}
                    onChange={(e) => {
                      const it = refs.itemById(e.target.value);
                      set(r.key, { item_id: e.target.value, unit: it?.base_unit ?? "", unit_price: r.unit_price || (it?.last_cost ? trimDec(it.last_cost) : ""), auto: !r.unit_price && !!it?.last_cost });
                    }}>
                    <option value="">{t("item")}</option>
                    {items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                  </Select>
                </div>
                <div className="ch-inline-sm"><Input label={t("qty")} aria-label={`${t("qty")} ${i + 1}`} inputMode="decimal" value={r.quantity} onChange={(e) => set(r.key, { quantity: e.target.value })} /></div>
                <div className="ch-inline-sm">
                  <Select label={t("unit")} aria-label={`${t("unit")} ${i + 1}`} value={r.unit || base || "pcs"}
                    onChange={(e) => {
                      // An auto-filled price is per base unit: follow the unit (0.32 per g = 320 per kg); a price typed by hand is left alone.
                      const it = refs.itemById(r.item_id);
                      set(r.key, { unit: e.target.value, ...(r.auto && it?.last_cost ? { unit_price: trimDec(Number(it.last_cost) * factorToBase(e.target.value)) } : {}) });
                    }}>
                    {unitsFor(base).map((u) => <option key={u}>{u}</option>)}
                  </Select>
                </div>
                <div className="ch-inline-sm"><Input label={t("price")} aria-label={`${t("price")} ${i + 1}`} inputMode="decimal" value={r.unit_price} onChange={(e) => set(r.key, { unit_price: e.target.value, auto: false })} /></div>
                <div className="ch-inline-sm"><Input label={t("taxRate")} aria-label={`${t("taxRate")} ${i + 1}`} inputMode="decimal" value={r.tax_rate} onChange={(e) => set(r.key, { tax_rate: e.target.value })} /></div>
                <IconButton label={`${t("poRemoveLine")} ${i + 1}`} icon={<XCircle />} disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} />
              </li>);
          })}
        </ul>
        <Button iconStart={<Plus />} onClick={() => setRows((rs) => [...rs, blank()])}>{t("poAddLine")}</Button>
        <p className="tnum text-right text-sm text-fg-muted">{t("total")}: <strong className="text-fg">{formatCurrency(total, cur)}</strong></p>
      </div>
    </Dialog>
  );
}
