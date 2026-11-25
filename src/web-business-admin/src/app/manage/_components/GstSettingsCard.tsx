"use client";

import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { Button, Input, Notice, Select, Switch } from "@chilli/ui";
import { Card, CardHeader, Skeleton, toast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { GST_STATE_OPTIONS } from "@/lib/gstStates";
import { useMsg } from "@/lib/i18n";
import { isUnsupported } from "@/lib/roles";
import { GST_MSG } from "./settings-messages";

/** GET/PUT /restaurant/gst (pos-service phase2/gst, owner only). Absent on older servers: the card then does not render at all. */
interface GstSettings { tax_mode: "off" | "gst_engine"; config?: { state_code?: string; treatment?: string; restaurant_sac?: string; round_off?: boolean; default_place_of_supply?: string; composition_legend?: string } | null; admin_warning?: string | null }
const TREATMENTS = ["restaurant_5_no_itc", "restaurant_18_with_itc", "composition", "goods_only"];

export function GstSettingsCard({ canEdit, gstin }: { canEdit: boolean; gstin: string }) {
  const t = useMsg(GST_MSG);
  const [state, setState] = useState<"loading" | "absent" | "error" | "ready">("loading");
  const [s, setS] = useState<GstSettings>({ tax_mode: "off" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    setState("loading");
    api.gstSettings().then((r) => { setS(r as GstSettings); setState("ready"); }, (e) => setState(isUnsupported(e) ? "absent" : "error"));
  };
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(load, []);
  if (state === "absent") return null;
  if (state === "loading") return <Skeleton className="h-40 rounded-2xl" />;
  if (state === "error") return <Notice tone="danger" action={<Button type="button" variant="secondary" size="sm" onClick={load}>{t("retry")}</Button>}>{t("loadFail")}</Notice>;

  const on = s.tax_mode === "gst_engine";
  const cfg = s.config ?? {};
  const set = (patch: Partial<NonNullable<GstSettings["config"]>>) => setS((x) => ({ ...x, config: { ...x.config, ...patch } }));
  const guess = gstin.replace(/[\s-]/g, "").slice(0, 2);

  async function save() {
    setErr(null);
    if (on && !(cfg.state_code ?? guess)) { setErr(t("needState")); return; }
    setBusy(true);
    try {
      const r = await api.saveGstSettings({ tax_mode: s.tax_mode, config: on ? { ...cfg, state_code: cfg.state_code ?? guess } : cfg });
      setS(r as GstSettings); toast.success(t("saved"));
    } catch (e) { setErr(e instanceof ApiError ? e.message : t("saveFail")); } finally { setBusy(false); }
  }

  return (
    <Card data-testid="gst-card">
      <CardHeader title={t("title")} description={t("desc")} />
      {s.admin_warning && <Notice tone="warning" className="mb-3">{s.admin_warning}</Notice>}
      {err && <Notice tone="danger" className="mb-3">{err}</Notice>}
      <Switch label={t("engine")} hint={t("engineHint")} checked={on} disabled={!canEdit}
        onChange={(e) => setS((x) => ({ ...x, tax_mode: e.target.checked ? "gst_engine" : "off" }))} />
      {on && (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Select label={t("state")} disabled={!canEdit} value={cfg.state_code ?? guess} onChange={(e) => set({ state_code: e.target.value })}>
              <option value="">{t("chooseState")}</option>
              {GST_STATE_OPTIONS.map((o) => <option key={o.code} value={o.code}>{o.code} {o.name}</option>)}
          </Select>
          <Select label={t("treatment")} disabled={!canEdit} value={cfg.treatment ?? "restaurant_5_no_itc"} onChange={(e) => set({ treatment: e.target.value })}>
              {TREATMENTS.map((v) => <option key={v} value={v}>{t(`tr_${v}`)}</option>)}
          </Select>
          <Input label={t("sac")} inputMode="numeric" disabled={!canEdit} placeholder="996331" value={cfg.restaurant_sac ?? ""} onChange={(e) => set({ restaurant_sac: e.target.value })} hint={t("sacHint")} />
          <Select label={t("pos")} disabled={!canEdit} value={cfg.default_place_of_supply ?? ""} onChange={(e) => set({ default_place_of_supply: e.target.value })}>
              <option value="">{t("posNone")}</option>
              {GST_STATE_OPTIONS.map((o) => <option key={o.code} value={o.code}>{o.code} {o.name}</option>)}
          </Select>
          <div className="sm:col-span-2"><Switch label={t("round")} hint={t("roundHint")} checked={cfg.round_off ?? true} disabled={!canEdit} onChange={(e) => set({ round_off: e.target.checked })} /></div>
        </div>
      )}
      {canEdit && <Button type="button" className="mt-4" variant="primary" iconStart={<Save />} loading={busy} onClick={() => void save()}>{t("save")}</Button>}
    </Card>
  );
}
