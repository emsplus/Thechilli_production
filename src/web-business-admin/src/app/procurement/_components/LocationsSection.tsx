"use client";

import { useState } from "react";
import { Plus, Power } from "lucide-react";
import { Badge, Button, Dialog, Input, Notice, Select, Switch } from "@chilli/ui";
import { DataTable, type DataColumn } from "@chilli/ui/data";
import { toast } from "@/components/ui";
import { useLocale, useMsg } from "@/lib/i18n";
import { inv, LOCATION_KINDS, PERM, type NegativeStock, type StockLocation } from "@/lib/inventoryApi";
import { prettyQty } from "@/lib/units";
import { useCan } from "@/lib/useRole";
import { INV_MSG } from "./messages";
import { ErrorNotice, errText, Gate, useRefs, useSection } from "./shared";

export function LocationsSection() {
  const t = useMsg(INV_MSG);
  const { locale } = useLocale();
  const { can } = useCan();
  const refs = useRefs();
  const [all, setAll] = useState(false);
  const { state, reload } = useSection(() => inv.locations(all), [all]);
  const negative = useSection(() => (can(PERM.manage) ? inv.negativeStock() : Promise.resolve<NegativeStock[]>([])), [can]);
  const [form, setForm] = useState<{ loc: StockLocation | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const canManage = can(PERM.manage);

  async function toggle(l: StockLocation) {
    setErr(null);
    try { await inv.patchLocation(l.id, { is_active: !l.is_active }); await reload(); refs.reloadLocations(); }
    catch (e) { setErr(errText(e, "Could not update the location")); }
  }
  const cols: DataColumn<StockLocation>[] = [
    { key: "name", header: t("location"), sortValue: (l) => l.name, render: (l) => <span className="font-medium">{l.name}{l.is_default && <> <Badge tone="primary">{t("locDefault")}</Badge></>}{!l.is_active && <> <Badge tone="neutral">{t("locOff")}</Badge></>}</span> },
    { key: "kind", header: t("locKind"), sortValue: (l) => l.kind, csv: (l) => l.kind, render: (l) => t(`kind_${l.kind}`) },
    { key: "act", header: t("actions"), render: (l) => canManage ? (
      <span className="flex flex-wrap gap-1">
        <Button size="sm" onClick={() => setForm({ loc: l })}>{t("poEdit").split(" ")[0]}</Button>
        {!l.is_default && <Button size="sm" variant={l.is_active ? "danger-soft" : "secondary"} iconStart={<Power />} onClick={() => void toggle(l)}>{l.is_active ? t("locSwitchOff") : t("locSwitchOn")}</Button>}
      </span>) : null },
  ];
  return (
    <section aria-label={t("locations")} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Switch label={t("locShowOff")} checked={all} onChange={(e) => setAll(e.target.checked)} />
        {canManage && <Button variant="primary" iconStart={<Plus />} onClick={() => setForm({ loc: null })}>{t("locNew")}</Button>}
      </div>
      <ErrorNotice message={err} />
      <Gate state={state} reload={() => void reload()}>
        {(rows) => <DataTable caption={t("locations")} columns={cols} rows={rows} getKey={(l) => l.id} locale={locale}
          empty={<div className="py-8 text-center"><p className="font-semibold text-fg">{t("locEmpty")}</p></div>} />}
      </Gate>
      {negative.state.status === "ready" && negative.state.data.length > 0 && (
        <Notice tone="warning" title={t("locNegative")} locale={locale}>
          <p>{t("locNegativeHint")}</p>
          <ul className="mt-1 space-y-0.5">{negative.state.data.map((n) => <li key={`${n.item_id}-${n.location_id}`} className="tnum">{n.item_name} · {n.location_name}: {prettyQty(n.balance, n.unit)}</li>)}</ul>
        </Notice>
      )}
      <LocationDialog state={form} onClose={() => setForm(null)} onSaved={() => { setForm(null); void reload(); refs.reloadLocations(); }} />
    </section>
  );
}

function LocationDialog({ state, onClose, onSaved }: { state: { loc: StockLocation | null } | null; onClose: () => void; onSaved: () => void }) {
  const t = useMsg(INV_MSG);
  const { locale } = useLocale();
  const loc = state?.loc ?? null;
  const [name, setName] = useState("");
  const [kind, setKind] = useState("store");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const sig = state ? loc?.id ?? "new" : null;
  if (sig !== shown) { setShown(sig); if (state) { setName(loc?.name ?? ""); setKind(loc?.kind ?? "store"); setErr(null); } }
  async function save() {
    if (!name.trim()) { setErr(t("locName")); return; }
    setBusy(true); setErr(null);
    try { if (loc) await inv.patchLocation(loc.id, { name: name.trim(), kind }); else await inv.createLocation({ name: name.trim(), kind }); toast.success(t("locSaved")); onSaved(); }
    catch (e) { setErr(errText(e, "Could not save the location")); } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!state} onOpenChange={(o) => { if (!o) onClose(); }} locale={locale} title={loc ? loc.name : t("locNew")}
      footer={<><Button onClick={onClose}>{t("cancel")}</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{t("save")}</Button></>}>
      <div className="space-y-3">
        {err && <Notice tone="danger" locale={locale}>{err}</Notice>}
        <Input label={t("locName")} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <Select label={t("locKind")} value={kind} onChange={(e) => setKind(e.target.value)}>{LOCATION_KINDS.map((k) => <option key={k} value={k}>{t(`kind_${k}`)}</option>)}</Select>
      </div>
    </Dialog>
  );
}
