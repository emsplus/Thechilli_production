"use client";

import { useMemo, useState } from "react";
import { ClipboardCheck, Plus } from "lucide-react";
import { Badge, Button, ConfirmDialog, Dialog, Input, Notice, Select, Sheet } from "@chilli/ui";
import { DataTable, type DataColumn } from "@chilli/ui/data";
import { toast } from "@/components/ui";
import { InlineInput } from "@/components/inline-fields";
import { useLocale, useMsg } from "@/lib/i18n";
import { inv, isQty, PERM, type StockCount } from "@/lib/inventoryApi";
import { prettyQty } from "@/lib/units";
import { useCan } from "@/lib/useRole";
import { INV_MSG } from "./messages";
import { errText, fmtDate, Gate, useRefs, useSection } from "./shared";

export function CountsSection() {
  const t = useMsg(INV_MSG);
  const { locale } = useLocale();
  const refs = useRefs();
  const { can } = useCan();
  const { state, reload } = useSection(() => inv.counts(), []);
  const [start, setStart] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const canCount = can(PERM.count);

  const cols: DataColumn<StockCount>[] = [
    { key: "name", header: t("number"), sortValue: (c) => c.name ?? "", render: (c) => <button type="button" className="min-h-11 font-semibold text-primary underline-offset-2 hover:underline" onClick={() => setOpen(c.id)}>{c.name || fmtDate(c.posted_at) || t("counts")}</button> },
    { key: "loc", header: t("location"), sortValue: (c) => refs.locationName(c.location_id), render: (c) => refs.locationName(c.location_id) },
    { key: "status", header: t("status"), sortValue: (c) => c.status, csv: (c) => c.status, render: (c) => <Badge tone={c.status === "posted" ? "success" : "warning"}>{c.status === "posted" ? t("countPosted") : t("countOpen")}</Badge> },
    { key: "date", header: t("date"), sortValue: (c) => c.posted_at ?? "", render: (c) => fmtDate(c.posted_at) },
    { key: "lines", header: t("counted"), align: "end", sortValue: (c) => c.lines.length, render: (c) => <span className="tnum">{c.lines.length}</span> },
  ];

  return (
    <section aria-label={t("counts")} className="space-y-4">
      {canCount && <div className="flex justify-end"><Button variant="primary" iconStart={<Plus />} onClick={() => setStart(true)}>{t("countNew")}</Button></div>}
      <Gate state={state} reload={() => void reload()}>
        {(rows) => <DataTable caption={t("counts")} columns={cols} rows={rows} getKey={(c) => c.id} exportName="stock-counts" locale={locale}
          empty={<div className="py-8 text-center"><p className="font-semibold text-fg">{t("countEmpty")}</p><p className="mt-1 text-sm text-fg-muted">{t("countEmptyHint")}</p></div>} />}
      </Gate>
      <StartDialog open={start} onClose={() => setStart(false)} onStarted={(c) => { setStart(false); setOpen(c.id); void reload(); }} />
      <CountSheet id={open} onClose={() => setOpen(null)} onChanged={() => void reload()} canCount={canCount} />
    </section>
  );
}

function StartDialog({ open, onClose, onStarted }: { open: boolean; onClose: () => void; onStarted: (c: StockCount) => void }) {
  const t = useMsg(INV_MSG);
  const { locale } = useLocale();
  const refs = useRefs();
  const [name, setName] = useState("");
  const [loc, setLoc] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true); setErr(null);
    try { onStarted(await inv.openCount({ name: name.trim() || null, location_id: loc || null })); setName(""); }
    catch (e) { setErr(errText(e, "Could not start the count")); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }} locale={locale} title={t("countNew")}
      footer={<><Button onClick={onClose}>{t("cancel")}</Button><Button variant="primary" iconStart={<ClipboardCheck />} loading={busy} onClick={() => void go()}>{t("countNew")}</Button></>}>
      <div className="space-y-3">
        {err && <Notice tone="danger" locale={locale}>{err}</Notice>}
        <Input label={t("countName")} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        {refs.locations.length > 1 && (
          <Select label={t("location")} value={loc} onChange={(e) => setLoc(e.target.value)}>
            <option value="">{refs.locations.find((l) => l.is_default)?.name ?? t("locDefault")}</option>
            {refs.locations.filter((l) => l.is_active && !l.is_default).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        )}
      </div>
    </Dialog>
  );
}

