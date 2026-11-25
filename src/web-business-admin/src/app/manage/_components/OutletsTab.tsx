"use client";

import { useEffect, useState } from "react";
import { Building2, Pencil, Plus, Power } from "lucide-react";
import "@chilli/ui/data.css";
import { DataTable, type DataColumn } from "@chilli/ui/data";
import { Badge, Button, Dialog, Input, Notice, Section, Textarea } from "@chilli/ui";
import { toast, useConfirm } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/useRole";
import { INDIA, normaliseTaxNumber, taxNumberError } from "@/lib/countries";
import { useLocale, useMsg } from "@/lib/i18n";
import { cleanCode, limitMessage, MAX_PREFIX_LENGTH, outletQuota, quotaText } from "@/lib/outlets";
import { useLoader } from "@/lib/useLoader";
import type { Outlet } from "@/lib/types";
import { useManage } from "./manage-context";
import { OUTLETS_MSG } from "./outlets-messages";

const fetchOutlets = () => api.outlets();
const em = (e: unknown, fb: string) => (e instanceof ApiError ? e.message : fb);
const limitHit = (e: unknown) => e instanceof ApiError && (e.code === "outlet_limit_reached" || (e.status === 403 && /outlet.?limit/i.test(e.message)));

/** Locations of the business. Creating one is capped by the plan (`outlet_limit` in /auth/me entitlements; absent = unlimited). */
export function OutletsTab() {
  const { biz } = useCan();
  const t = useMsg(OUTLETS_MSG);
  const { locale } = useLocale();
  const { me, refresh } = useManage();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useLoader(fetchOutlets);
  const [editing, setEditing] = useState<Outlet | "new" | null>(null);
  const canManage = me.permissions ? me.permissions.includes("outlets.manage") : me.role === "owner" || me.role === "manager";
  const readOnly = !!me.read_only;
  const list = data ?? [];
  const quota = outletQuota(me, list);

  async function toggle(o: Outlet) {
    if (o.is_active && !(await confirm({ title: t("confirmOffTitle", { name: o.name }), description: t("confirmOffDesc"), confirmLabel: t("switchOff"), tone: "danger" }))) return;
    try { await api.updateOutlet(o.id, { is_active: !o.is_active }); toast.success(o.is_active ? t("toastOff", { name: o.name }) : t("toastOn", { name: o.name })); await reload(); refresh(); }
    catch (e) { toast.error(limitHit(e) ? limitMessage(locale) : em(e, t("updateFail"))); }
  }

  const columns: DataColumn<Outlet>[] = [
    { key: "name", header: t("thOutlet"), sortValue: (o) => o.name, render: (o) => <span><span className="font-semibold">{o.name}</span>{o.address ? <span className="block text-xs opacity-70">{o.address}</span> : null}</span> },
    { key: "code", header: t("thCode"), sortValue: (o) => o.code, render: (o) => <span><code>{o.code}</code>{o.invoice_prefix ? <span className="block text-xs opacity-70">{t("invoices", { prefix: o.invoice_prefix })}</span> : null}</span> },
    { key: "status", header: t("thStatus"), sortValue: (o) => (o.is_active ? 0 : 1), render: (o) => (
      <span className="flex flex-wrap gap-1">{o.is_default && <Badge tone="primary">{t("main")}</Badge>}<Badge tone={o.is_active ? "success" : "neutral"}>{o.is_active ? t("active") : t("switchedOff")}</Badge></span>
    ) },
    { key: "actions", header: "", render: (o) => canManage ? (
      <span className="flex gap-1.5">
        <Button size="sm" variant="secondary" iconStart={<Pencil />} aria-label={t("editAria", { name: o.name })} disabled={readOnly} onClick={() => setEditing(o)}>{t("edit")}</Button>
        {!o.is_default && <Button size="sm" variant={o.is_active ? "danger-soft" : "secondary"} iconStart={<Power />} aria-label={t(o.is_active ? "switchOffAria" : "switchOnAria", { name: o.name })} disabled={readOnly || (!o.is_active && quota.reached)} onClick={() => void toggle(o)}>{o.is_active ? t("switchOff") : t("switchOn")}</Button>}
      </span>
    ) : null },
  ];

  return (
    <div className="space-y-4" data-testid="outlets-tab">
      <Section title={t("title")} description={biz.tables ? t("desc") : t("descNoTables")} actions={canManage ? (
        <Button variant="primary" iconStart={<Plus />} disabled={readOnly || quota.reached || loading || !!error} onClick={() => setEditing("new")}>{t("add")}</Button>
      ) : undefined}>
        {!loading && !error && <p data-testid="outlet-quota" className="mb-3 text-sm text-fg-muted">{quotaText(quota, locale)}</p>}
        {quota.reached && canManage && <Notice tone="warning" title={t("limitTitle")}>{limitMessage(locale)}</Notice>}
        {readOnly && <Notice tone="warning" title={t("readOnlyTitle")}>{t("readOnlyBody")}</Notice>}
        {error && <Notice tone="danger" action={<Button variant="secondary" size="sm" onClick={() => void reload()}>{t("retry")}</Button>}>{error}</Notice>}
        <div className="mt-3">
          <DataTable<Outlet> caption={t("title")} columns={columns} rows={list} getKey={(o) => o.id} status={loading ? "loading" : error ? "error" : "ready"} onRetry={() => void reload()} loadingRows={2}
            empty={<div className="py-4 text-center text-sm text-fg-muted"><Building2 aria-hidden className="mx-auto mb-2 size-6" />{t("empty")}</div>} />
        </div>
      </Section>
      <OutletDialog target={editing} onClose={() => setEditing(null)} onDone={() => { void reload(); refresh(); }} />
    </div>
  );
}

