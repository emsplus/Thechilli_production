"use client";

import { Button, Notice, Skeleton } from "@chilli/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Camera, Lock } from "lucide-react";
import { PillTabs } from "@/components/ui";
import { Card, EmptyState } from "@/components/ui";
import { api, ApiError, auth } from "@/lib/api";
import { useMsg } from "@/lib/i18n";
import type { ManageSummary, Me } from "@/lib/types";
import { ManageNav } from "@/components/shell/manage-nav";
import { MANAGE_ENTRIES, visibleManageEntries, type ManageEntry, type NavGate } from "@/components/shell/nav-model";
import { DeliveryTab } from "./DeliveryTab";
import { FeaturesTab } from "./FeaturesTab";
import { ManageProvider } from "./manage-context";
import { MANAGE_MSG } from "./shell-messages";
import { Overview } from "./Overview";
import { MenuTab } from "./MenuTab";
import { TablesTab } from "./TablesTab";
import { RecipesTab } from "./RecipesTab";
import { InventoryTab } from "./InventoryTab";
import { SuppliersTab } from "./SuppliersTab";
import { StaffTab } from "./StaffTab";
import { RestaurantTab } from "./RestaurantTab";
import { SystemTab } from "./SystemTab";
import { OutletsTab } from "./OutletsTab";
import { PrintersTab } from "./PrintersTab";
import { CustomersView } from "@/components/customers/CustomersView";
import { BillingView } from "@/components/billing/BillingView";
import { canOf, capabilitiesOf, featureOf, ME_CHANGED } from "@/lib/useRole";
import { DailyReportEmail } from "./DailyReportEmail";
import { DevicesTab } from "./DevicesTab";
import { ReviewsTab } from "./ReviewsTab";

type TabId = "overview" | "menu" | "tables" | "reviews" | "customers" | "recipes" | "inventory" | "suppliers" | "staff" | "restaurant" | "billing" | "features" | "printers" | "devices" | "delivery" | "system";
/** The tab ids; which of them (and which of the screens that have their own page) this user is offered is decided by components/shell/nav-model (MANAGE_ENTRIES). */
const IDS = new Set<string>(MANAGE_ENTRIES.filter((e) => e.kind === "tab").map((e) => e.id));
/** Old section names that still resolve (bookmarks, redirects from /purchases, /audit ...). */
const ALIAS: Record<string, { tab: TabId; view?: string }> = { purchases: { tab: "suppliers", view: "invoices" }, audit: { tab: "system", view: "audit" }, profile: { tab: "restaurant" }, outlets: { tab: "restaurant", view: "outlets" },
  modifiers: { tab: "menu", view: "modifiers" }, offers: { tab: "menu", view: "offers" }, attendance: { tab: "staff", view: "attendance" } };

export function ManageFallback() {
  const t = useMsg(MANAGE_MSG);
  return (
    <div role="status" aria-label={t("loading")} className="grid gap-4 lg:grid-cols-[14rem_1fr]">
      <Skeleton className="hidden h-96 rounded-2xl lg:block" />
      <div className="space-y-4"><Skeleton className="h-12 rounded-xl lg:hidden" /><Skeleton className="h-40 rounded-2xl" /><Skeleton className="h-64 rounded-2xl" /></div>
    </div>
  );
}

/** Friendly dead end for cashier / waiter / kitchen accounts (the API would refuse them anyway). */
function Blocked() {
  const t = useMsg(MANAGE_MSG);
  return (
    <Card className="mx-auto mt-6 max-w-lg">
      <EmptyState icon={<Lock />} title={t("blockedTitle")}
        hint={t("blockedHint")}
        action={<Link href="/pos" className="inline-flex h-11 items-center rounded-xl bg-primary bg-primary-gradient px-5 text-sm font-semibold text-primary-fg shadow-[var(--shadow-inset-hi),var(--shadow-glow)]">{t("backToPos")}</Link>} />
    </Card>
  );
}