/** One count: enter what is on the shelf per item, save, then post (the server compares with the location balance and posts the variance). */
function CountSheet({ id, onClose, onChanged, canCount }: { id: string | null; onClose: () => void; onChanged: () => void; canCount: boolean }) {
  const t = useMsg(INV_MSG);
  const { locale } = useLocale();
  const refs = useRefs();
  const { state, reload } = useSection(() => (id ? inv.count(id) : Promise.resolve(null)), [id]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(false);
  const count = state.status === "ready" ? state.data : null;

  // Fill the entry fields when a (re)loaded count arrives: adjusting state during render, not in an effect.
  const [seen, setSeen] = useState<typeof count>(null);
  if (count !== seen) {
    setSeen(count);
    if (count) {
      const m: Record<string, string> = {};
      for (const l of count.lines) m[l.item_id] = String(Number(l.counted_base));
      setVals(m);
    }
  }

  const posted = count?.status === "posted";
  const items = useMemo(() => refs.items.filter((i) => i.is_active !== false), [refs.items]);
  const filled = items.filter((i) => (vals[i.id] ?? "").trim() !== "");
  const invalid = filled.some((i) => !isQty(vals[i.id], true));
  const lineOf = (itemId: string) => count?.lines.find((l) => l.item_id === itemId);

  async function save(): Promise<boolean> {
    if (!count || !filled.length || invalid) return false;
    setBusy(true); setErr(null);
    try { await inv.setCountLines(count.id, filled.map((i) => ({ item_id: i.id, counted: vals[i.id].trim(), unit: i.base_unit }))); await reload(); onChanged(); return true; }
    catch (e) { setErr(errText(e, "Could not save the counts")); return false; } finally { setBusy(false); }
  }
  async function post() {
    if (!count) return;
    setAsk(false);
    if (!(await save())) return;
    setBusy(true);
    try { await inv.postCount(count.id); toast.success(t("countPostedDone")); await reload(); onChanged(); }
    catch (e) { setErr(errText(e, "Could not post the count")); } finally { setBusy(false); }
  }

  return (
    <Sheet side="right" open={!!id} onOpenChange={(o) => { if (!o) onClose(); }} locale={locale} title={count?.name || t("counts")}
      description={count ? `${refs.locationName(count.location_id)} · ${posted ? t("countPosted") : t("countOpen")}` : undefined}
      footer={count && !posted && canCount ? <>
        <Button loading={busy} disabled={!filled.length || invalid} onClick={() => void save().then((ok) => ok && toast.success(t("countSaved")))}>{t("saveLines")}</Button>
        <Button variant="primary" iconStart={<ClipboardCheck />} loading={busy} disabled={!filled.length || invalid} onClick={() => setAsk(true)}>{t("postCount")}</Button>
      </> : undefined}>
      <Gate state={state} reload={() => void reload()}>
        {(c) => !c ? null : (
          <div className="space-y-3">
            {err && <Notice tone="danger" locale={locale}>{err}</Notice>}
            <ul className="divide-y divide-border rounded-xl border border-border">
              {(posted ? items.filter((i) => lineOf(i.id)) : items).map((i) => {
                const l = lineOf(i.id);
                const v = l?.variance ? Number(l.variance) : null;
                return (
                  <li key={i.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-fg">{i.name}</p>
                      <p className="tnum text-xs text-fg-subtle">{t("expected")} {prettyQty(l?.expected_base ?? i.balance, i.base_unit)}</p></div>
                    {posted ? (
                      <Badge tone={v === 0 || v === null ? "success" : v < 0 ? "danger" : "warning"}>{v === 0 || v === null ? t("matches") : `${v > 0 ? "+" : ""}${prettyQty(String(v), i.base_unit)}`}</Badge>
                    ) : (
                      <InlineInput aria-label={`${t("counted")} ${i.name} (${i.base_unit})`} wrapperClassName="w-28" inputMode="decimal" placeholder={i.base_unit} value={vals[i.id] ?? ""} onChange={(e) => setVals((s) => ({ ...s, [i.id]: e.target.value }))} />
                    )}
                  </li>);
              })}
            </ul>
          </div>
        )}
      </Gate>
      <ConfirmDialog open={ask} onOpenChange={setAsk} locale={locale} title={t("postCount")} description={t("postCountAsk")} confirmLabel={t("postCount")} onConfirm={() => void post()} />
    </Sheet>
  );
}
