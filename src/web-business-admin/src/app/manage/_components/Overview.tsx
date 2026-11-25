"use client";

import { Notice, Skeleton } from "@chilli/ui";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Armchair, ArrowRight, Bell, Boxes, CheckCircle2, ChefHat, Truck, UserCog, UtensilsCrossed, Users, Tags } from "lucide-react";
import { Card, CardHeader } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useMsg } from "@/lib/i18n";
import type { Restaurant } from "@/lib/types";
import { useManage } from "./manage-context";
import { NeedsAttentionCard } from "./NeedsAttentionCard";
import { MANAGE_MSG } from "./shell-messages";
import { ScanInvoiceCard, StartStockCard } from "./stock-flow";
import { SetupCard } from "@/components/setup/SetupCard";
import { TodayStrip } from "@/components/today/TodayStrip";
import { CreditCard } from "@/components/billing/CreditCard";
import { canOf, capabilitiesOf } from "@/lib/useRole";
import { bizCapsOf } from "@/lib/business";

function Tile({ href, icon, label, value, loading }: { href: string; icon: ReactNode; label: string; value: number; loading: boolean }) {
  return (
    <Link href={href} replace scroll={false} className="group rounded-2xl border border-border bg-surface p-4 shadow-card transition-[box-shadow,transform,border-color] hover:border-border-strong hover:shadow-pop focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [@media(hover:hover)]:hover:-translate-y-0.5">
      <span className="grid size-10 place-items-center rounded-xl bg-primary-soft text-primary-soft-fg ring-1 ring-primary/10 [&_svg]:size-5">{icon}</span>
      {loading ? <Skeleton className="mt-3 h-8 w-12" /> : <p className="mt-3 font-display text-3xl font-extrabold tracking-tight text-fg"><span className="tnum">{value}</span></p>}
      <p className="mt-0.5 flex items-center justify-between text-sm font-medium text-fg-muted">{label}<ArrowRight aria-hidden className="size-4 -translate-x-1 text-fg-subtle opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100" /></p>
    </Link>
  );
}

interface Attn { key: string; text: string; cta: string; href: string; icon: ReactNode }

export function Overview() {
  const t = useMsg(MANAGE_MSG);
  const { me, summary: s, refresh, goto } = useManage();
  const [rest, setRest] = useState<Restaurant | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    refresh();
    let off = false;
    api.restaurant().then((r) => { if (!off) setRest(r); }).catch((e) => { if (!off) setErr(e instanceof ApiError ? e.message : ""); });
    return () => { off = true; };
  }, [refresh]);

  const loading = !s;
  const attention: Attn[] = s ? [
    s.items_without_recipe > 0 && s.inventory_items > 0 && { key: "recipes", text: t(s.items_without_recipe === 1 ? "attnRecipeOne" : "attnRecipeMany", { n: s.items_without_recipe }), cta: t("ctaAddRecipes"), href: "/manage?tab=recipes", icon: <ChefHat /> },
    s.low_stock > 0 && { key: "stock", text: t(s.low_stock === 1 ? "attnStockOne" : "attnStockMany", { n: s.low_stock }), cta: t("ctaSeeStock"), href: "/manage?tab=inventory", icon: <Boxes /> },
    s.open_alerts > 0 && { key: "alerts", text: t(s.open_alerts === 1 ? "attnAlertOne" : "attnAlertMany", { n: s.open_alerts }), cta: t("ctaOpenAlerts"), href: "/alerts", icon: <Bell /> },
    s.staff_inactive > 0 && { key: "staff", text: t(s.staff_inactive === 1 ? "attnStaffOne" : "attnStaffMany", { n: s.staff_inactive }), cta: t("ctaReviewStaff"), href: "/manage?tab=staff", icon: <UserCog /> },
  ].filter(Boolean) as Attn[] : [];


  return (
    <div className="space-y-5">
      <Card className="relative overflow-hidden bg-gradient-to-br from-primary-soft/70 to-surface">
        <p className="text-sm font-medium text-primary-soft-fg">{t("hello", { name: me.full_name.split(" ")[0] })}</p>
        <h2 className="font-display text-xl font-extrabold tracking-tight text-fg sm:text-2xl">{rest?.name ?? t("yourRestaurant")}</h2>
        <p className="mt-1 max-w-xl text-sm text-fg-muted">{t("pickSection")}</p>
      </Card>

      <TodayStrip summary={s} />
      {/* Chilli credit (ux/wallet-reset-report put it on Today; Today now lives here as the strip above). */}
      <CreditCard canView={canOf(capabilitiesOf(me), "billing.view")} canTopUp={canOf(capabilitiesOf(me), "billing.topup")} />

      <SetupCard />

      {err !== null && <Notice tone="warning">{err || t("profileLoadFail")}</Notice>}

      {s && s.inventory_items === 0
        ? <StartStockCard from="overview" onImport={() => goto("inventory", undefined, { action: "import" })} onAdd={() => goto("inventory", undefined, { action: "add" })} />
        : <ScanInvoiceCard from="overview" />}

      <section aria-label={t("glance")} className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Tile href="/manage?tab=menu" icon={<UtensilsCrossed />} label={t("tileMenuItems")} value={s?.menu_items ?? 0} loading={loading} />
        <Tile href="/manage?tab=menu" icon={<Tags />} label={t("tileCategories")} value={s?.categories ?? 0} loading={loading} />
        {bizCapsOf(me).tables && <Tile href="/manage?tab=tables" icon={<Armchair />} label={t("tileTables")} value={s?.tables ?? 0} loading={loading} />}
        <Tile href="/manage?tab=inventory" icon={<Boxes />} label={t("tileStock")} value={s?.inventory_items ?? 0} loading={loading} />
        <Tile href="/manage?tab=suppliers" icon={<Truck />} label={t("tileSuppliers")} value={s?.suppliers ?? 0} loading={loading} />
        <Tile href="/manage?tab=staff" icon={<Users />} label={t("tileStaff")} value={s?.staff_active ?? 0} loading={loading} />
      </section>

      <NeedsAttentionCard summary={s} timezone={rest?.timezone} />

      <div className="grid items-start gap-5">
        <Card>
          <CardHeader title={t("attnTitle")} description={loading ? undefined : attention.length ? t("attnDesc") : undefined} />
          {loading ? <div className="space-y-2"><Skeleton className="h-14 rounded-xl" /><Skeleton className="h-14 rounded-xl" /></div>
            : attention.length === 0 ? (
              <>
              <p className="flex items-center gap-2 rounded-xl bg-success-soft px-4 py-3 text-sm font-medium text-success-fg"><CheckCircle2 aria-hidden className="size-5 shrink-0" />{t("allClear")}</p>
              {s.inventory_items === 0 && s.menu_items > 0 && <p className="mt-3 text-sm text-fg-muted">{t("recipesOptional")}</p>}
              </>
            ) : (
              <ul className="space-y-2">
                {attention.map((a) => (
                  <li key={a.key}>
                    <Link href={a.href} replace={a.href.startsWith("/manage")} scroll={false} className="flex items-center gap-3 rounded-xl bg-warning-soft/60 px-3 py-3 text-sm transition-colors hover:bg-warning-soft focus-visible:outline-2 focus-visible:outline-ring">
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-warning-soft text-warning-fg [&_svg]:size-[1.1rem]">{a.icon}</span>
                      <span className="min-w-0 flex-1 text-fg">{a.text}</span>
                      <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-warning-fg">{a.cta}<ArrowRight aria-hidden className="size-4" /></span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
        </Card>

      </div>
    </div>
  );
}