export function ManagePanel() {
  const t = useMsg(MANAGE_MSG);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ManageSummary | null>(null);

  const raw = params.get("tab") ?? "overview";
  const alias = ALIAS[raw];
  // What this user may open, role + permission + plan + business type (one rule for the sidebar and this panel: components/shell/nav-model).
  const caps = useMemo(() => capabilitiesOf(me), [me]);
  const entries = useMemo(() => {
    if (!me) return [] as ManageEntry[];
    const gate: NavGate = { can: (p) => canOf(caps, p), feature: (c) => featureOf(caps, c), has: (k) => caps.biz[k] };
    return visibleManageEntries(me.role, gate);
  }, [me, caps]);
  const tabs = useMemo(() => entries.filter((e) => e.kind === "tab"), [entries]);
  // Sections hidden from the menu (Suppliers & Purchases) still open by link, e.g. the "Scan a bill" button: only what the user may not
  // open at all falls back to the overview.
  const openable = useMemo(() => {
    if (!me) return [] as ManageEntry[];
    const gate: NavGate = { can: (p) => canOf(caps, p), feature: (c) => featureOf(caps, c), has: (k) => caps.biz[k] };
    return visibleManageEntries(me.role, gate, { includeHidden: true }).filter((e) => e.kind === "tab");
  }, [me, caps]);
  const asked: TabId = alias ? alias.tab : IDS.has(raw) ? (raw as TabId) : "overview";
  // A section the business type does not have (Tables for a cloud kitchen) falls back to the overview.
  const tab: TabId = me && !openable.some((x) => x.id === asked) ? "overview" : asked;
  const view = params.get("view") ?? alias?.view ?? undefined;
  const invoice = params.get("invoice") ?? undefined;
  const from = params.get("from") ?? undefined;
  const action = params.get("action") ?? undefined;
  const highlight = useMemo(() => (params.get("highlight") ?? "").split(",").filter(Boolean), [params]);

  const loadMe = useCallback(async () => {
    try { setMe(await api.me()); setMeError(null); }
    catch (e) { setMeError(e instanceof ApiError ? e.message : ""); }
  }, []);
  useEffect(() => {
    if (!auth.token) { router.replace("/login"); return; }
    void Promise.resolve().then(loadMe);
  }, [loadMe, router]);
  // Manage > Features changed a switch: this panel keeps its own copy of /auth/me (it decides the tabs), so read it again.
  useEffect(() => { const f = () => void loadMe(); window.addEventListener(ME_CHANGED, f); return () => window.removeEventListener(ME_CHANGED, f); }, [loadMe]);

  const isAdmin = me?.role === "owner" || me?.role === "manager";
  const refresh = useCallback(() => { api.manageSummary().then(setSummary).catch(() => { /* the overview shows its own error */ }); }, []);
  useEffect(() => { if (isAdmin) void Promise.resolve().then(refresh); }, [isAdmin, refresh]);

  // A cashier / waiter reaches Reports, Cash drawer and Customers through Manage: /manage opens their first one (the tabs are for owner / manager).
  const firstPage = me && !isAdmin ? entries.find((e) => e.kind === "page")?.href : undefined;
  useEffect(() => { if (firstPage) router.replace(firstPage); }, [firstPage, router]);

  const goto = useCallback((t: string, v?: string, extra?: Record<string, string>) => {
    const more = Object.entries(extra ?? {}).map(([k, val]) => `&${k}=${encodeURIComponent(val)}`).join("");
    router.replace(`${pathname}?tab=${t}${v ? `&view=${v}` : ""}${more}`, { scroll: false });
  }, [router, pathname]);

  const ctx = useMemo(() => me ? { me, isOwner: me.role === "owner", summary, refresh, goto } : null, [me, summary, refresh, goto]);

  if (meError !== null && !me) return <Notice tone="danger" title={t("openFail")} action={<Button size="sm" variant="secondary" onClick={() => void loadMe()}>{t("retry")}</Button>}>{meError || t("loadMeFail")}</Notice>;
  if (!me || !ctx) return <ManageFallback />;
  if (!isAdmin) return firstPage ? <ManageFallback /> : <Blocked />;

  // Permission-gated sections (docs/PAYG_BILLING.md 7.2, docs/EMAIL.md): Billing needs billing.view; the daily report email reports.view.
  const may = (p: string) => canOf(caps, p);
  const visible = tabs;
  // English only (docs/DECISIONS.md): the new section has no translated catalog entry.
  const tabLabel = (id: string) => (id === "billing" ? "Billing" : id === "features" ? "Features" : id === "devices" ? "Devices" : t(`tab_${id}`));
  const current = visible.find((t) => t.id === tab) ?? visible[0];
  // Small attention counts on the panel, like the original: dishes without a recipe, low stock.
  const attention: Record<string, number> = summary ? { recipes: summary.inventory_items > 0 ? summary.items_without_recipe : 0, inventory: summary.low_stock } : {};
  // Only where supplier bills belong (Inventory, Suppliers & Purchases); phones only (desktop has the Scan an invoice card).
  const scan = (tab === "inventory" || (tab === "suppliers" && view !== "invoices")) && (
    // A supplier bill is the most common job here; one tap instead of Suppliers -> Purchase invoices.
    <span className="lg:hidden"><Button variant="secondary" iconStart={<Camera />} onClick={() => goto("suppliers", "invoices", tab === "inventory" ? { from: "inventory" } : undefined)}>{t("scanBill")}</Button></span>
  );
  const sub = (opts: { value: string; label: string }[], value: string) => (
    <div className="mb-4"><PillTabs label={`${tabLabel(current.id)} sections`} value={value} onChange={(v) => goto(tab, v === opts[0].value ? undefined : v)} options={opts} /></div>
  );

  return (
    <ManageProvider value={ctx}>
      <div className="grid items-start gap-4 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-6">
        <ManageNav entries={entries} activeId={current.id} attention={attention} onPick={(e) => goto(e.id)} />
        <div className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-fg">{tabLabel(current.id)}</h1>
            {scan}
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
              {current.id === "overview" && <Overview />}
              {tab === "menu" && <MenuTab view={view} />}
              {tab === "tables" && <TablesTab />}
              {tab === "reviews" && <ReviewsTab />}
              {tab === "customers" && <CustomersView embedded />}
              {tab === "recipes" && <RecipesTab goto={goto} onChanged={refresh} />}
              {tab === "inventory" && <InventoryTab onChanged={refresh} highlight={highlight} action={action} />}
              {tab === "suppliers" && <SuppliersTab view={view} invoice={invoice} from={from} />}
              {tab === "staff" && <StaffTab view={view} onView={(v) => goto("staff", v === "people" ? undefined : v)} />}
              {tab === "restaurant" && <>{sub([{ value: "business", label: "Business" }, { value: "outlets", label: "Outlets" }, ...(may("reports.view") ? [{ value: "daily-report", label: "Daily report email" }] : [])], view === "outlets" || (view === "daily-report" && may("reports.view")) ? view : "business")}
                {view === "outlets" ? <OutletsTab /> : view === "daily-report" && may("reports.view") ? <DailyReportEmail canEdit={may("settings.owner")} /> : <RestaurantTab />}</>}
              {current.id === "billing" && <BillingView canTopUp={may("billing.topup")} />}
              {tab === "features" && <FeaturesTab />}
              {tab === "printers" && <PrintersTab />}
              {tab === "devices" && <DevicesTab view={view} onView={(v) => goto("devices", v === "mine" ? undefined : v)} />}
              {tab === "delivery" && <DeliveryTab />}
              {tab === "system" && <SystemTab view={view} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </ManageProvider>
  );
}
