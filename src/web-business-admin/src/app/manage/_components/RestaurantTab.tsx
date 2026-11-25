"use client";

import { UpiCard } from "@/components/setup/UpiCard";
import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertTriangle, Coins, Flag, Globe2, Percent, Save } from "lucide-react";
import { Badge, Button, Input, Notice, Switch, Table, Textarea } from "@chilli/ui";
import { Card, CardHeader, Skeleton, toast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { countryInfo, normaliseTaxNumber, taxNumberError } from "@/lib/countries";
import { stateOfGstin } from "@/lib/gstStates";
import { GstSettingsCard } from "./GstSettingsCard";
import { KitchenTargetCard } from "./KitchenTargetCard";
import { KitchenStatusCard } from "./KitchenStatusCard";
import { BusinessTypeCard } from "./BusinessTypeCard";
import { bizCapsOf } from "@/lib/business";
import { refreshRestaurantMeta } from "@/lib/restaurantMeta";
import { timezoneLabel } from "@/lib/timezoneLabel";
import { refreshTaxConfig, useTaxConfig } from "@/lib/taxConfig";
import { useLoader } from "@/lib/useLoader";
import { useMsg } from "@/lib/i18n";
import { useManage } from "./manage-context";
import { SETTINGS_MSG } from "./settings-messages";

const fetchRestaurant = () => api.restaurant();
const PCT = /^\d{0,3}(\.\d{1,2})?$/;

function makeSchema(country: string, t: (key: string) => string) {
  return z.object({
    name: z.string().trim().min(1, t("vName")).max(200, t("vMax200")),
    trn: z.string().trim().refine((v) => taxNumberError(country, v) === null, taxNumberError(country, "x") ?? t("vTaxNumber")),
    address: z.string().trim().max(500, t("vMax500")),
    phone: z.string().trim().max(30, t("vMax30")),
    z_report_next_number: z.string().trim().refine((v) => v === "" || (/^\d{1,8}$/.test(v) && Number(v) >= 1), t("vZNumber")),
    vat_registered: z.boolean(),
    prices_include_tax: z.boolean(),
    service_charge_percent: z.string().trim().refine((v) => v === "" || (PCT.test(v) && Number(v) >= 0 && Number(v) <= 30), t("vService")),
    max_cashier_discount_percent: z.string().trim().refine((v) => v !== "" && PCT.test(v) && Number(v) >= 0 && Number(v) <= 100, t("vDiscount")),
    bill_amend_days: z.string().trim().refine((v) => /^\d{1,3}$/.test(v) && Number(v) <= 366, t("vAmend")),
  });
}
type Form = z.infer<ReturnType<typeof makeSchema>>;

const toForm = (r: Awaited<ReturnType<typeof fetchRestaurant>>): Form => ({
  name: r.name, trn: r.trn ?? "", address: r.address ?? "", phone: r.phone ?? "", z_report_next_number: String(r.z_report_next_number ?? 1),
  vat_registered: r.vat_registered ?? true, prices_include_tax: r.prices_include_tax ?? false,
  service_charge_percent: Number(r.service_charge_percent ?? 0) > 0 ? String(Number(r.service_charge_percent)) : "",
  max_cashier_discount_percent: String(Number(r.max_cashier_discount_percent ?? 10)),
  bill_amend_days: String(r.bill_amend_days ?? 30),
});

export function RestaurantTab() {
  const t = useMsg(SETTINGS_MSG);
  const { me, isOwner, refresh } = useManage();
  // Service charge applies to eat-in orders only: a business without dine-in (cloud / hotel kitchen) does not see it.
  const dineIn = bizCapsOf(me).dine_in;
  /** Editing the profile and tax settings is owner-level (settings.owner); the server enforces. Older servers send no permission list. */
  const canEdit = me.permissions ? me.permissions.includes("settings.owner") : isOwner;
  const cfg = useTaxConfig();
  const { data, error, loading, reload } = useLoader(fetchRestaurant);
  const [saved, setSaved] = useState(false);
  const [zExists, setZExists] = useState<boolean | null>(null);
  const country = data?.country ?? cfg?.country ?? "IN";
  const info = countryInfo(country);
  const schema = useMemo(() => makeSchema(country, t), [country, t]);
  const { register, handleSubmit, reset, control, formState: { errors, isSubmitting, isDirty, dirtyFields } } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", trn: "", address: "", phone: "", z_report_next_number: "1", vat_registered: true, prices_include_tax: false, service_charge_percent: "", max_cashier_discount_percent: "10", bill_amend_days: "30" },
  });
  useEffect(() => { if (data) reset(toForm(data)); }, [data, reset]);

  // The first Z-report number can only be set before any Z-report exists.
  useEffect(() => {
    if (!data) return;
    let off = false;
    void api.zReports(null, 1).then((p) => { if (!off) setZExists(p.items.length > 0); }, () => { if (!off) setZExists(null); });
    return () => { off = true; };
  }, [data]);

  const registered = useWatch({ control, name: "vat_registered" });
  const trnValue = useWatch({ control, name: "trn" });

  const submit = handleSubmit(async (v) => {
    try {
      const r = await api.updateRestaurant({
        name: v.name, trn: v.trn ? normaliseTaxNumber(v.trn) : null, address: v.address || null, phone: v.phone || null,
        ...(zExists === false && dirtyFields.z_report_next_number && v.z_report_next_number !== "" ? { z_report_next_number: Number(v.z_report_next_number) } : {}),
        vat_registered: v.vat_registered, prices_include_tax: v.prices_include_tax,
        service_charge_percent: v.service_charge_percent === "" ? "0" : v.service_charge_percent,
        max_cashier_discount_percent: v.max_cashier_discount_percent,
        bill_amend_days: Number(v.bill_amend_days),
      });
      reset(toForm(r));
      toast.success(t("saved")); setSaved(true); void reload(); refresh(); void refreshTaxConfig(); refreshRestaurantMeta();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : t("saveFail")); }
  });


  if (loading) return <div role="status" aria-label={t("loadingProfile")} className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"><Skeleton className="h-96 rounded-2xl" /><Skeleton className="h-64 rounded-2xl" /></div>;
  if (error) return <Notice tone="danger" action={<Button variant="secondary" size="sm" onClick={() => void reload()}>{t("retry")}</Button>}>{error}</Notice>;

  const rates = cfg?.rates ?? [];
  const std = rates.find((r) => r.code === "standard");
  const rateTitle = rates.length > 1 ? `${std?.name ?? "GST"} ${rates.map((r) => `${Number(r.rate_percent)}%`).join(" / ")}` : rates[0] ? `${rates[0].name} ${Number(rates[0].rate_percent)}%` : "GST";

  return (
    <form onSubmit={(e) => { setSaved(false); void submit(e); }} noValidate className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card>
          <CardHeader title={t("profileTitle")} description={t("profileDesc")} />
          {!canEdit && <Notice tone="info" className="mb-4">{t("ownerOnly")}</Notice>}
          <div className="space-y-4">
            <Input label={t("nameLabel")} disabled={!canEdit} error={errors.name?.message} {...register("name")} />
            <Input label={t("trnIN")} maxLength={30} autoComplete="off" placeholder={info.example} disabled={!canEdit}
              hint={stateOfGstin(trnValue ?? "") ? t("trnStateHint", { help: info.help, state: stateOfGstin(trnValue ?? "") ?? "" }) : info.help} error={errors.trn?.message} {...register("trn")} />
            <Input label={t("phone")} type="tel" inputMode="tel" autoComplete="off" placeholder={t("phoneExIN")} disabled={!canEdit} hint={t("phoneHint")} error={errors.phone?.message} {...register("phone")} />
            <Textarea label={t("address")} disabled={!canEdit} rows={3} hint={t("addressHint")} error={errors.address?.message} {...register("address")} />
          </div>
        </Card>

        {data?.login_code && (
          <Card data-testid="restaurant-code-card">
            <CardHeader title="Restaurant code" description="Staff sign in with this code plus their phone number or username (on the waiter app, or Staff sign-in on this site). It only picks your restaurant; their password still decides." />
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-xl border border-border bg-surface-2/60 px-4 py-2 font-mono text-2xl font-bold tracking-[0.3em] text-fg" data-testid="restaurant-code">{data.login_code}</span>
              <Button variant="secondary" size="sm" onClick={() => { void navigator.clipboard.writeText(data.login_code ?? "").then(() => toast.success("Copied"), () => toast.error("Could not copy")); }}>Copy</Button>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader title={t("taxCharges", { tax: info.taxName })} description={t("taxChargesDesc")} action={<Badge tone="warning"><AlertTriangle />{t("confirmAccountant")}</Badge>} />
          <Notice tone="warning" className="mb-4">{t("rulesNoteIN", { tax: info.taxName })}</Notice>
          <div className="space-y-1 divide-y divide-border">
            <Switch label={t("registered", { tax: info.taxName })} hint={t("registeredHintIN", { tax: info.taxName })} disabled={!canEdit} {...register("vat_registered")} />
            <Switch label={t("pricesInclude", { tax: info.taxName })} hint={t("pricesIncludeHint", { tax: info.taxName })} disabled={!canEdit || !registered} {...register("prices_include_tax")} />
          </div>
          {dirtyFields.prices_include_tax && <Notice tone="warning" className="mt-3">{t("priceModeWarn")}</Notice>}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {dineIn && <Input label={t("service")} inputMode="decimal" placeholder={t("serviceEx")} disabled={!canEdit} hint={t("serviceHint", { tax: info.taxName })} error={errors.service_charge_percent?.message} {...register("service_charge_percent")} />}
            <Input label={t("maxDiscount")} inputMode="decimal" disabled={!canEdit} hint={t("maxDiscountHint")} error={errors.max_cashier_discount_percent?.message} {...register("max_cashier_discount_percent")} />
          </div>
        </Card>

        <GstSettingsCard canEdit={canEdit} gstin={trnValue ?? ""} />
        <UpiCard />

        <Card>
          <CardHeader title={t("amendTitle")} description={t("amendDesc")} />
          <Input label={t("amendLabel")} inputMode="numeric" disabled={!canEdit}
            hint={t("amendHint")}
            error={errors.bill_amend_days?.message} {...register("bill_amend_days")} />
        </Card>

        <Card>
          <CardHeader title={t("zTitle")} description={t("zDesc")} />
          <Input label={t("zNext")} inputMode="numeric" disabled={!canEdit || zExists !== false}
            hint={zExists
              ? t("zExists")
              : t("zSet")}
            error={errors.z_report_next_number?.message} {...register("z_report_next_number")} />
        </Card>

        {canEdit && (
          <div className="flex items-center gap-3">
            <Button variant="primary" type="submit" iconStart={<Save />} loading={isSubmitting} disabled={!isDirty}>{t("save")}</Button>
            {saved && !isDirty && <span role="status" className="text-sm font-medium text-success-fg">{t("savedBadge")}</span>}
          </div>
        )}
      </div>

      <div className="space-y-4">
        <BusinessTypeCard restaurant={data ?? null} canEdit={canEdit} />

        <Card>
          <CardHeader title={t("countryTitle")} description={t("countryDesc")} />
          <ul className="space-y-3 text-sm">
            <li className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-xl bg-surface-2 text-fg-muted"><Flag aria-hidden className="size-4" /></span><div><p className="text-xs text-fg-subtle">{t("country")}</p><p className="font-semibold text-fg" data-testid="country">{info.name}</p></div></li>
            <li className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-xl bg-surface-2 text-fg-muted"><Coins aria-hidden className="size-4" /></span><div><p className="text-xs text-fg-subtle">{t("currency")}</p><p className="font-semibold text-fg">{data?.currency}{data?.currency_symbol ? ` (${data.currency_symbol.trim()})` : ""}</p></div></li>
            <li className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-xl bg-surface-2 text-fg-muted"><Globe2 aria-hidden className="size-4" /></span><div><p className="text-xs text-fg-subtle">{t("timezone")}</p><p className="font-semibold text-fg">{timezoneLabel(data?.timezone, data?.timezone_label)}</p></div></li>
          </ul>
        </Card>

        <Card>
          <CardHeader title={t("ratesTitle", { tax: info.taxName })} action={<Badge tone="success"><Percent />{t("setBySystem")}</Badge>} />
          <p className="font-display text-lg font-bold text-fg">{rateTitle}</p>
          {rates.length > 0 && (
            <Table caption={t("ratesTitle", { tax: info.taxName })} rows={rates} getKey={(r) => r.code}
              columns={[
                { key: "name", header: t("thRate"), render: (r) => r.name },
                { key: "code", header: t("thCode"), render: (r) => <span className="capitalize">{r.code}</span> },
                { key: "pct", header: "%", align: "end", render: (r) => `${Number(r.rate_percent)}%` },
              ]} />
          )}
          <p className="mt-2 text-sm text-fg-muted">{t("gstSame")}</p>
        </Card>

        <KitchenStatusCard />
        <KitchenTargetCard />
      </div>
    </form>
  );
}
