"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button, DateInput, Dialog, Input, Notice, Select, StatCard } from "@chilli/ui";
import { DataTable, FilterBar, type DataColumn } from "@chilli/ui/data";
import { toast } from "@/components/ui";
import { useLocale, useMsg } from "@/lib/i18n";
import { inv, isQty, PERM, WASTE_REASONS, todayIso, type WastageReport } from "@/lib/inventoryApi";
import { formatCurrency } from "@/lib/money";
import { prettyQty, unitsFor } from "@/lib/units";
import { useCurrency } from "@/lib/taxConfig";
import { useCan } from "@/lib/useRole";
import { INV_MSG } from "./messages";
import { errText, Gate, useIdempotencyKey, useRefs, useSection } from "./shared";

const monthAgo = () => { const d = new Date(); d.setDate(d.getDate() - 30); return todayIso(d); };

export function WastageSection() {
  const t = useMsg(INV_MSG);
  const { locale } = useLocale();
  const cur = useCurrency();
  const { can } = useCan();
  const [from, setFrom] = useState(monthAgo());
  const [to, setTo] = useState(todayIso());
  const bad = !!from && !!to && from > to;
  const { state, reload } = useSection(() => (bad ? Promise.resolve<WastageReport>({ total_value: "0", by_reason: [], by_item: [] }) : inv.wastage({ date_from: from || undefined, date_to: to || undefined })), [from, to, bad]);
  const [open, setOpen] = useState(false);

  const reasonCols: DataColumn<WastageReport["by_reason"][number]>[] = [
    { key: "reason", header: t("wasteReason"), sortValue: (r) => r.reason_code, csv: (r) => r.reason_code, render: (r) => t(`reason_${r.reason_code}`) },
    { key: "n", header: t("entries"), align: "end", sortValue: (r) => r.quantity_entries, render: (r) => <span className="tnum">{r.quantity_entries}</span> },
    { key: "v", header: t("value"), align: "end", sortValue: (r) => Number(r.value), csv: (r) => r.value, render: (r) => <span className="tnum">{formatCurrency(r.value, cur)}</span> },
  ];
  const itemCols: DataColumn<WastageReport["by_item"][number]>[] = [
    { key: "item", header: t("item"), sortValue: (r) => r.name, render: (r) => r.name },
    { key: "q", header: t("qty"), align: "end", sortValue: (r) => Number(r.quantity), csv: (r) => r.quantity, render: (r) => <span className="tnum">{prettyQty(r.quantity, r.unit)}</span> },
    { key: "v", header: t("value"), align: "end", sortValue: (r) => Number(r.value), csv: (r) => r.value, render: (r) => <span className="tnum">{formatCurrency(r.value, cur)}</span> },
  ];

  return (
    <section aria-label={t("wastage")} className="space-y-4">
      <FilterBar label={t("wastage")} locale={locale}>
        <DateInput label={t("from")} value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        <DateInput label={t("to")} value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        {can(PERM.wastage) && <Button variant="primary" iconStart={<Trash2 />} onClick={() => setOpen(true)}>{t("wasteNew")}</Button>}
      </FilterBar>
      {bad && <Notice tone="warning" locale={locale}>{t("from")} &gt; {t("to")}</Notice>}
      <Gate state={state} reload={() => void reload()}>
        {(r) => r.by_item.length === 0 && r.by_reason.length === 0 ? (
          <div className="py-8 text-center"><p className="font-semibold text-fg">{t("wasteEmpty")}</p></div>
        ) : (
          <div className="space-y-4">
            <StatCard label={t("wasteTotal")} value={formatCurrency(r.total_value, cur)} locale={locale} />
            <h2 className="font-display text-lg font-bold text-fg">{t("wasteByReason")}</h2>
            <DataTable caption={t("wasteByReason")} columns={reasonCols} rows={r.by_reason} getKey={(x) => x.reason_code} exportName="wastage-by-reason" locale={locale} />
            <h2 className="font-display text-lg font-bold text-fg">{t("wasteByItem")}</h2>
            <DataTable caption={t("wasteByItem")} columns={itemCols} rows={r.by_item} getKey={(x) => x.item_id} exportName="wastage-by-item" locale={locale} />
          </div>
        )}
      </Gate>
      <WastageDialog open={open} onClose={() => setOpen(false)} onDone={() => { setOpen(false); void reload(); }} />
    </section>
  );
}

function WastageDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const t = useMsg(INV_MSG);
  const { locale } = useLocale();
  const refs = useRefs();
  const key = useIdempotencyKey();
  const [item, setItem] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("");
  const [reason, setReason] = useState<string>("spoilage");
  const [loc, setLoc] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = refs.itemById(item)?.base_unit;

  async function save() {
    if (!item || !isQty(qty)) { setErr(!item ? t("item") : t("qty")); return; }
    setBusy(true); setErr(null);
    try {
      await inv.recordWastage({ idempotency_key: key.get(), item_id: item, quantity: qty.trim(), unit: unit || base || "pcs", reason_code: reason, note: note.trim() || null, location_id: loc || null });
      key.renew(); toast.success(t("wasteSaved")); setItem(""); setQty(""); setNote(""); onDone();
    } catch (e) { setErr(errText(e, "Could not record the wastage")); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }} locale={locale} title={t("wasteNew")}
      footer={<><Button onClick={onClose}>{t("cancel")}</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{t("save")}</Button></>}>
      <div className="space-y-3">
        {err && <Notice tone="danger" locale={locale}>{err}</Notice>}
        <Select label={t("item")} value={item} onChange={(e) => { setItem(e.target.value); setUnit(""); }}>
          <option value="">{t("item")}</option>
          {refs.items.filter((i) => i.is_active !== false).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </Select>
        <div className="grid grid-cols-2 gap-2">
          <Input label={t("qty")} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
          <Select label={t("unit")} value={unit || base || "pcs"} onChange={(e) => setUnit(e.target.value)}>{unitsFor(base).map((u) => <option key={u}>{u}</option>)}</Select>
        </div>
        <Select label={t("wasteReason")} value={reason} onChange={(e) => setReason(e.target.value)}>{WASTE_REASONS.map((r) => <option key={r} value={r}>{t(`reason_${r}`)}</option>)}</Select>
        {refs.locations.length > 1 && (
          <Select label={t("location")} value={loc} onChange={(e) => setLoc(e.target.value)}>
            <option value="">{refs.locations.find((l) => l.is_default)?.name ?? t("locDefault")}</option>
            {refs.locations.filter((l) => l.is_active && !l.is_default).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        )}
        <Input label={t("note")} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Dialog>
  );
}