function OutletDialog({ target, onClose, onDone }: { target: Outlet | "new" | null; onClose: () => void; onDone: () => void }) {
  const t = useMsg(OUTLETS_MSG);
  const { locale } = useLocale();
  const isNew = target === "new";
  const info = INDIA;
  const [v, setV] = useState({ name: "", code: "", prefix: "", address: "", phone: "", trn: "" });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [top, setTop] = useState<string | null>(null);
  useEffect(() => {
    if (!target) return;
    void Promise.resolve().then(() => {
      setErrs({}); setTop(null);
      setV(target === "new" ? { name: "", code: "", prefix: "", address: "", phone: "", trn: "" } : { name: target.name, code: target.code, prefix: target.invoice_prefix, address: target.address ?? "", phone: target.phone ?? "", trn: target.trn ?? "" });
    });
  }, [target]);
  const set = (k: keyof typeof v, val: string) => setV((x) => ({ ...x, [k]: val }));
  const maxPrefix = MAX_PREFIX_LENGTH;

  async function save() {
    if (!target) return;
    const e: Record<string, string> = {};
    if (!v.name.trim()) e.name = t("vName");
    if (isNew) {
      if (!v.code) e.code = t("vCode");
      if (!v.prefix) e.prefix = t("vPrefix");
      else if (v.prefix.length > maxPrefix) e.prefix = t("vPrefixMaxIN", { max: maxPrefix });
    }
    const tn = taxNumberError("IN", v.trn);
    if (tn) e.trn = tn;
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true); setTop(null);
    const common = { name: v.name.trim(), address: v.address.trim() || null, phone: v.phone.trim() || null, trn: v.trn ? normaliseTaxNumber(v.trn) : null };
    try {
      if (isNew) await api.createOutlet({ ...common, code: v.code, invoice_prefix: v.prefix });
      else await api.updateOutlet((target as Outlet).id, common);
      toast.success(t(isNew ? "added" : "saved", { name: common.name })); onClose(); onDone();
    } catch (err) {
      setTop(limitHit(err) ? limitMessage(locale) : err instanceof ApiError && err.status === 409 ? t("conflict") : em(err, t("saveFail")));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o) onClose(); }} title={isNew ? t("add") : t("editTitle")}
      description={isNew ? t("descNew") : t("descEdit")}
      footer={<><Button variant="secondary" onClick={onClose}>{t("cancel")}</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{isNew ? t("add") : t("save")}</Button></>}>
      <div className="space-y-4 py-2">
        {top && <Notice tone="danger">{top}</Notice>}
        <Input label={t("name")} value={v.name} error={errs.name} autoFocus onChange={(e) => set("name", e.target.value)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label={t("code")} value={v.code} disabled={!isNew} maxLength={10} error={errs.code} hint={t("codeHint")} onChange={(e) => set("code", cleanCode(e.target.value))} />
          <Input label={t("prefix")} value={v.prefix} disabled={!isNew} maxLength={10} error={errs.prefix} hint={t("prefixHint", { max: maxPrefix })} onChange={(e) => set("prefix", cleanCode(e.target.value))} />
        </div>
        <Textarea label={t("address")} rows={2} value={v.address} hint={t("addressHint")} onChange={(e) => set("address", e.target.value)} />
        <Input label={t("phone")} type="tel" inputMode="tel" value={v.phone} placeholder={t("phoneExIN")} onChange={(e) => set("phone", e.target.value)} />
        <Input label={info.taxNumberLabel} value={v.trn} placeholder={info.example} error={errs.trn} hint={t("trnHint")} onChange={(e) => set("trn", e.target.value)} />
      </div>
    </Dialog>
  );
}
