"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Badge, Button, ConfirmDialog, Notice, Select, Switch } from "@chilli/ui";
import { DataTable, FilterBar, type DataColumn } from "@chilli/ui/data";
import { toast } from "@/components/ui";
import { useLocale, useMsg } from "@/lib/i18n";
import { daysToExpiry, expiryState, fefoSort, inv, PERM, type StockBatch } from "@/lib/inventoryApi";
import { formatCurrency } from "@/lib/money";
import { prettyQty } from "@/lib/units";
import { useCurrency } from "@/lib/taxConfig";
import { useCan } from "@/lib/useRole";
import { INV_MSG } from "./messages";
import { ErrorNotice, errText, fmtDate, Gate, useIdempotencyKey, useRefs, useSection } from "./shared";

export function BatchesSection() {
  const t = useMsg(INV_MSG);
  const { locale } = useLocale();
  const cur = useCurrency();
  const refs = useRefs();
  const { can } = useCan();
  const key = useIdempotencyKey();
  const [within, setWithin] = useState("");
  const [expired, setExpired] = useState(false);
  const [item, setItem] = useState("");
  const { state, reload } = useSection(() => inv.batches({ item_id: item || undefined, expiring_within_days: within ? Number(within) : undefined, expired }), [within, expired, item]);
  const [off, setOff] = useState<StockBatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function writeOff() {
    if (!off) return;
    setBusy(true); setErr(null);
    try { await inv.writeOff(off.id, { idempotency_key: key.get() }); key.renew(); toast.success(t("writeOffDone")); setOff(null); await reload(); }
    catch (e) { setErr(errText(e, "Could not write off the batch")); setOff(null); } finally { setBusy(false); }
  }

  const tag = (b: StockBatch) => {
    const s = expiryState(b);
    const d = daysToExpiry(b.expiry_date);
    if (s === "none") return <Badge tone="neutral">{t("noExpiry")}</Badge>;
    if (s === "expired") return <Badge tone="danger">{t("expiredTag")}</Badge>;
    if (s === "soon") return <Badge tone="warning">{d === 0 ? t("todayTag") : t("soonTag", { n: d ?? 0 })}</Badge>;
    return <Badge tone="success">{fmtDate(b.expiry_date)}</Badge>;
  };
  const cols: DataColumn<StockBatch>[] = [
    { key: "item", header: t("item"), sortValue: (b) => b.item_name, render: (b) => <span className="font-medium">{b.item_name}</span> },
    { key: "batch", header: t("batchNo"), sortValue: (b) => b.batch_no, render: (b) => b.batch_no },
    { key: "loc", header: t("location"), sortValue: (b) => refs.locationName(b.location_id), render: (b) => refs.locationName(b.location_id) },
    { key: "exp", header: t("expiry"), sortValue: (b) => b.expiry_date ?? "9999-12-31", csv: (b) => b.expiry_date ?? "", render: tag },
    { key: "rem", header: t("remaining"), align: "end", sortValue: (b) => Number(b.remaining), csv: (b) => b.remaining, render: (b) => <span className="tnum">{prettyQty(b.remaining, b.unit)}</span> },
    { key: "cost", header: t("value"), align: "end", sortValue: (b) => Number(b.unit_cost ?? 0) * Number(b.remaining), csv: (b) => b.unit_cost ?? "", render: (b) => <span className="tnum">{b.unit_cost ? formatCurrency(String(Number(b.unit_cost) * Number(b.remaining)), cur) : ""}</span> },
    { key: "act", header: t("actions"), render: (b) => can(PERM.wastage) && Number(b.remaining) > 0 ? <Button size="sm" variant="danger-soft" iconStart={<Trash2 />} aria-label={`${t("writeOff")} ${b.item_name} ${b.batch_no}`} onClick={() => setOff(b)}>{t("writeOff")}</Button> : null },
  ];

  return (
    <section aria-label={t("batches")} className="space-y-4">
      <Notice tone="info" locale={locale}>{t("batchFefo")}</Notice>
      <FilterBar label={t("batches")} locale={locale} activeCount={(within ? 1 : 0) + (expired ? 1 : 0) + (item ? 1 : 0)} onReset={() => { setWithin(""); setExpired(false); setItem(""); }}>
        <Select label={t("item")} value={item} onChange={(e) => setItem(e.target.value)}>
          <option value="">{t("all")}</option>
          {refs.items.filter((i) => i.tracks_batches).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </Select>
        <Select label={t("within")} value={within} onChange={(e) => setWithin(e.target.value)}>
          <option value="">{t("all")}</option>
          {[3, 7, 14, 30].map((d) => <option key={d} value={d}>{t("days", { n: d })}</option>)}
        </Select>
        <Switch label={t("expiredOnly")} checked={expired} onChange={(e) => setExpired(e.target.checked)} />
      </FilterBar>
      <ErrorNotice message={err} />
      <Gate state={state} reload={() => void reload()}>
        {(rows) => <DataTable caption={t("batches")} columns={cols} rows={fefoSort(rows)} getKey={(b) => b.id} exportName="stock-batches" locale={locale}
          empty={<div className="py-8 text-center"><p className="font-semibold text-fg">{t("batchEmpty")}</p><p className="mt-1 text-sm text-fg-muted">{t("batchEmptyHint")}</p></div>} />}
      </Gate>
      <ConfirmDialog open={!!off} onOpenChange={(o) => { if (!o) setOff(null); }} locale={locale} busy={busy} destructive title={off ? `${t("writeOff")}: ${off.item_name} ${off.batch_no}` : ""}
        description={t("writeOffAsk")} confirmLabel={t("writeOff")} onConfirm={() => void writeOff()} />
    </section>
  );
}
